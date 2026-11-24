// SPDX-License-Identifier: MPL-2.0
// 영구 저장값과 Vault 사본은 외부 입력이므로 원문 길이와 필드 형식을 검증한다.
export const STORAGE_KEY = 'timer.items.v1';
export const MAX_ITEMS = 100;
export const MAX_ICON_BYTES = 40 * 1024;
const encoder = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bytes = value => encoder.encode(value).length;
function invalid(code) { throw Object.assign(new Error(code), { code }); }
function cleanIdentifier(value, maximum) {
  return typeof value === 'string' && value === value.trim() && value.length > 0
    && bytes(value) <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}
export function itemKey(value) { return `${value.providerModuleId}\n${value.id}`; }
export function validRegistrationId(value) { return typeof value === 'string' && UUID.test(value); }
export function validIconHandle(value) { return cleanIdentifier(value, 512); }
export function validateMetadata(value) {
  if (!record(value) || !cleanIdentifier(value.providerModuleId, 128)
    || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value.providerModuleId)
    || typeof value.id !== 'string' || !/^item:(0|[1-9][0-9]{0,9})$/.test(value.id)
    || Number(value.id.slice(5)) > 0xffffffff
    || typeof value.name !== 'string' || value.name.trim().length === 0 || bytes(value.name) > 512
    || typeof value.description !== 'string' || bytes(value.description) > 16 * 1024) invalid('invalid-item');
  return { providerModuleId: value.providerModuleId, id: value.id, name: value.name, description: value.description };
}
export function validateDocument(value) {
  if (!record(value)) invalid('invalid-storage');
  if (value.schemaVersion !== 1) invalid('unsupported-schema');
  if (!Array.isArray(value.items) || value.items.length > MAX_ITEMS) invalid('invalid-storage');
  const keys = new Set();
  const registrations = new Set();
  const handles = new Set();
  const items = value.items.map(entry => {
    let metadata;
    try { metadata = validateMetadata(entry); } catch { invalid('invalid-storage'); }
    if (!validRegistrationId(entry.registrationId) || registrations.has(entry.registrationId.toLowerCase())
      || !Number.isSafeInteger(entry.addedAtUnixMillis) || entry.addedAtUnixMillis < 0
      || !(entry.iconHandle === null || validIconHandle(entry.iconHandle))
      || (entry.iconHandle !== null && handles.has(entry.iconHandle)) || keys.has(itemKey(metadata))) invalid('invalid-storage');
    keys.add(itemKey(metadata)); registrations.add(entry.registrationId.toLowerCase());
    if (entry.iconHandle !== null) handles.add(entry.iconHandle);
    return Object.freeze({ registrationId: entry.registrationId, ...metadata,
      iconHandle: entry.iconHandle, addedAtUnixMillis: entry.addedAtUnixMillis });
  });
  return Object.freeze(items);
}
export function decodeIcon(icon) {
  if (!record(icon) || icon.mediaType !== 'image/png' || !Number.isSafeInteger(icon.width) || icon.width < 1
    || !Number.isSafeInteger(icon.height) || icon.height < 1 || typeof icon.base64 !== 'string'
    || icon.base64.length > Math.ceil(MAX_ICON_BYTES / 3) * 4 || icon.base64.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(icon.base64)) invalid('invalid-icon');
  let raw;
  try { raw = atob(icon.base64); } catch { invalid('invalid-icon'); }
  if (btoa(raw) !== icon.base64 || raw.length < 24 || raw.length > MAX_ICON_BYTES) invalid('invalid-icon');
  const data = Uint8Array.from(raw, char => char.charCodeAt(0));
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((byte, index) => data[index] === byte)
    || String.fromCharCode(...data.slice(12, 16)) !== 'IHDR') invalid('invalid-icon');
  const view = new DataView(data.buffer);
  if (view.getUint32(8) !== 13 || view.getUint32(16) !== icon.width || view.getUint32(20) !== icon.height) invalid('invalid-icon');
  return data;
}
