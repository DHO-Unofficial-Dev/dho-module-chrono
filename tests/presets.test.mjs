// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, CATEGORIES, presetByKey } from '../module/shared/presets.js';

test('추천 항목은 확인된 4분류 13개이며 별도 카드와 선원 장비 기간을 보존한다', () => {
  assert.equal(PRESETS.length, 13);
  assert.deepEqual(CATEGORIES.map(category => PRESETS.filter(item => item.category === category).length), [3,5,3,2]);
  assert.deepEqual(PRESETS.filter(item => item.kind === 'tarot').map(item => [item.name,item.durationMs]), [['빛나는 타롯(세계)',10800000],['빛나는 타롯(여제)',10800000]]);
  assert.deepEqual(PRESETS.filter(item => item.category === '선원 장비').map(item => item.durationMs / 86400000), [1,7,15]);
  assert.equal(presetByKey('missing'), null);
});
test('추천 목록에 가짜 Vault ID나 이미지가 없고 조회한 원본을 대신하지 않는다', () => {
  for (const preset of PRESETS) {
    assert.deepEqual(Object.keys(preset).sort(), ['category','durationMs','key','kind','name','query']);
    assert.equal(preset.query, preset.name);
    assert.ok(Object.isFrozen(preset));
  }
});
