// SPDX-License-Identifier: MPL-2.0
import { STORAGE_KEY, validateDocument, validRegistrationId } from './contracts.js';
import { KEY, createState, validateState } from './timer-model.js';

const failure = code => ({ ok: false, error: { code } });

// 타이머 등록과 같은 storage revision을 사용해 참조 검사와 삭제를 한 번에 확정한다.
export async function removeCachedItem(storage, registrationId) {
  if (!validRegistrationId(registrationId)) return failure('invalid-registration');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let snapshot;
    try { snapshot = await storage.getSnapshot(); }
    catch { return failure('storage-read-failed'); }
    let items; let state;
    try {
      if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
        || !snapshot.values || typeof snapshot.values !== 'object' || Array.isArray(snapshot.values)) throw new Error();
      items = validateDocument(Object.hasOwn(snapshot.values, STORAGE_KEY)
        ? snapshot.values[STORAGE_KEY] : { schemaVersion: 1, items: [] });
      state = validateState(Object.hasOwn(snapshot.values, KEY) ? snapshot.values[KEY] : createState());
    } catch (error) { return failure(error?.code === 'unsupported-schema' ? error.code : 'invalid-storage'); }
    const selected = items.find(item => item.registrationId === registrationId);
    if (!selected) return { ok: true };
    if (state.timers.some(timer => timer.item.providerModuleId === selected.providerModuleId && timer.item.id === selected.id)) {
      return failure('cache-in-use');
    }
    try {
      await storage.batch({ expectedRevision: snapshot.revision, operations: [{ kind: 'set', key: STORAGE_KEY,
        value: { schemaVersion: 1, items: items.filter(item => item.registrationId !== registrationId) } }] });
    } catch (error) {
      if (error?.code === 'storage.conflict' && attempt < 2) continue;
      return failure(error?.code === 'storage.conflict' ? 'storage-conflict' : 'storage-write-failed');
    }
    if (selected.iconHandle !== null) {
      try { await storage.removeBlob(selected.iconHandle); }
      catch { return { ok: true, warning: 'icon-cleanup-failed' }; }
    }
    return { ok: true };
  }
  return failure('storage-conflict');
}
