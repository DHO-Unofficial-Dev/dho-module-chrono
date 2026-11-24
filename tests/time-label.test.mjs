import test from 'node:test';
import assert from 'node:assert/strict';
import {timeParts} from '../module/shared/time-label.js';
import {createState,validateState,reduce} from '../module/shared/timer-model.js';

test('시간 단위 토큰과 상태 문구를 구분한다',()=>{
  assert.deepEqual(timeParts('7d17h'),[{value:'7',unit:'d'},{value:'17',unit:'h'}]);
  assert.deepEqual(timeParts('58m17s'),[{value:'58',unit:'m'},{value:'17',unit:'s'}]);
  for(const value of ['대기','만료','<img>','7d?',null])assert.equal(timeParts(value),null);
});
test('기존 스타일은 시간 글자12로 복원하고 새 크기를 검증·보존한다',()=>{
  const state=createState();delete state.style.timeSize;
  assert.equal(validateState(state).style.timeSize,12);
  assert.equal(reduce(state,{type:'style',patch:{timeSize:20}},0).style.timeSize,20);
  for(const timeSize of [9,21,12.5,null,'14'])assert.throws(()=>reduce(state,{type:'style',patch:{timeSize}},0));
});

test('간격 0을 저장하고 기존 간격은 그대로 유지한다',()=>{
  const state=createState();
  assert.equal(validateState(reduce(state,{type:'style',patch:{gap:0}},0)).style.gap,0);
  assert.equal(validateState(state).style.gap,10);
  for(const gap of [-1,25,NaN])assert.throws(()=>reduce(state,{type:'style',patch:{gap}},0));
});
