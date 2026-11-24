// SPDX-License-Identifier: MPL-2.0
import { STORAGE_KEY, MAX_ITEMS, itemKey, validateMetadata, validateDocument,
  validRegistrationId, validIconHandle, decodeIcon } from './contracts.js';

const failure = (code, warning) => ({ ok: false, error: { code }, ...(warning ? { warning } : {}) });
const emptyDocument = () => ({ schemaVersion: 1, items: [] });

export class ItemStore {
  constructor({ storage, onChange = () => {} }) {
    this.storage = storage;
    this.onChange = onChange;
    this.items = Object.freeze([]);
    this.ready = false;
    this.error = null;
    this._revision = -1;
    this._valid = false;
    this._subscribed = false;
    this._unsubscribe = null;
    this._starting = null;
    this._closed = false;
    this._queue = Promise.resolve();
  }
  _notify() {
    if (!this._closed) { try { this.onChange(); } catch { /* 렌더 실패가 저장 트랜잭션을 깨지 않게 한다. */ } }
  }
  _fail(code, block = false) {
    if (!this._closed) {
      this.error = code;
      if (block) this.ready = false;
      this._notify();
    }
    return failure(code);
  }
  _receive(snapshot) {
    if (this._closed) return;
    if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
      this._valid = false;
      this._fail('invalid-storage', true);
      return;
    }
    if (snapshot.revision < this._revision) return;
    if (snapshot.revision === this._revision) {
      // 읽기 실패 뒤 같은 확정 revision을 다시 읽으면 보관한 사본으로 복구한다.
      // 동일 revision의 다른 payload로 사본을 바꾸지는 않는다.
      if (this._valid) { this.ready = this._subscribed; this.error = null; this._notify(); }
      return;
    }
    this._revision = snapshot.revision;
    if (!snapshot.values || typeof snapshot.values !== 'object' || Array.isArray(snapshot.values)) {
      this._valid = false;
      this._fail('invalid-storage', true);
      return;
    }
    try {
      const document = Object.hasOwn(snapshot.values, STORAGE_KEY) ? snapshot.values[STORAGE_KEY] : emptyDocument();
      this.items = validateDocument(document);
      this._valid = true;
      this.ready = this._subscribed;
      this.error = null;
      this._notify();
    } catch (error) {
      this._valid = false;
      this._fail(error.code === 'unsupported-schema' ? error.code : 'invalid-storage', true);
    }
  }
  async _read() {
    if (this._closed) return failure('closed');
    try {
      const snapshot = await this.storage.getSnapshot();
      if (this._closed) return failure('closed');
      this._receive(snapshot);
      return this.ready ? { ok: true } : failure(this.error ?? 'not-ready');
    } catch {
      return this._fail('storage-read-failed', true);
    }
  }
  start() {
    if (this._closed) return Promise.resolve(failure('closed'));
    if (this._starting) return this._starting;
    if (this._subscribed) return this._read();
    this._starting = this._connect().finally(() => { this._starting = null; });
    return this._starting;
  }
  async _connect() {
    try {
      const unsubscribe = await this.storage.subscribe(snapshot => this._receive(snapshot));
      if (this._closed) { try { unsubscribe(); } catch {} return failure('closed'); }
      if (typeof unsubscribe !== 'function') throw new Error('invalid subscription');
      this._unsubscribe = unsubscribe;
      this._subscribed = true;
      this.ready = this._valid;
      return this._read();
    } catch {
      this._subscribed = false;
      return this._fail('storage-subscribe-failed', true);
    }
  }
  refresh() { return this._subscribed ? this._read() : this.start(); }
  _serialize(operation) {
    const pending = this._queue.then(() => this._closed ? failure('closed') : operation());
    this._queue = pending.catch(() => {});
    return pending;
  }
  async _cleanup(handle) {
    if (handle === null) return null;
    try { await this.storage.removeBlob(handle); return null; } catch { return 'icon-cleanup-failed'; }
  }
  add(metadata, icon = null) {
    let validated;
    try { validated = validateMetadata(metadata); } catch { return Promise.resolve(this._fail('invalid-item')); }
    // 호출 뒤 UI가 바꾼 객체가 대기 중 등록값을 바꾸지 않게 사본을 만든다.
    const capturedIcon = icon && typeof icon === 'object' ? { ...icon } : icon;
    return this._serialize(() => this._add(validated, capturedIcon));
  }
  async _add(metadata, icon) {
    if (!this._subscribed) return this._fail('not-ready');
    let ownHandle = null;
    let warning = null;
    let iconAttempted = false;
    let registrationId;
    try { registrationId = crypto.randomUUID(); } catch { return this._fail('storage-write-failed'); }
    const addedAtUnixMillis = Date.now();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const read = await this._read();
      if (!read.ok) {
        const cleanup = await this._cleanup(ownHandle);
        return failure(read.error.code, cleanup ?? warning);
      }
      if (this.items.some(item => itemKey(item) === itemKey(metadata))) {
        const cleanup = await this._cleanup(ownHandle);
        return { ok: true, duplicate: true, ...((cleanup ?? warning) ? { warning: cleanup ?? warning } : {}) };
      }
      if (this.items.length >= MAX_ITEMS) {
        const cleanup = await this._cleanup(ownHandle);
        this._fail('item-limit');
        return failure('item-limit', cleanup ?? warning);
      }
      if (!iconAttempted && icon !== null) {
        iconAttempted = true;
        try {
          const data = decodeIcon(icon);
          if (typeof this.storage.putBlob !== 'function' || typeof this.storage.removeBlob !== 'function') throw new Error('blob unsupported');
          const info = await this.storage.putBlob(data, { kind: 'image', name: '아이템 아이콘' });
          if (!validIconHandle(info?.handle)) throw new Error('invalid handle');
          ownHandle = info.handle;
          if (info.mediaType !== 'image/png' || info.image?.width !== icon.width || info.image?.height !== icon.height) {
            warning = await this._cleanup(ownHandle) ?? 'icon-unavailable';
            ownHandle = null;
          }
        } catch { warning = 'icon-unavailable'; }
      }
      if (this._closed) return failure('closed', await this._cleanup(ownHandle) ?? warning);
      // blob 대기 중 수신된 최신 전체 snapshot도 검증 상태일 때만 사용한다.
      if (!this.ready) return failure(this.error ?? 'not-ready', await this._cleanup(ownHandle) ?? warning);
      if (this.items.some(item => itemKey(item) === itemKey(metadata))) {
        const cleanup = await this._cleanup(ownHandle);
        return { ok: true, duplicate: true, ...((cleanup ?? warning) ? { warning: cleanup ?? warning } : {}) };
      }
      if (this.items.length >= MAX_ITEMS) {
        const cleanup = await this._cleanup(ownHandle);
        this._fail('item-limit');
        return failure('item-limit', cleanup ?? warning);
      }
      const value = { schemaVersion: 1, items: [...this.items, { registrationId, ...metadata, iconHandle: ownHandle, addedAtUnixMillis }] };
      try {
        await this.storage.batch({ expectedRevision: this._revision, operations: [{ kind: 'set', key: STORAGE_KEY, value }] });
        // 성공 snapshot은 SDK의 subscribe가 Promise 완료 전에 전달한다.
        return { ok: true, ...(warning ? { warning } : {}) };
      } catch (error) {
        if (error?.code === 'storage.conflict' && attempt < 2) continue;
        const code = error?.code === 'storage.conflict' ? 'storage-conflict' : 'storage-write-failed';
        const cleanup = await this._cleanup(ownHandle);
        this._fail(code);
        return failure(code, cleanup ?? warning);
      }
    }
    return failure('storage-conflict');
  }
  remove(registrationId) {
    if (!validRegistrationId(registrationId)) return Promise.resolve(this._fail('invalid-registration'));
    return this._serialize(() => this._remove(registrationId));
  }
  async _remove(registrationId) {
    if (!this._subscribed) return this._fail('not-ready');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const read = await this._read();
      if (!read.ok) return read;
      const selected = this.items.find(item => item.registrationId === registrationId);
      if (!selected) return { ok: true };
      const value = { schemaVersion: 1, items: this.items.filter(item => item.registrationId !== registrationId) };
      try {
        await this.storage.batch({ expectedRevision: this._revision, operations: [{ kind: 'set', key: STORAGE_KEY, value }] });
      } catch (error) {
        if (error?.code === 'storage.conflict' && attempt < 2) continue;
        return this._fail(error?.code === 'storage.conflict' ? 'storage-conflict' : 'storage-write-failed');
      }
      const warning = await this._cleanup(selected.iconHandle);
      return { ok: true, ...(warning ? { warning } : {}) };
    }
    return failure('storage-conflict');
  }
  close() {
    this._closed = true;
    this.ready = false;
    try { this._unsubscribe?.(); } catch {}
    this._unsubscribe = null;
    this._subscribed = false;
  }
}
