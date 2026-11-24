// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { TimerStore } from '../module/shared/timer-store.js';
import { KEY, createState, reduce } from '../module/shared/timer-model.js';

const copy = value => structuredClone(value);
const err = code => Object.assign(new Error(code), { code });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
class Storage {
  constructor(state = createState()) {
    this.snapshot = { revision: 0, values: { [KEY]: copy(state), unrelated: { keep: true } } };
    this.listeners = new Set(); this.events = []; this.batchHook = null; this.readHook = null; this.subscribeHook = null; this.emit = true;
  }
  async subscribe(callback) {
    this.events.push('subscribe');
    if (this.subscribeHook) await this.subscribeHook(callback);
    this.listeners.add(callback); callback(copy(this.snapshot));
    return () => this.listeners.delete(callback);
  }
  async getSnapshot() { this.events.push('read'); return this.readHook ? this.readHook() : copy(this.snapshot); }
  publish(snapshot = this.snapshot) { for (const callback of this.listeners) callback(copy(snapshot)); }
  external(state) { this.snapshot = { revision: this.snapshot.revision + 1, values: { ...this.snapshot.values, [KEY]: copy(state) } }; this.publish(); }
  async batch(input) {
    this.events.push(copy(input));
    if (this.batchHook) await this.batchHook(input);
    if (input.expectedRevision !== this.snapshot.revision) throw err('storage.conflict');
    const values = { ...this.snapshot.values };
    for (const op of input.operations) values[op.key] = copy(op.value);
    this.snapshot = { revision: this.snapshot.revision + 1, values };
    if (this.emit) this.publish();
    return copy(this.snapshot);
  }
}
const writes = storage => storage.events.filter(event => typeof event === 'object');
async function open(storage = new Storage(), onChange = () => {}) {
  const store = new TimerStore({ storage, onChange, now: () => 1000 });
  assert.deepEqual(await store.start(), { ok: true }); return store;
}
const edit = size => ({ type: 'style', patch: { size } });

test('구독 우선 연결과 낮은 revision 및 같은 revision 중복 무시', async () => {
  const storage = new Storage(); const store = await open(storage);
  assert.deepEqual(storage.events.slice(0, 2), ['subscribe', 'read']);
  const old = copy(storage.snapshot); const next = createState(); next.style.size = 60;
  storage.external(next); storage.publish(old);
  storage.publish({ ...copy(storage.snapshot), values: { [KEY]: createState() } });
  assert.equal(store.state.style.size, 60); assert.ok(Object.isFrozen(store.state.style)); store.close();
});

test('성공 batch 반환값을 적용하고 다른 키와 이전 아이템 키를 보존한다', async () => {
  const storage = new Storage(); storage.snapshot.values['timer.items.v1'] = { items: ['기존 자료'] };
  const store = await open(storage); storage.emit = false;
  assert.deepEqual(await store.dispatch(edit(60)), { ok: true });
  assert.equal(store.state.style.size, 60);
  assert.deepEqual(storage.snapshot.values.unrelated, { keep: true });
  assert.deepEqual(storage.snapshot.values['timer.items.v1'], { items: ['기존 자료'] }); store.close();
});

test('명령 인자를 즉시 복사하고 한 저장소 명령을 직렬 실행한다', async () => {
  const storage = new Storage(); const store = await open(storage); const gate = deferred();
  storage.batchHook = () => gate.promise;
  const command = edit(60); const first = store.dispatch(command); command.patch.size = 80;
  const second = store.dispatch(edit(70));
  while (!writes(storage).length) await Promise.resolve();
  assert.equal(writes(storage).length, 1); gate.resolve();
  assert.equal((await first).ok, true); assert.equal((await second).ok, true);
  assert.equal(writes(storage)[0].operations[0].value.style.size, 60);
  assert.equal(store.state.style.size, 70); store.close();
});

test('읽기 실패와 손상 또는 미래 스키마는 마지막 상태를 보존하고 쓰기를 막는다', async () => {
  for (const value of [{ schemaVersion: 99 }, { schemaVersion: 1, groups: [] }]) {
    const storage = new Storage(); const store = await open(storage); const before = copy(store.state);
    storage.external(value);
    const code = value.schemaVersion === 99 ? 'unsupported-schema' : 'invalid-storage';
    assert.equal(store.error, code); assert.equal((await store.dispatch(edit(60))).error.code, code);
    assert.equal(writes(storage).length, 0); assert.deepEqual(store.state, before); store.close();
  }
  const storage = new Storage(); const store = await open(storage); const before = copy(store.state);
  storage.readHook = () => { throw err('unavailable'); };
  assert.equal((await store.dispatch(edit(60))).error.code, 'storage-read-failed');
  assert.equal(store.ready, false); assert.deepEqual(store.state, before); assert.equal(writes(storage).length, 0);
  storage.readHook = null; assert.deepEqual(await store.refresh(), { ok: true }); store.close();
});

test('저장 실패와 최대 세 번 CAS 실패를 성공으로 표시하지 않는다', async () => {
  for (const code of ['storage.conflict', 'storage.unavailable']) {
    const storage = new Storage(); const store = await open(storage); const before = copy(store.state);
    storage.batchHook = () => { throw err(code); };
    assert.equal((await store.dispatch(edit(60))).error.code, code === 'storage.conflict' ? 'storage-conflict' : 'storage-write-failed');
    assert.equal(writes(storage).length, code === 'storage.conflict' ? 3 : 1);
    assert.deepEqual(store.state, before); store.close();
  }
});

