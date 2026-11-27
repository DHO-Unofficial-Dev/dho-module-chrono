// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {localDateTime,parseLocalDateTime} from '../module/shared/expiry-input.js';
import {suggestedTimerKind} from '../module/shared/timer-kind.js';
test('현지 만료 일시는 UTC 변환 없이 왕복하고 잘못된 달력 날짜를 거절한다',()=>{
 const t=new Date(2026,10,28,23,40,17).getTime();assert.equal(localDateTime(t),'2026-11-28T23:40:17');assert.equal(parseLocalDateTime(localDateTime(t)),t);
 assert.equal(parseLocalDateTime('2026-11-28T23:40'),new Date(2026,10,28,23,40).getTime());
 for(const v of ['', '2026-02-30T12:00','2026-11-28T24:00','2026-11-28T23:40Z','2026-13-28T23:40'])assert.equal(parseLocalDateTime(v),null);
});
test('빛나는 타롯 외 카드와 설명을 포함해 종류를 제안한다',()=>{
 for(const name of ['빛나는 타롯(여제)','타롯 카드','타로 카드','아르카나 셋트'])assert.equal(suggestedTimerKind({name}),'tarot');
 assert.equal(suggestedTimerKind({name:'여제',description:'타롯을 발동한다.'}),'tarot');
 assert.equal(suggestedTimerKind({name:'풍신의 보석',description:'항해 속도가 상승한다.'}),'item');
});
