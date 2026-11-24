import test from 'node:test';
import assert from 'node:assert/strict';
import {createState,validateState,reduce} from '../module/shared/timer-model.js';
test('구버전 스타일은 모션 두 설정을 켜짐으로 복원한다',()=>{
 const state=createState();delete state.style.motion;delete state.style.easterEggs;
 const restored=validateState(state);assert.equal(restored.style.motion,true);assert.equal(restored.style.easterEggs,true);
});
test('모션 두 설정은 독립 저장하며 기간과 타이머를 변경하지 않는다',()=>{
 const state=createState();const next=reduce(state,{type:'style',patch:{motion:false,easterEggs:true}},Date.now());
 assert.equal(next.style.motion,false);assert.equal(next.style.easterEggs,true);assert.deepEqual(next.timers,state.timers);assert.deepEqual(next.groups,state.groups);
 assert.equal(validateState(next).style.motion,false);
});
test('모션 설정의 잘못된 자료형은 거부한다',()=>{
 for(const key of ['motion','easterEggs'])for(const value of [0,'false',null]){
  const state=createState();state.style[key]=value;assert.throws(()=>validateState(state));
 }
});
