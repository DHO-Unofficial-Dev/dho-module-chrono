import test from 'node:test';
import assert from 'node:assert/strict';
import {splitDuration,joinDuration} from '../module/shared/duration-input.js';
test('일시분초 분해와 합산은 긴 기간과 초 단위를 보존한다',()=>{
  assert.deepEqual(splitDuration(43200*60000),[30,0,0,0]);
  assert.deepEqual(splitDuration(180*60000),[0,3,0,0]);
  assert.deepEqual(splitDuration(90061000),[1,1,1,1]);
  assert.deepEqual(splitDuration(999),[0,0,0,1]);
  for(const value of [0,1000,59000,3600000,90061000,366*86400000])assert.equal(joinDuration(splitDuration(value)),value);
});
test('시간 각 단위의 음수 소수 빈 값 및 범위 밖 값을 거부한다',()=>{
  for(const value of [[0,24,0,0],[0,0,60,0],[0,0,0,60],[-1,0,0,0],[0,0,1.5,0],[NaN,0,0,0],[367,0,0,0],[0,0,0]])assert.equal(joinDuration(value),null);
});
