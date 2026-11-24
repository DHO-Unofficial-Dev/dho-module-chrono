// SPDX-License-Identifier: MPL-2.0
import { KEY, createState, validateState, reduce } from './timer-model.js';
import { STORAGE_KEY, validateDocument } from './contracts.js';

const failure = code => ({ ok: false, error: { code } });
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export class TimerStore {
  constructor({ storage, onChange = () => {}, now = Date.now }) {
    this.storage = storage;
    this.onChange = onChange;
    this.now = now;
    this.state = freeze(createState());
    this.ready = false;
    this.error = null;
    this._revision = -1;
    this._values = null;
    this._valid = false;
    this._subscribed = false;
    this._unsubscribe = null;
    this._starting = null;
    this._closed = false;
    this._generation = 0;
    this._queue = Promise.resolve();
  }
  _notify() {
    if (!this._closed) { try { this.onChange(); } catch { /* 화면 오류는 저장 결과에 영향을 주지 않는다. */ } }
  }
  _fail(code, block = false) {
    if (this._closed) return failure('closed');
    this.error = code;
    if (block) this.ready = false;
    this._notify();
    return failure(code);
  }
  _receive(snapshot) {
    if (this._closed) return;
    if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
      this._fail('invalid-storage', true);
      return;
    }
    if (snapshot.revision < this._revision) return;
    if (snapshot.revision === this._revision) {
      // 같은 revision의 중복 이벤트는 검증된 사본만 재사용한다.
      if (this._valid) { this.ready = this._subscribed; this.error = null; this._notify(); }
      return;
    }
    this._revision = snapshot.revision;
    this._valid = false;
    try {
      if (!snapshot.values || typeof snapshot.values !== 'object' || Array.isArray(snapshot.values)) throw new Error();
      const value = Object.hasOwn(snapshot.values, KEY) ? snapshot.values[KEY] : createState();
      const state = freeze(validateState(value));
      this._values = structuredClone(snapshot.values);
      this.state = state;
      this._valid = true;
      this.ready = this._subscribed;
      this.error = null;
      this._notify();
    } catch (error) {
      this._fail(error?.code === 'unsupported-schema' ? error.code : 'invalid-storage', true);
    }
  }
  async _read() {
    if (this._closed) return failure('closed');
    try {
      const snapshot = await this.storage.getSnapshot();
      if (this._closed) return failure('closed');
      this._receive(snapshot);
      return this.ready ? { ok: true } : failure(this.error ?? 'not-ready');
    } catch { return this._fail('storage-read-failed', true); }
  }
  start() {
    if (this._closed) return Promise.resolve(failure('closed'));
    if (this._starting) return this._starting;
    if (this._subscribed) return this._read();
    this._starting = this._connect().finally(() => { this._starting = null; });
    return this._starting;
  }
  async _connect() {
    const generation = ++this._generation;
    try {
      const unsubscribe = await this.storage.subscribe(snapshot => {
        if (this._generation === generation) this._receive(snapshot);
      });
      if (this._closed) { if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch {} } return failure('closed'); }
      if (typeof unsubscribe !== 'function') throw new Error('invalid subscription');
      this._unsubscribe = unsubscribe;
      this._subscribed = true;
      return this._read();
    } catch {
      this._generation += 1;
      this._subscribed = false;
      return this._fail('storage-subscribe-failed', true);
    }
  }
  refresh() { return this._subscribed ? this._read() : this.start(); }
  dispatch(command) {
    if (this._closed) return Promise.resolve(failure('closed'));
    let captured;
    try { captured = structuredClone(command); }
    catch { return Promise.resolve(this._fail('invalid-command')); }
    const pending = this._queue.then(() => this._dispatch(captured));
    this._queue = pending.catch(() => {});
    return pending;
  }
  async _dispatch(command) {
    if (this._closed) return failure('closed');
    if (!this._subscribed) return this._fail('not-ready');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const read = await this._read();
      if (!read.ok) return read;
      let value;
      try {
        if (command?.type === 'add' && Object.hasOwn(command, 'cacheRegistrationId')) {
          const items = validateDocument(Object.hasOwn(this._values, STORAGE_KEY) ? this._values[STORAGE_KEY] : { schemaVersion: 1, items: [] });
          const cached = items.find(item => item.registrationId === command.cacheRegistrationId);
          const item = command.timer?.item;
          if (!cached || !item || cached.providerModuleId !== item.providerModuleId
            || cached.id !== item.id || cached.iconHandle !== item.iconHandle) return this._fail('cache-missing');
        }
        value = reduce(this.state, command, this.now());
      }
      catch (error) { return this._fail(error?.code ?? 'invalid-command'); }
      try {
        const snapshot = await this.storage.batch({
          expectedRevision: this._revision,
          operations: [{ kind: 'set', key: KEY, value }],
        });
        // 구독 이벤트 유무와 무관하게 SDK가 반환한 확정 snapshot을 반영한다.
        // 닫힌 뒤 완료된 쓰기도 저장 성공 자체는 유지한다.
        this._receive(snapshot);
        return { ok: true };
      } catch (error) {
        if (this._closed) return failure('closed');
        if (error?.code === 'storage.conflict' && attempt < 2) continue;
        return this._fail(error?.code === 'storage.conflict' ? 'storage-conflict' : 'storage-write-failed');
      }
    }
    return failure('storage-conflict');
  }
  close() {
    this._closed = true;
    this.ready = false;
    this._generation += 1;
    try { this._unsubscribe?.(); } catch {}
    this._unsubscribe = null;
    this._subscribed = false;
  }
}
