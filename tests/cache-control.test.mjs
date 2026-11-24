// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { removeCachedItem } from '../module/shared/cache-control.js';
import { TimerStore } from '../module/shared/timer-store.js';
import { KEY, createState, reduce } from '../module/shared/timer-model.js';
import { STORAGE_KEY } from '../module/shared/contracts.js';
const copy = structuredClone;
const error = code => Object.assign(new Error(code), { code });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function setup() {
  const cached = { registrationId: crypto.randomUUID(), providerModuleId: 'test.vault', id: 'item:1', name: '아이템', description: '', iconHandle: 'blob:1', addedAtUnixMillis: 1000 };
  const item = { providerModuleId: cached.providerModuleId, id: cached.id, name: cached.name, description: '', iconHandle: cached.iconHandle };
  const timer = { id: crypto.randomUUID(), version: 1, item, name: '타이머', kind: 'item', durationMs: 60000,
    status: 'idle', expiresAt: null, remainingMs: null, runId: null, alerts: { toast: true, sound: false, leadMinutes: [] } };
  const command = { type: 'add', timer, groupId: '00000000-0000-4000-8000-000000000001', cacheRegistrationId: cached.registrationId };
  const storage = {
    snapshot: { revision: 0, values: { [KEY]: createState(), [STORAGE_KEY]: { schemaVersion: 1, items: [cached] }, unrelated: '보존' } },
    listeners: new Set(), removed: [], batches: [], hook: null,
    async subscribe(callback) { this.listeners.add(callback); return () => this.listeners.delete(callback); },
    async getSnapshot() { return copy(this.snapshot); },
    async batch(input) {
      this.batches.push(copy(input)); if (this.hook) await this.hook(input);
      if (input.expectedRevision !== this.snapshot.revision) throw error('storage.conflict');
      for (const op of input.operations) this.snapshot.values[op.key] = copy(op.value);
      this.snapshot.revision++; for (const callback of this.listeners) callback(copy(this.snapshot)); return copy(this.snapshot);
    },
    async removeBlob(handle) { this.removed.push(handle); },
  };
  return { cached, command, storage };
}
async function open(storage) { const store = new TimerStore({ storage, now: () => 1000 }); assert.equal((await store.start()).ok, true); return store; }

test('참조 없는 캐시 삭제는 다른 키를 보존하고 확정 후 아이콘을 정리한다', async () => {
  const { cached, storage } = setup();
  assert.deepEqual(await removeCachedItem(storage, cached.registrationId), { ok: true });
  assert.deepEqual(storage.snapshot.values[STORAGE_KEY].items, []); assert.equal(storage.snapshot.values.unrelated, '보존');
  assert.deepEqual(storage.removed, ['blob:1']);
});
test('대기 타이머도 참조 중이면 캐시와 아이콘을 유지한다', async () => {
  const { cached, command, storage } = setup(); storage.snapshot.values[KEY] = reduce(createState(), command, 1000);
  assert.equal((await removeCachedItem(storage, cached.registrationId)).error.code, 'cache-in-use');
  assert.equal(storage.batches.length, 0); assert.deepEqual(storage.removed, []);
});
test('등록이 먼저 확정되면 삭제 재시도에서 참조를 발견한다', async () => {
  const { cached, command, storage } = setup(); const store = await open(storage); const entered = deferred(); const gate = deferred();
  storage.hook = async input => { if (input.operations[0].key === STORAGE_KEY) { entered.resolve(); await gate.promise; } };
  const removal = removeCachedItem(storage, cached.registrationId); await entered.promise;
  assert.equal((await store.dispatch(command)).ok, true); gate.resolve();
  assert.equal((await removal).error.code, 'cache-in-use'); assert.deepEqual(storage.removed, []); store.close();
});
test('삭제가 먼저 확정되면 등록 재시도에서 캐시 소실을 감지한다', async () => {
  const { cached, command, storage } = setup(); const store = await open(storage); const entered = deferred(); const gate = deferred();
  storage.hook = async input => { if (input.operations[0].key === KEY) { entered.resolve(); await gate.promise; } };
  const addition = store.dispatch(command); await entered.promise;
  assert.equal((await removeCachedItem(storage, cached.registrationId)).ok, true); gate.resolve();
  assert.equal((await addition).error.code, 'cache-missing'); assert.equal(store.state.timers.length, 0); store.close();
});
test('등록의 제공자·아이템·아이콘 불일치는 저장 전에 거절한다', async () => {
  for (const field of ['providerModuleId', 'id', 'iconHandle']) {
    const { command, storage } = setup(); const store = await open(storage); command.timer.item[field] = '다른 값';
    assert.equal((await store.dispatch(command)).error.code, 'cache-missing'); assert.equal(storage.batches.length, 0); store.close();
  }
});
test('아이콘 정리 실패는 삭제 성공과 경고를 함께 반환한다', async () => {
  const { cached, storage } = setup(); storage.removeBlob = async () => { throw error('unavailable'); };
  assert.deepEqual(await removeCachedItem(storage, cached.registrationId), { ok: true, warning: 'icon-cleanup-failed' });
  assert.equal(storage.snapshot.values[STORAGE_KEY].items.length, 0);
});
test('미래 스키마와 손상 데이터는 어느 키에서도 덮어쓰지 않는다', async () => {
  for (const key of [KEY, STORAGE_KEY]) for (const value of [{ schemaVersion: 99 }, null]) {
    const { cached, storage } = setup(); storage.snapshot.values[key] = value;
    assert.equal((await removeCachedItem(storage, cached.registrationId)).error.code, value ? 'unsupported-schema' : 'invalid-storage');
    assert.equal(storage.batches.length, 0); assert.deepEqual(storage.removed, []);
  }
});
test('읽기 실패와 저장 실패 및 3회 충돌은 아이콘을 지우지 않는다', async () => {
  const { cached, storage } = setup(); storage.getSnapshot = async () => { throw error('unavailable'); };
  assert.equal((await removeCachedItem(storage, cached.registrationId)).error.code, 'storage-read-failed'); assert.deepEqual(storage.removed, []);
  for (const code of ['storage.conflict', 'unavailable']) {
    const { cached, storage } = setup(); storage.hook = async () => { throw error(code); };
    assert.equal((await removeCachedItem(storage, cached.registrationId)).error.code, code === 'storage.conflict' ? 'storage-conflict' : 'storage-write-failed');
    assert.equal(storage.batches.length, code === 'storage.conflict' ? 3 : 1); assert.deepEqual(storage.removed, []);
  }
});
