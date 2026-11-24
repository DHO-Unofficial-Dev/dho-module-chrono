// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ItemStore } from '../module/shared/item-store.js';
import { STORAGE_KEY, MAX_ITEMS, validateMetadata, validateDocument, decodeIcon } from '../module/shared/contracts.js';

const copy = value => structuredClone(value);
const err = code => Object.assign(new Error(code), { code });
const metadata = (id = 'item:1') => ({ providerModuleId: 'org.dho.vault-library', id, name: '회복 음식', description: '선택 시점 설명' });
const stored = (id = 'item:1', handle = null) => ({ registrationId: crypto.randomUUID(), ...metadata(id), iconHandle: handle, addedAtUnixMillis: 123 });
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function icon() {
  // 파일 디코드는 Host 책임이다. 여기서는 사전검사의 PNG signature/IHDR만 만드는 합성 자료를 쓴다.
  const bytes = new Uint8Array(24);bytes.set([137,80,78,71,13,10,26,10]);const view = new DataView(bytes.buffer);
  view.setUint32(8,13);bytes.set([73,72,68,82],12);view.setUint32(16,1);view.setUint32(20,1);
  return { base64: btoa(String.fromCharCode(...bytes)), mediaType: 'image/png', width: 1, height: 1 };
}
class MockStorage {
  constructor(items = []) {
    this.snapshot = { revision: 0, values: { [STORAGE_KEY]: { schemaVersion: 1, items: copy(items) } } };
    this.listeners = new Set();this.events = [];this.blobs = new Map();this.nextBlob = 0;
    this.batchHook = null;this.readHook = null;this.putHook = null;this.removeHook = null;this.subscribeHook = null;
  }
  async subscribe(listener) {
    this.events.push('subscribe');
    if (this.subscribeHook) await this.subscribeHook(listener);
    this.listeners.add(listener);listener(copy(this.snapshot));
    return () => this.listeners.delete(listener);
  }
  async getSnapshot() { this.events.push('read'); return this.readHook ? this.readHook() : copy(this.snapshot); }
  publish(value) { for (const listener of this.listeners) listener(copy(value)); }
  external(items) { this.snapshot = { revision: this.snapshot.revision + 1, values: { [STORAGE_KEY]: { schemaVersion: 1, items: copy(items) } } };this.publish(this.snapshot); }
  async batch(input) {
    this.events.push(['batch', copy(input)]);
    if (this.batchHook) await this.batchHook(input);
    if (input.expectedRevision !== this.snapshot.revision) throw err('storage.conflict');
    this.snapshot = { revision: this.snapshot.revision + 1, values: { ...this.snapshot.values, [STORAGE_KEY]: copy(input.operations[0].value) } };
    this.publish(this.snapshot);return copy(this.snapshot);
  }
  async putBlob(bytes, options) {
    this.events.push(['put',bytes.length,options]);if (this.putHook) await this.putHook();
    const handle = `blob:${++this.nextBlob}`;this.blobs.set(handle,bytes);
    return { handle, mediaType: 'image/png', image: { width: 1, height: 1 } };
  }
  async removeBlob(handle) {
    this.events.push(['remove',handle]);if (this.removeHook) await this.removeHook(handle);
    return { removed: this.blobs.delete(handle) };
  }
}
async function open(storage = new MockStorage(), onChange = () => {}) { const store = new ItemStore({ storage, onChange });assert.deepEqual(await store.start(),{ ok: true });return store; }
const batches = storage => storage.events.filter(e => Array.isArray(e) && e[0] === 'batch');
const removals = storage => storage.events.filter(e => Array.isArray(e) && e[0] === 'remove').map(e => e[1]);

