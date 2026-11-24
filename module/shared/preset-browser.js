// SPDX-License-Identifier: MPL-2.0
import { createIconCache } from './icon-cache.js';
const normalized = value => value.replace(/\s/g, '').toLowerCase();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const itemId = value => typeof value === 'string' && /^item:(0|[1-9][0-9]{0,9})$/.test(value) && Number(value.slice(5)) <= 4294967295;
function validPage(page) {
  return record(page) && typeof page.generation === 'string' && page.generation.length > 0 && page.generation.length <= 128
    && Number.isSafeInteger(page.total) && page.total >= 0 && Array.isArray(page.items) && page.items.length <= 20
    && page.items.every(item => record(item) && itemId(item.id) && typeof item.name === 'string' && item.name.length <= 512 && (item.iconRef === null || itemId(item.iconRef)))
    && (page.nextOffset === null || (Number.isSafeInteger(page.nextOffset) && page.nextOffset >= 0));
}
export function createPresetBrowser({ client, onChange, iconPersistence }) {
  const icons = createIconCache();
  const rows = new Map();
  let epoch = 0, work = 0, closed = false, provider = null, generation = null;
  function cancel() {
    work++;
    // 아이콘 수신까지 하나의 읽기다. 중단한 행은 다음 표시에서 다시 시도한다.
    for (const [key,row] of rows) if (row.state === 'loading') rows.delete(key);
  }
  function reset() { cancel(); epoch++; rows.clear(); icons.clear(); provider = null; generation = null; if (!closed) onChange(); }
  function setScope(nextProvider, nextGeneration) {
    if (provider !== nextProvider || generation !== nextGeneration) {
      rows.clear(); provider = nextProvider; generation = nextGeneration;
      icons.setScope(provider, generation); onChange();
    }
  }
  const call = async (...args) => { try { return await client.call(...args); } catch { return {ok:false}; } };
  async function load(entries, { refresh = false } = {}) {
    cancel(); const job = work, token = epoch, identity = client.identity();
    const current = () => Boolean(identity) && !closed && job === work && token === epoch && identity.epoch === client.identity()?.epoch && identity.providerModuleId === client.identity()?.providerModuleId;
    if (refresh && current()) {
      const response = await call('get-status');
      if (!current()) return;
      const status = response?.ok && response.result;
      if (status?.state !== 'ready' || typeof status.generation !== 'string' || !status.generation.length || status.generation.length > 128) {
        rows.clear(); onChange(); return;
      }
      setScope(identity.providerModuleId, status.generation);
    }
    for (const preset of entries) {
      if (!current()) return;
      const existing = rows.get(preset.key);
      if (existing?.state === 'ready' || existing?.state === 'missing') continue;
      rows.set(preset.key, {state:'loading'}); onChange();
      const response = await call('search-items', {query:preset.query,offset:0,limit:20});
      if (!current()) return;
      const page = response?.ok && response.result;
      if (!validPage(page)) { rows.set(preset.key,{state:'failed'}); onChange(); continue; }
      setScope(identity.providerModuleId,page.generation);
      const exact = page.items.filter(item => normalized(item.name) === normalized(preset.name));
      if (exact.length !== 1) { rows.set(preset.key,{state:'missing'}); onChange(); continue; }
      const item = exact[0];
      if (item.iconRef === null) { rows.set(preset.key,{state:'ready',item,icon:null}); onChange(); continue; }
      rows.set(preset.key,{state:'loading',item,icon:null}); onChange();
      icons.setScope(identity.providerModuleId,page.generation);
      const icon = await icons.get(item.iconRef,()=> {
        const load = () => call('get-icon',{iconRef:item.iconRef,generation:page.generation});
        return iconPersistence ? iconPersistence.load(identity.providerModuleId,page.generation,item.iconRef,load,current) : load();
      },current);
      if (!current()) return;
      rows.set(preset.key,{state:icon.ok ? 'ready' : 'failed',item,icon:icon.ok ? icon.result : null}); onChange();
    }
  }
  return { rows, load, reset, cancel, close() {closed=true; reset(); icons.close();} };
}
