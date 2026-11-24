// SPDX-License-Identifier: MPL-2.0
import { validateMetadata, validIconHandle, validRegistrationId } from './contracts.js';
const MINUTE = 60000, TAROT = 180 * MINUTE, MAX = 366 * 86400000;
const fail = () => { throw Object.assign(new Error('invalid-registration'), { code: 'invalid-registration' }); };
/** 확인된 Vault 사본으로 등록 명령을 만든다. */
export function registrationCommand({ item, groupId, name, kind, durationMs, mode = 'idle', remainingMs, expiresAt }, now = Date.now()) {
  // 이 함수는 저장하지 않고 호출 시점의 값을 확정한다.
  if (!Number.isSafeInteger(now) || now < 0 || !validRegistrationId(groupId) || groupId !== groupId.toLowerCase()
    || !['item','tarot'].includes(kind) || !['idle','now','remaining','expires'].includes(mode)) fail();
  const metadata = validateMetadata(item);
  if (!(item.iconHandle === null || validIconHandle(item.iconHandle))) fail();
  if (!Number.isSafeInteger(durationMs) || durationMs < MINUTE || durationMs > MAX || (kind === 'tarot' && durationMs !== TAROT)) fail();
  const label = name === undefined ? metadata.name : name;
  if (typeof label !== 'string' || !label.trim() || new TextEncoder().encode(label).length > 512 || /[\u0000-\u001f\u007f]/.test(label)) fail();
  const left = mode === 'expires' ? expiresAt - now : mode === 'remaining' ? remainingMs : durationMs;
  if (mode !== 'idle' && (!Number.isSafeInteger(left) || left <= 0 || left > durationMs || !Number.isSafeInteger(now + left))) fail();
  if (mode === 'expires' && !Number.isSafeInteger(expiresAt)) fail();
  return { type: 'add', groupId, timer: {
    id: crypto.randomUUID(), version: 1,
    item: { ...metadata, iconHandle: item.iconHandle }, name: label.trim(), kind, durationMs,
    status: mode === 'idle' ? 'idle' : 'running', expiresAt: mode === 'idle' ? null : now + left,
    remainingMs: null, runId: mode === 'idle' ? null : crypto.randomUUID(),
    alerts: { toast: true, sound: false, leadMinutes: [] },
  } };
}
