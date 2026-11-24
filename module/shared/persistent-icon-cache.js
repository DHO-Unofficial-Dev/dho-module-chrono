// SPDX-License-Identifier: MPL-2.0
// 등록 사본과 별개의 폐기 가능한 캐시다. KV revision·타이머 구독에는 쓰지 않는다.
const PREFIX = 'chrono-icon-cache-v1-';
const MEDIA_TYPE = 'application/json';
const MAX_RECORD_BYTES = 60 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const valid = (response, generation) => response?.ok === true && response.result?.generation === generation
  && response.result.mediaType === 'image/png' && typeof response.result.base64 === 'string'
  && response.result.base64.length > 0 && response.result.base64.length <= 54616
  && Number.isInteger(response.result.width) && response.result.width > 0 && response.result.width <= 4096
  && Number.isInteger(response.result.height) && response.result.height > 0 && response.result.height <= 4096;
const unavailable = () => ({ ok: false, error: { code: 'unavailable' } });

export function createPersistentIconCache({ storage, maxEntries = 128, maxBytes = 4 * 1024 * 1024, now = () => Date.now(), wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (const [name, value] of [['maxEntries', maxEntries], ['maxBytes', maxBytes]]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(name);
  }
  const supported = maxEntries > 0 && maxBytes > 0 && ['listBlobs', 'getBlob', 'putBlob', 'removeBlob'].every(key => typeof storage?.[key] === 'function');
  let tail = Promise.resolve(), lastWrite = null;
  // 공유 인스턴스의 검색·추천 저장은 직렬화하되 원격 아이콘 요청은 직렬화하지 않는다.
  const serial = action => { const task = tail.then(action); tail = task.catch(() => {}); return task; };
  async function write(action, isCurrent = () => true) {
    const delay = lastWrite === null ? 0 : Math.max(0, 120 - (now() - lastWrite));
    if (delay) await wait(delay);
    if (!isCurrent()) return;
    lastWrite = now();
    return action();
  }
  async function list() {
    const items = [], seen = new Set();
    let cursor;
    do {
      const page = await storage.listBlobs({ limit: 256, ...(cursor ? { cursor } : {}) });
      for (const info of page.items) {
        if (typeof info.name === 'string' && new RegExp(`^${PREFIX}[a-f0-9]{64}$`).test(info.name)) items.push(info);
      }
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('invalid cursor');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return items;
  }
  async function trim(items, incomingBytes = 0, incomingCount = 0) {
    let bytes = items.reduce((sum, info) => sum + info.byteLength, 0);
    items.sort((a, b) => a.createdAtUnixMillis - b.createdAtUnixMillis);
    while (items.length && (items.length + incomingCount > maxEntries || bytes + incomingBytes > maxBytes)) {
      const oldest = items.shift();
      await write(() => storage.removeBlob(oldest.handle));
      bytes -= oldest.byteLength;
    }
  }
  return {
    async load(provider, generation, iconRef, load, isCurrent = () => true) {
      if (!isCurrent()) return unavailable();
      let name, key;
      if (supported) {
        try {
          key = JSON.stringify([provider, generation, iconRef]);
          const digest = await crypto.subtle.digest('SHA-256', encoder.encode(key));
          name = PREFIX + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
          const cached = await serial(async () => {
            const items = await list();
            await trim(items);
            const info = items.find(info => info.name === name);
            if (!info) return null;
            try {
              if (info.mediaType !== MEDIA_TYPE || info.byteLength > MAX_RECORD_BYTES) throw new Error('invalid cache');
              const blob = await storage.getBlob(info.handle);
              if (blob.bytes.byteLength > MAX_RECORD_BYTES) throw new Error('invalid cache');
              const record = JSON.parse(decoder.decode(blob.bytes));
              if (record.key !== key || !valid(record.response, generation)) throw new Error('invalid cache');
              return record.response;
            } catch {
              await write(() => storage.removeBlob(info.handle));
              return null;
            }
          });
          if (!isCurrent()) return unavailable();
          if (cached) return cached;
        } catch { /* 캐시 저장소가 실패해도 Vault 읽기를 계속한다. */ }
      }
      if (!isCurrent()) return unavailable();
      const response = await load();
      if (name && valid(response, generation) && isCurrent()) {
        try {
          const bytes = encoder.encode(JSON.stringify({ key, response }));
          if (bytes.byteLength <= Math.min(maxBytes, MAX_RECORD_BYTES)) await serial(async () => {
            if (!isCurrent()) return;
            const items = await list();
            if (items.some(info => info.name === name)) return;
            await trim(items, bytes.byteLength, 1);
            if (!isCurrent()) return;
            // 짧은 추천 목록도 Host 쓰기 한도에 몰리지 않도록 성공·실패 시도 간격을 둔다.
            await write(() => storage.putBlob(bytes, { kind: 'bytes', mediaType: MEDIA_TYPE, name }), isCurrent);
          });
        } catch { /* 임시 캐시 실패는 정상 아이콘 응답을 바꾸지 않는다. */ }
      }
      return response;
    },
  };
}
