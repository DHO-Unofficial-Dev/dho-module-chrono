// SPDX-License-Identifier: MPL-2.0
// 추천 기간은 이 목록에서 명시한다. Vault 설명에서 추측하거나 item ID를 만들어 넣지 않는다.
const DAY = 86400000;
const rows = [
  ['wind', '항해', '풍신의 보석(30일)', 30],
  ['pendant', '항해', '풍신의 강화 팬던트(1일)', 1],
  ['anemoi', '항해', '아네모이의 보석(30일)', 30],
  ['ship-vault', '창고', '선박 금고 사용증(15일)', 15],
  ['ship-vault-2', '창고', '선박 금고(NO.2) 사용증', 15],
  ['shared-1', '창고', '공유 창고(NO.1) 사용증(15일)', 15],
  ['shared-2', '창고', '공유 창고(NO.2) 사용증(15일)', 15],
  ['skill-note', '창고', '스킬 노트 사용증(15일)', 15],
  ['crew-basic', '선원 장비', '선원 장비를 손질하는 방법 기초', 1],
  ['crew-applied', '선원 장비', '선원 장비를 손질하는 방법 응용', 7],
  ['crew-advanced', '선원 장비', '선원 장비를 손질하는 방법 발전', 15],
  ['world', '타롯', '빛나는 타롯(세계)', null],
  ['empress', '타롯', '빛나는 타롯(여제)', null],
];
export const PRESETS = Object.freeze(rows.map(([key, category, name, days]) => Object.freeze({
  key, category, name, query: name, kind: days === null ? 'tarot' : 'item',
  durationMs: days === null ? 3 * 3600000 : days * DAY,
})));
export const CATEGORIES = Object.freeze(['항해', '창고', '선원 장비', '타롯']);
export function presetByKey(key) { return PRESETS.find(preset => preset.key === key) ?? null; }
// 추천 버튼은 검색만 한다. 유사한 이름의 다른 기간 아이템을 자동 등록하지 않는다.
// 검색 결과를 사용자가 확인한 뒤 선택한 원본의 ID·이름·아이콘을 저장한다.
