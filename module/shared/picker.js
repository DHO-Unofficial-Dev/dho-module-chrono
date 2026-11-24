// SPDX-License-Identifier: MPL-2.0
import { serviceMessage } from './service-client.js';
import { createIconCache } from './icon-cache.js';
const MESSAGES = {
  'not-configured': 'Vault 라이브러리에서 게임 설치 위치를 먼저 적용해 주세요.',
  'stale-generation': '아이템 자료가 갱신되었습니다. 다시 검색해 주세요.',
  'data-changed': '게임 파일이 바뀌었습니다. Vault에서 다시 읽기를 실행해 주세요.',
  'invalid-data': '아이템 정보를 읽을 수 없습니다.',
  'unavailable': 'Vault가 준비되지 않았습니다. 잠시 후 다시 확인해 주세요.',
  'timeout': '아이템 읽기 시간이 초과되었습니다. 다시 시도해 주세요.',
  'busy': 'Vault가 자료를 준비하고 있습니다. 잠시 후 다시 확인해 주세요.',
};
const explain = response => serviceMessage(response?.error?.code) || MESSAGES[response?.error?.code] || '아이템을 읽지 못했습니다. 다시 시도해 주세요.';
const itemId = value => typeof value === 'string' && new RegExp('^item:(0|[1-9][0-9]{0,9})$').test(value) && Number(value.slice(5)) <= 4294967295;
function validPage(page) {
  return page && typeof page.generation === 'string' && page.generation.length <= 128 && Number.isSafeInteger(page.total) && page.total >= 0
    && Array.isArray(page.items) && page.items.length <= 20
    && page.items.every(item => itemId(item.id) && typeof item.name === 'string' && item.name.length <= 512 && (item.iconRef === null || itemId(item.iconRef)))
    && (page.nextOffset === null || (Number.isSafeInteger(page.nextOffset) && page.nextOffset >= 0));
}
function validIcon(value, generation) {
  return value && value.generation === generation && value.mediaType === 'image/png'
    && typeof value.base64 === 'string' && value.base64.length <= 54616
    && Number.isInteger(value.width) && value.width > 0 && value.width <= 4096
    && Number.isInteger(value.height) && value.height > 0 && value.height <= 4096;
}
export function createPicker({ client, onChange = () => {}, save, iconPersistence }) {
  const iconCache = createIconCache();
  const getIcon = (identity, generation, iconRef, current) => iconCache.get(iconRef, () => {
    const load = () => call('get-icon', { iconRef, generation });
    return iconPersistence ? iconPersistence.load(identity.providerModuleId, generation, iconRef, load, current) : load();
  }, current);
  let closed = false, pageToken = 0, detailToken = 0, saving = false;
  let state = { available: false, message: 'Vault 연결을 확인하고 있습니다.', query: '', offset: 0, nextOffset: null, total: 0, results: [], detail: null, saving: false, saveResult: null };
  const emit = patch => { state = { ...state, ...patch }; if (!closed) onChange(state); };
  const invalidate = () => { pageToken++; detailToken++; };
  const sameIdentity = identity => { const now = client.identity(); return identity && now && identity.providerModuleId === now.providerModuleId && identity.epoch === now.epoch; };
  const call = async (...args) => { try { return await client.call(...args); } catch { return { ok: false, error: { code: 'unavailable' } }; } };
  async function search(query = state.query, offset = 0) {
    if (closed || !state.available) return;
    invalidate(); const token = pageToken, identity = client.identity();
    emit({ query, offset, nextOffset: null, total: 0, results: [], detail: null, message: '아이템을 찾고 있습니다.' });
    const response = await call('search-items', { query, offset, limit: 20 });
    if (closed || token !== pageToken || !sameIdentity(identity)) return;
    if (!response.ok) { iconCache.clear(); emit({ message: explain(response) }); return; }
    const page = response.result;
    if (!validPage(page)) { emit({ message: MESSAGES['invalid-data'] }); return; }
    iconCache.setScope(identity.providerModuleId, page.generation);
    emit({ results: page.items.map(item => ({ ...item, generation: page.generation, identity, icon: null, iconState: item.iconRef ? 'loading' : 'missing' })), total: page.total, nextOffset: page.nextOffset, message: page.items.length ? '아이템을 선택하면 설명을 확인할 수 있습니다.' : '검색 결과가 없습니다.' });
    await Promise.all(page.items.map(async (row, index) => {
      if (!row.iconRef) return;
      if (closed || token !== pageToken || !sameIdentity(identity)) return;
      const icon = await getIcon(identity, page.generation, row.iconRef, () => !closed && token === pageToken && sameIdentity(identity));
      if (closed || token !== pageToken || !sameIdentity(identity)) return;
      const ok = icon.ok && validIcon(icon.result, page.generation);
      emit({ results: state.results.map((item, position) => position === index ? { ...item, icon: ok ? icon.result : null, iconState: ok ? 'ready' : 'missing' } : item) });
    }));
  }
  async function refresh() {
    if (closed) return;
    invalidate(); const token = pageToken;
    emit({ available: false, results: [], detail: null, total: 0, nextOffset: null, message: 'Vault 연결을 확인하고 있습니다.' });
    const response = await call('get-status');
    if (closed || token !== pageToken) return;
    if (!response.ok) { iconCache.clear(); emit({ message: explain(response) }); return; }
    if (response.result?.state !== 'ready') { emit({ message: MESSAGES['not-configured'] }); return; }
    emit({ available: true });
    await search(state.query);
  }
  async function select(item) {
    if (closed || !state.available || !sameIdentity(item.identity) || !state.results.some(row => row === item || (row.id === item.id && row.generation === item.generation))) return;
    const token = ++detailToken, page = pageToken;
    emit({ detail: { loading: true }, saveResult: null });
    const response = await call('get-item', { id: item.id, generation: item.generation });
    if (closed || token !== detailToken || page !== pageToken || !sameIdentity(item.identity)) return;
    const value = response.result;
    if (!response.ok || !value || value.id !== item.id || value.generation !== item.generation || typeof value.name !== 'string' || typeof value.description !== 'string' || value.name.length > 512 || value.description.length > 16384) {
      if (['data-changed', 'stale-generation'].includes(response.error?.code)) iconCache.clear();
      emit({ detail: { error: response.ok ? MESSAGES['invalid-data'] : explain(response) } }); return;
    }
    const detail = { ...value, providerModuleId: item.identity.providerModuleId, identity: item.identity, icon: item.icon, iconState: item.icon ? 'ready' : (value.iconRef ? 'loading' : 'missing') };
    emit({ detail });
    if (!value.iconRef || item.icon) return;
    const icon = await getIcon(item.identity, value.generation, value.iconRef, () => !closed && token === detailToken && page === pageToken && sameIdentity(item.identity));
    if (closed || token !== detailToken || page !== pageToken || !sameIdentity(item.identity)) return;
    const ok = icon.ok && validIcon(icon.result, value.generation);
    emit({ detail: { ...detail, icon: ok ? icon.result : null, iconState: ok ? 'ready' : 'missing' } });
  }
  return {
    get state() { return state; }, refresh, search, select,
    invalidateSearch() { invalidate(); emit({ results: [], detail: null, total: 0, nextOffset: null }); },
    clearCache() { iconCache.clear(); },
    disconnect(message) { iconCache.clear(); invalidate(); emit({ available: false, results: [], detail: null, total: 0, nextOffset: null, message }); },
    async register() {
      const detail = state.detail;
      if (closed || saving || !detail?.id || detail.iconState === 'loading' || !sameIdentity(detail.identity)) return;
      saving = true; emit({ saving: true, saveResult: null });
      try { emit({ saveResult: await save({ providerModuleId: detail.providerModuleId, id: detail.id, name: detail.name, description: detail.description }, detail.icon) }); }
      catch { emit({ saveResult: { ok: false, error: { code: 'storage-write-failed' } } }); }
      finally { saving = false; emit({ saving: false }); }
    },
    close() { closed = true; iconCache.close(); invalidate(); },
  };
}