test('구독 실패 뒤 늦은 콜백을 무시하고 다시 연결한다', async () => {
  const storage = new Storage(); let stale;
  storage.subscribeHook = callback => { stale = callback; throw err('unavailable'); };
  const store = new TimerStore({ storage });
  assert.equal((await store.start()).error.code, 'storage-subscribe-failed');
  assert.equal((await store.dispatch(edit(60))).error.code, 'not-ready');
  storage.subscribeHook = null; assert.deepEqual(await store.refresh(), { ok: true });
  stale({ revision: 99, values: { [KEY]: { schemaVersion: 99 } } });
  assert.equal(store.ready, true); store.close();
});

test('닫는 중 늦은 구독과 저장 응답이 상태나 콜백을 바꾸지 않는다', async () => {
  const storage = new Storage(); const subscribeGate = deferred(); let changes = 0;
  storage.subscribeHook = () => subscribeGate.promise;
  const store = new TimerStore({ storage, onChange: () => changes++ });
  const starting = store.start(); store.close(); subscribeGate.resolve();
  assert.equal((await starting).error.code, 'closed'); assert.equal(changes, 0); assert.equal(storage.listeners.size, 0);
  storage.subscribeHook = null;
  const active = await open(storage, () => changes++); const gate = deferred(); storage.batchHook = () => gate.promise;
  const pending = active.dispatch(edit(60)); while (!writes(storage).length) await Promise.resolve();
  const before = copy(active.state); active.close(); const count = changes; gate.resolve();
  assert.deepEqual(await pending, { ok: true }); assert.equal(changes, count); assert.deepEqual(active.state, before);
  assert.equal(storage.snapshot.values[KEY].style.size, 60);
});

function timer(id = crypto.randomUUID()) {
  return { id, version: 1, item: { providerModuleId: 'test.vault', id: 'item:1', name: '아이템', description: '', iconHandle: null },
    name: '타이머', kind: 'item', durationMs: 60000, status: 'idle', expiresAt: null, remainingMs: null, runId: null,
    alerts: { toast: true, sound: false, leadMinutes: [] } };
}
function seeded() {
  const one = timer(); const two = timer();
  let state = reduce(createState(), { type: 'add', timer: one, groupId: '00000000-0000-4000-8000-000000000001' }, 1000);
  state = reduce(state, { type: 'add', timer: two, groupId: '00000000-0000-4000-8000-000000000001' }, 1000);
  return { state, one, two };
}

test('두 화면의 서로 다른 타이머 동시 변경은 CAS 재시도로 합친다', async () => {
  const { state, one, two } = seeded(); const storage = new Storage(state);
  const left = await open(storage); const right = await open(storage);
  const gate = deferred(); let entered = 0;
  storage.batchHook = async () => { if (++entered === 2) gate.resolve(); await gate.promise; };
  const results = await Promise.all([
    left.dispatch({ type: 'start', id: one.id, expectedVersion: 1 }),
    right.dispatch({ type: 'start', id: two.id, expectedVersion: 1 }),
  ]);
  assert.ok(results.every(result => result.ok));
  assert.ok(left.state.timers.every(timer => timer.status === 'running' && timer.version === 2));
  assert.deepEqual(left.state, right.state); assert.equal(writes(storage).length, 3); left.close(); right.close();
});

test('같은 타이머 동시 변경은 최신 상태를 표시하고 timer-conflict를 반환한다', async () => {
  const { state, one } = seeded(); const storage = new Storage(state);
  const left = await open(storage); const right = await open(storage);
  const gate = deferred(); let entered = 0;
  storage.batchHook = async () => { if (++entered === 2) gate.resolve(); await gate.promise; };
  const command = { type: 'start', id: one.id, expectedVersion: 1 };
  const results = await Promise.all([left.dispatch(command), right.dispatch(command)]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.find(result => !result.ok).error.code, 'timer-conflict');
  assert.deepEqual(left.state, right.state); assert.equal(right.state.timers[0].version, 2);
  left.close(); right.close();
});

test('첫 읽기보다 먼저 도착한 구독 최신 snapshot을 유지한다', async () => {
  const storage = new Storage(); const stale = copy(storage.snapshot);
  storage.readHook = () => { const state = createState(); state.style.size = 60; storage.external(state); return stale; };
  const store = await open(storage); assert.equal(store.state.style.size, 60); store.close();
});

test('드래그 저장의 최신 조회와 CAS 재시도에서 다른 항목 이동을 충돌로 처리한다',async()=>{
 for(const stage of ['read','cas']){
  const {state,one,two}=seeded(), storage=new Storage(state), store=await open(storage);
  const group=state.groups[0],command={type:'move',id:one.id,expectedVersion:1,targetId:group.id,index:1,expectedOrder:[...group.timerIds]};
  const latest=reduce(state,{type:'move',id:two.id,expectedVersion:1,targetId:group.id,index:0},1000);
  if(stage==='read')storage.readHook=()=>({revision:1,values:{[KEY]:latest}});
  else storage.batchHook=()=>{storage.batchHook=null;storage.external(latest);throw err('storage.conflict');};
  assert.equal((await store.dispatch(command)).error.code,'timer-conflict');
  assert.deepEqual(store.state.groups[0].timerIds,latest.groups[0].timerIds);store.close();
 }
});
