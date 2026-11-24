// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPicker } from '../module/shared/picker.js';
const ok = result => ({ ok: true, result });
const row = (id = 'item:1', name = '풍신의 보석') => ({ id, name, iconRef: null });
const page = items => ok({ generation: 'g1', items, total: items.length, nextOffset: null });
function fixture() {
  const f = { identity: { providerModuleId: 'org.dho.vault-library', epoch: 1 }, saves: [], updates: [] };
  f.dispatch = async (method, params) => method === 'get-status' ? ok({ state: 'ready' })
    : method === 'search-items' ? page([row()])
    : method === 'get-item' ? ok({ ...row(params.id), generation: params.generation, description: '30일간 사용하는 아이템 설명' })
    : { ok: false, error: { code: 'icon-missing' } };
  f.picker = createPicker({ client: { identity: () => f.identity, call: (...args) => f.dispatch(...args) }, pace: 0,
    save: async (...args) => { f.saves.push(args); return { ok: true }; }, onChange: state => f.updates.push(state) });
  return f;
}
test('이름·설명 선택 후 등록하며 기간을 추론하거나 조회만으로 저장하지 않는다', async () => {
  const f = fixture(); await f.picker.refresh(); await f.picker.select(f.picker.state.results[0]);
  assert.equal(f.saves.length, 0); assert.equal(f.picker.state.detail.iconState, 'missing');
  await f.picker.register(); assert.equal(f.saves.length, 1);
  assert.deepEqual(f.saves[0], [{ providerModuleId: 'org.dho.vault-library', id: 'item:1', name: '풍신의 보석', description: '30일간 사용하는 아이템 설명' }, null]);
  assert.equal(f.picker.state.saveResult.ok, true); f.picker.close();
});
test('늦은 이전 검색 응답은 새 검색 결과를 덮지 않는다', async () => {
  const f = fixture(); await f.picker.refresh(); let finish;
  f.dispatch = async (_method, params) => params.query === 'old' ? new Promise(resolve => { finish = resolve; }) : page([row('item:2', '공유 창고')]);
  const old = f.picker.search('old'); await f.picker.search('new'); finish(page([row()])); await old;
  assert.equal(f.picker.state.results[0].id, 'item:2'); f.picker.close();
});
test('선택을 바꾸면 이전 상세 응답을 폐기한다', async () => {
  const f = fixture(); await f.picker.refresh(); f.dispatch = async () => page([row(), row('item:2')]); await f.picker.search('');
  let finish; f.dispatch = async (_method, params) => params.id === 'item:1' ? new Promise(resolve => { finish = resolve; }) : ok({ ...row('item:2'), generation: 'g1', description: '새 선택' });
  const old = f.picker.select(f.picker.state.results[0]); await f.picker.select(f.picker.state.results[1]); finish(ok({ ...row(), generation: 'g1', description: '이전 선택' })); await old;
  assert.equal(f.picker.state.detail.id, 'item:2'); await f.picker.register(); assert.equal(f.saves[0][0].id, 'item:2'); f.picker.close();
});
test('아이콘이 없어도 등록되며 읽는 동안은 등록하지 않는다', async () => {
  const f = fixture(); await f.picker.refresh(); let finish;
  f.dispatch = async method => method === 'get-item' ? ok({ ...row(), iconRef: 'item:1', generation: 'g1', description: '설명' }) : new Promise(resolve => { finish = resolve; });
  const selected = f.picker.select(f.picker.state.results[0]); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  await f.picker.register(); assert.equal(f.saves.length, 0);
  finish({ ok: false, error: { code: 'icon-missing' } }); await selected; await f.picker.register(); assert.equal(f.saves.length, 1); f.picker.close();
});
test('연결 세대가 바뀐 상세는 등록하지 않고 닫힌 화면에 결과를 내보내지 않는다', async () => {
  const f = fixture(); await f.picker.refresh(); await f.picker.select(f.picker.state.results[0]);
  f.identity = { ...f.identity, epoch: 2 }; await f.picker.register(); assert.equal(f.saves.length, 0);
  f.picker.disconnect('연결 필요'); assert.deepEqual(f.picker.state.results, []); assert.equal(f.picker.state.detail, null);
  const count = f.updates.length; f.picker.close(); await f.picker.refresh(); assert.equal(f.updates.length, count);
});
test('잘못된 공용 응답을 표시하지 않고 연결 오류를 유지한다', async () => {
  const f = fixture(); f.dispatch = async () => ({ ok: false, error: { code: 'services.unbound' } });
  await f.picker.refresh(); assert.match(f.picker.state.message, /연결 버튼/); assert.equal(f.picker.state.available, false);
  f.dispatch = async method => method === 'get-status' ? ok({ state: 'ready' }) : page([{ id: 'secret-path', name: 'bad', iconRef: null }]);
  await f.picker.refresh(); assert.equal(f.picker.state.results.length, 0); assert.match(f.picker.state.message, /읽을 수 없습니다/); f.picker.close();
});

test('실제 picker의 같은 검색·상세는 아이콘을 재요청하지 않고 세대 변경에는 다시 읽는다', async () => {
  const f = fixture(); let generation = 'g1', iconCalls = 0, active = 0, peak = 0;
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG3cAAAAASUVORK5CYII=';
  const items = Array.from({ length: 20 }, (_, index) => ({ ...row(`item:${index + 1}`, `아이템 ${index + 1}`), iconRef: `item:${index + 1}` }));
  f.dispatch = async (method, params) => {
    if (method === 'get-status') return ok({ state: 'ready' });
    if (method === 'search-items') return ok({ generation, total: 20, items, nextOffset: null });
    if (method === 'get-item') return ok({ ...items.find(item => item.id === params.id), generation, description: '상세' });
    iconCalls++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2)); active--;
    return ok({ generation: params.generation, mediaType: 'image/png', base64: png, width: 1, height: 1 });
  };
  await f.picker.refresh(); assert.equal(iconCalls, 20); assert.equal(peak, 4);
  assert.deepEqual(f.picker.state.results.map(item => item.id), items.map(item => item.id));
  await f.picker.search('같은 검색'); await f.picker.select(f.picker.state.results[0]); assert.equal(iconCalls, 20);
  generation = 'g2'; await f.picker.search('같은 검색'); assert.equal(iconCalls, 40);
  f.picker.disconnect('연결 변경'); await f.picker.refresh(); assert.equal(iconCalls, 60);
  f.picker.close();
});