test('구독을 먼저 등록하고 저장 목록을 복원하며 낮은 revision을 무시한다', async () => {
  const first = stored();const storage = new MockStorage([first]);const store = await open(storage);
  assert.deepEqual(storage.events.slice(0,2),['subscribe','read']);assert.equal(store.items[0].registrationId,first.registrationId);
  const second = stored('item:2');storage.external([first,second]);
  storage.publish({ revision: 0, values: { [STORAGE_KEY]: { schemaVersion: 1, items: [] } } });assert.equal(store.items.length,2);
  store.close();const reopened = await open(storage);assert.equal(reopened.items.length,2);reopened.close();
});
test('초기 snapshot보다 먼저 온 최신 구독 결과를 유지한다', async () => {
  const storage = new MockStorage();const old = copy(storage.snapshot);
  storage.readHook = async () => { storage.external([stored()]);return old; };
  const store = await open(storage);assert.equal(store.items.length,1);store.close();
});
test('같은 제공자와 item만 중복이며 다른 제공자는 별도 저장한다', async () => {
  const storage = new MockStorage();const store = await open(storage);
  assert.deepEqual(await store.add(metadata(),icon()),{ ok: true });
  const first = store.items[0];assert.ok(first.registrationId);assert.equal(first.iconHandle,'blob:1');
  assert.deepEqual(await store.add(metadata(),icon()),{ ok: true, duplicate: true });assert.equal(storage.nextBlob,1);
  assert.deepEqual(await store.add({ ...metadata(), providerModuleId: 'org.example.other' }),{ ok: true });assert.equal(store.items.length,2);store.close();
});
test('한 화면의 병렬 추가를 직렬화하고 metadata 인자를 사본으로 보관한다', async () => {
  const storage = new MockStorage();const store = await open(storage);const gate = deferred();storage.putHook = () => gate.promise;
  const input = metadata();const first = store.add(input,icon());input.name = '변경';const second = store.add(metadata('item:2'));
  await Promise.resolve();await Promise.resolve();assert.equal(batches(storage).length,0);gate.resolve();
  assert.equal((await first).ok,true);assert.equal((await second).ok,true);assert.equal(store.items.length,2);assert.equal(store.items[0].name,'회복 음식');store.close();
});
test('충돌 때 최신 자료를 합치고 새 blob은 한 번만 만든다', async () => {
  const storage = new MockStorage();const store = await open(storage);let called = 0;
  storage.batchHook = async () => { if (called++ === 0) storage.external([stored('item:2','other-blob')]); };
  assert.equal((await store.add(metadata(),icon())).ok,true);assert.equal(batches(storage).length,2);assert.equal(store.items.length,2);assert.equal(storage.nextBlob,1);assert.deepEqual(removals(storage),[]);store.close();
});
test('다른 화면이 같은 item을 먼저 저장하면 자신의 새 blob만 정리한다', async () => {
  const storage = new MockStorage();const store = await open(storage);storage.batchHook = async () => storage.external([stored('item:1','other-blob')]);
  assert.deepEqual(await store.add(metadata(),icon()),{ ok: true, duplicate: true });assert.deepEqual(removals(storage),['blob:1']);assert.equal(store.items[0].iconHandle,'other-blob');store.close();
});
test('metadata 저장 실패와 3회 충돌은 성공으로 표시하지 않고 새 blob만 정리한다', async () => {
  for (const code of ['storage.unavailable','storage.conflict']) {
    const storage = new MockStorage([stored('item:9','existing')]);const store = await open(storage);storage.batchHook = async () => { throw err(code); };
    const result = await store.add(metadata(),icon());assert.equal(result.ok,false);assert.equal(result.error.code,code === 'storage.conflict' ? 'storage-conflict' : 'storage-write-failed');
    assert.equal(batches(storage).length,code === 'storage.conflict' ? 3 : 1);assert.equal(store.items.length,1);assert.deepEqual(removals(storage),['blob:1']);store.close();
  }
});
test('blob 보관 실패나 잘못된 PNG에도 이름과 설명을 저장한다', async () => {
  for (const invalid of [false,true]) {
    const storage = new MockStorage();const store = await open(storage);if (!invalid) storage.putHook = async () => { throw err('storage.blobQuotaExceeded'); };
    const result = await store.add(metadata(),invalid ? { ...icon(),base64:'broken' } : icon());
    assert.deepEqual(result,{ ok:true,warning:'icon-unavailable' });assert.equal(store.items[0].iconHandle,null);assert.equal(store.items[0].description,metadata().description);store.close();
  }
});
test('삭제는 성공한 metadata batch 뒤 해당 blob만 정리한다', async () => {
  const first = stored('item:1','old-blob');const second = stored('item:2','keep-blob');const storage = new MockStorage([first,second]);const store = await open(storage);
  const gate = deferred();storage.batchHook = () => gate.promise;const pending = store.remove(first.registrationId);
  await Promise.resolve();await Promise.resolve();assert.equal(store.items.length,2);assert.deepEqual(removals(storage),[]);gate.resolve();assert.deepEqual(await pending,{ ok:true });
  assert.deepEqual(removals(storage),['old-blob']);assert.equal(store.items[0].registrationId,second.registrationId);store.close();
});
test('삭제 충돌 뒤 동일 item 재등록은 새 registrationId와 blob을 보존한다', async () => {
  const original = stored('item:1','old-blob');const replacement = stored('item:1','new-blob');const storage = new MockStorage([original]);const store = await open(storage);
  storage.batchHook = async () => storage.external([replacement]);
  assert.deepEqual(await store.remove(original.registrationId),{ ok:true });assert.equal(store.items[0].registrationId,replacement.registrationId);assert.deepEqual(removals(storage),[]);store.close();
});
test('삭제 저장 실패에는 blob을 지우지 않고 정리 실패는 저장 성공을 되돌리지 않는다', async () => {
  const first = stored('item:1','icon');const storage = new MockStorage([first]);const store = await open(storage);
  storage.batchHook = async () => { throw err('storage.unavailable'); };
  assert.equal((await store.remove(first.registrationId)).ok,false);assert.equal(store.items.length,1);assert.deepEqual(removals(storage),[]);
  storage.batchHook = null;storage.removeHook = async () => { throw err('storage.blobUnavailable'); };
  assert.deepEqual(await store.remove(first.registrationId),{ ok:true,warning:'icon-cleanup-failed' });assert.equal(store.items.length,0);store.close();
});
test('알 수 없는 schema와 읽기 실패는 덮어쓰지 않고 refresh로 복구한다', async () => {
  const storage = new MockStorage();storage.snapshot.values[STORAGE_KEY] = { schemaVersion:99,items:[] };const store = new ItemStore({ storage });
  assert.equal((await store.start()).error.code,'unsupported-schema');assert.equal(store.ready,false);assert.equal((await store.add(metadata())).ok,false);assert.equal(batches(storage).length,0);
  storage.external([]);assert.equal(store.ready,true);storage.readHook = async () => { throw err('storage.unavailable'); };
  assert.equal((await store.refresh()).error.code,'storage-read-failed');assert.equal(store.ready,false);assert.equal((await store.add(metadata())).ok,false);assert.equal(batches(storage).length,0);
  storage.readHook = null;assert.deepEqual(await store.refresh(),{ ok:true });assert.equal(store.ready,true);store.close();
});
test('구독 실패와 닫히는 동안 늦게 온 구독을 안전하게 처리한다', async () => {
  const storage = new MockStorage();storage.subscribeHook = async () => { throw err('storage.unavailable'); };const store = new ItemStore({ storage });
  assert.equal((await store.start()).error.code,'storage-subscribe-failed');assert.equal((await store.add(metadata())).error.code,'not-ready');assert.equal(batches(storage).length,0);
  storage.subscribeHook = null;assert.deepEqual(await store.refresh(),{ ok:true });store.close();
  const other = new MockStorage();const gate = deferred();other.subscribeHook = () => gate.promise;let changes = 0;const closing = new ItemStore({ storage:other,onChange:()=>changes++ });
  const opening = closing.start();closing.close();gate.resolve();assert.equal((await opening).error.code,'closed');assert.equal(other.listeners.size,0);assert.equal(changes,0);
});
test('닫힘 뒤 blob 쓰기가 끝나면 자신의 blob을 정리하고 알림을 보내지 않는다', async () => {
  const storage = new MockStorage();let changes = 0;const store = await open(storage,()=>changes++);const gate = deferred();storage.putHook = () => gate.promise;
  const pending = store.add(metadata(),icon());await Promise.resolve();await Promise.resolve();await Promise.resolve();store.close();const atClose = changes;gate.resolve();
  assert.equal((await pending).error.code,'closed');assert.equal(changes,atClose);assert.deepEqual(removals(storage),['blob:1']);assert.equal(batches(storage).length,0);
});
test('metadata 상한과 원문 길이를 검증하고 100개 이후 추가를 막는다', async () => {
  assert.throws(()=>validateMetadata({ ...metadata(),name:' '.repeat(513)+'x' }));assert.throws(()=>validateMetadata({ ...metadata(),name:'가'.repeat(171) }));assert.throws(()=>validateMetadata({ ...metadata(),description:'x'.repeat(16385) }));
  assert.throws(()=>validateMetadata({ ...metadata(),id:'item:01' }));assert.throws(()=>validateMetadata({ ...metadata(),providerModuleId:' org.dho.vault-library' }));assert.throws(()=>validateMetadata({ ...metadata(),name:'  ' }));
  assert.equal(validateMetadata({ ...metadata(),name:'  이름  ' }).name,'  이름  ');
  const storage = new MockStorage(Array.from({ length:MAX_ITEMS },(_,i)=>stored(`item:${i+1}`)));const store = await open(storage);assert.equal((await store.add(metadata('item:1000'),icon())).error.code,'item-limit');assert.equal(storage.nextBlob,0);store.close();
});
test('손상된 영구 metadata와 공유 blob handle을 거절한다', () => {
  const one = stored('item:1','same');assert.throws(()=>validateDocument({ schemaVersion:1,items:[one,{ ...stored('item:2','same') }] }));
  assert.throws(()=>validateDocument({ schemaVersion:1,items:[{ ...one,registrationId:'not-uuid' }] }));assert.throws(()=>validateDocument({ schemaVersion:1,items:[{ ...one,addedAtUnixMillis:NaN }] }));
  assert.throws(()=>decodeIcon({ ...icon(),width:2 }));assert.throws(()=>decodeIcon({ ...icon(),base64:'A'.repeat(60*1024) }));
});
test('실패 blob 정리 오류는 원래 저장 오류와 함께 반환한다', async () => {
  const storage = new MockStorage();const store = await open(storage);storage.batchHook = async()=>{ throw err('storage.unavailable'); };storage.removeHook = async()=>{ throw err('storage.blobUnavailable'); };
  assert.deepEqual(await store.add(metadata(),icon()),{ ok:false,error:{ code:'storage-write-failed' },warning:'icon-cleanup-failed' });store.close();
});

