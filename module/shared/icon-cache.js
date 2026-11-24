// SPDX-License-Identifier: MPL-2.0
// 화면의 성공한 원본 PNG만 보관한다. 실제 RPC의 전송 간격 제한은 통신 큐가 담당한다.
export function createIconCache({ maxEntries = 128, maxBytes = 4 * 1024 * 1024, concurrency = 4, maxQueued = 64 } = {}) {
  for (const [name, value, minimum] of [['maxEntries', maxEntries, 0], ['maxBytes', maxBytes, 0], ['concurrency', concurrency, 1], ['maxQueued', maxQueued, 0]]) {
    if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(name);
  }
  const cache = new Map();
  const pending = new Map();
  let queue = [];
  let bytes = 0;
  let active = 0;
  let epoch = 0;
  let provider = null;
  let generation = null;
  let closed = false;
  const unavailable = () => ({ ok: false, error: { code: 'unavailable' } });
  const busy = () => ({ ok: false, error: { code: 'busy' } });
  const current = subscriber => { try { return Boolean(subscriber.isCurrent()); } catch { return false; } };
  const validJob = job => !closed && !job.cancelled && job.epoch === epoch;
  const settle = (job, response) => {
    for (const subscriber of job.subscribers) subscriber.resolve(validJob(job) && current(subscriber) ? response : unavailable());
    job.subscribers = [];
  };
  function cancel(job) {
    job.cancelled = true;
    settle(job, unavailable());
    if (pending.get(job.key) === job) pending.delete(job.key);
  }
  function pruneQueue() {
    queue = queue.filter(job => {
      if (!validJob(job) || !job.subscribers.some(current)) { cancel(job); return false; }
      return true;
    });
  }
  function normalize(response, expectedGeneration) {
    if (response?.ok !== true) {
      const code = typeof response?.error?.code === 'string' ? response.error.code : 'unavailable';
      const message = typeof response?.error?.message === 'string' ? response.error.message : undefined;
      return { ok: false, error: { code, ...(message === undefined ? {} : { message }) } };
    }
    const value = response.result;
    if (!value || value.generation !== expectedGeneration || value.mediaType !== 'image/png'
      || typeof value.base64 !== 'string' || value.base64.length === 0 || value.base64.length > 54616
      || !Number.isInteger(value.width) || value.width < 1 || value.width > 4096
      || !Number.isInteger(value.height) || value.height < 1 || value.height > 4096) {
      return { ok: false, error: { code: 'invalid-data' } };
    }
    // 호출자가 보관된 사본을 바꾸어 다음 화면에 영향을 주지 않게 고정한다.
    return Object.freeze({ ok: true, result: Object.freeze({ generation: value.generation,
      mediaType: value.mediaType, width: value.width, height: value.height, base64: value.base64 }) });
  }
  function remember(key, response) {
    const size = response.result.base64.length * 2;
    if (maxEntries === 0 || size > maxBytes) return;
    const previous = cache.get(key);
    if (previous) { bytes -= previous.bytes; cache.delete(key); }
    while (cache.size >= maxEntries || bytes + size > maxBytes) {
      const oldest = cache.keys().next().value;
      bytes -= cache.get(oldest).bytes;
      cache.delete(oldest);
    }
    cache.set(key, { response, bytes: size });
    bytes += size;
  }
  function pump() {
    pruneQueue();
    while (!closed && active < concurrency && queue.length > 0) {
      const job = queue.shift();
      active += 1;
      // 마이크로태스크까지 기다린 사이 첫 화면이 만료될 수 있어 시작 직전에 다시 고른다.
      Promise.resolve().then(() => {
        if (!validJob(job)) return unavailable();
        const leader = job.subscribers.find(current);
        return leader ? leader.load() : unavailable();
      }).then(response => {
        if (!validJob(job)) return;
        const normalized = normalize(response, job.generation);
        // 구독자의 await가 풀리기 전에 완료 작업을 분리해야 즉시 재시도가 합쳐져 멈추지 않는다.
        if (pending.get(job.key) === job) pending.delete(job.key);
        if (normalized.ok && job.subscribers.some(current)) remember(job.key, normalized);
        settle(job, normalized);
        if (!normalized.ok && ['data-changed', 'stale-generation'].includes(normalized.error.code)) clear();
      }).catch(() => {
        if (pending.get(job.key) === job) pending.delete(job.key);
        settle(job, unavailable());
      }).finally(() => {
        active -= 1;
        // clear 뒤 같은 key의 새 작업이 생겨도 옛 완료 처리가 지우지 않는다.
        if (pending.get(job.key) === job) pending.delete(job.key);
        pump();
      });
    }
  }
  function clear() {
    epoch += 1;
    cache.clear();
    bytes = 0;
    for (const job of pending.values()) cancel(job);
    pending.clear();
    queue = [];
  }
  return {
    setScope(providerModuleId, nextGeneration) {
      const valid = typeof providerModuleId === 'string' && providerModuleId.length > 0
        && typeof nextGeneration === 'string' && nextGeneration.length > 0;
      const nextProvider = valid ? providerModuleId : null;
      const next = valid ? nextGeneration : null;
      if (provider !== nextProvider || generation !== next) { clear(); provider = nextProvider; generation = next; }
    },
    get(iconRef, load, isCurrent = () => true) {
      const subscriber = { load, isCurrent };
      if (closed || provider === null || generation === null || typeof iconRef !== 'string' || iconRef.length === 0
        || typeof load !== 'function' || typeof isCurrent !== 'function' || !current(subscriber)) return Promise.resolve(unavailable());
      const key = JSON.stringify([provider, generation, iconRef]);
      const hit = cache.get(key);
      if (hit) {
        cache.delete(key);cache.set(key, hit);
        return Promise.resolve(hit.response);
      }
      const existing = pending.get(key);
      if (existing) return new Promise(resolve => existing.subscribers.push({ ...subscriber, resolve }));
      pruneQueue();
      if (active >= concurrency && queue.length >= maxQueued) return Promise.resolve(busy());
      return new Promise(resolve => {
        const job = { key, epoch, generation, cancelled: false, subscribers: [{ ...subscriber, resolve }] };
        pending.set(key, job);queue.push(job);pump();
      });
    },
    clear,
    close() { closed = true;clear(); },
    get stats() { return { entries: cache.size, bytes, active, queued: queue.length }; },
  };
}