test('동일 revision의 다른 payload를 적용하지 않는다', async () => {
  const item = stored();const storage = new MockStorage([item]);const store = await open(storage);
  storage.publish({ revision:0,values:{ [STORAGE_KEY]:{ schemaVersion:1,items:[] } } });assert.equal(store.items[0].registrationId,item.registrationId);store.close();
});
test('blob 보관 중 알 수 없는 새 schema가 오면 덮어쓰지 않고 새 blob을 정리한다', async () => {
  const storage = new MockStorage();const store = await open(storage);
  storage.putHook = async()=>{ storage.snapshot = { revision:1,values:{ [STORAGE_KEY]:{ schemaVersion:2,items:[] } } };storage.publish(storage.snapshot); };
  assert.equal((await store.add(metadata(),icon())).error.code,'unsupported-schema');assert.equal(batches(storage).length,0);assert.deepEqual(removals(storage),['blob:1']);assert.equal(store.ready,false);store.close();
});
test('batch 성공 대기 중 닫아도 이미 저장된 blob을 정리하지 않는다', async () => {
  const storage = new MockStorage();let changes = 0;const store = await open(storage,()=>changes++);const gate = deferred();storage.batchHook=()=>gate.promise;
  const pending = store.add(metadata(),icon());
  while (batches(storage).length === 0) await Promise.resolve();
  store.close();const atClose = changes;gate.resolve();assert.equal((await pending).ok,true);assert.equal(changes,atClose);assert.deepEqual(removals(storage),[]);assert.equal(storage.snapshot.values[STORAGE_KEY].items[0].iconHandle,'blob:1');
});
test('두 화면 동시 등록도 CAS로 두 항목을 보존한다', async () => {
  const storage = new MockStorage();const left = await open(storage);const right = await open(storage);
  const results = await Promise.all([left.add(metadata('item:1'),icon()),right.add(metadata('item:2'),icon())]);
  assert.ok(results.every(result=>result.ok));assert.equal(left.items.length,2);assert.equal(right.items.length,2);assert.equal(storage.snapshot.values[STORAGE_KEY].items.length,2);left.close();right.close();
});
