// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {createState,reduce,validateState} from '../module/shared/timer-model.js';
import {registrationCommand} from '../module/shared/registration.js';
function setup(count=4){let state=createState();for(let i=0;i<count;i++)state=reduce(state,registrationCommand({item:{providerModuleId:'app.dhoport.vault',id:`item:${i}`,name:`항목${i}`,description:'',iconHandle:null},groupId:state.groups[0].id,kind:i===3?'tarot':'item',durationMs:i===3?10800000:(i+1)*86400000}),1000);return state;}
const act=(state,index,type,extra={},now=1000)=>reduce(state,{type,id:state.timers[index].id,expectedVersion:state.timers[index].version,...extra},now);
const connect=(state,index,others)=>act(state,index,'link-start',{ids:others.map(i=>state.timers[i].id)});
test('기존 저장은 연결 없이 복원하고 연결은 중복·없는 ID를 거절한다',()=>{
 const state=setup();delete state.startLinks;assert.deepEqual(validateState(state).startLinks,[]);
 for(const ids of [[state.timers[0].id],[state.timers[1].id,state.timers[1].id],[crypto.randomUUID()]])assert.throws(()=>act(state,0,'link-start',{ids}),{code:'invalid-storage'});
});
test('어느 연결 항목에서 시작해도 대기·만료만 각 기간으로 동시에 시작한다',()=>{
 let state=setup();state=act(state,1,'start');state=act(state,3,'start');state=act(state,3,'pause');state=connect(state,0,[1,2,3]);
 const running=structuredClone(state.timers[1]),paused=structuredClone(state.timers[3]);
 const next=act(state,2,'start',{},2000);
 assert.equal(next.timers[0].expiresAt,2000+86400000);assert.equal(next.timers[2].expiresAt,2000+3*86400000);
 assert.deepEqual(next.timers[1],running);assert.deepEqual(next.timers[3],paused);
 const expired=act(next,0,'edit',{remainingMs:0},3000);const restarted=act(expired,2,'start',{},4000);
 assert.equal(restarted.timers[0].expiresAt,4000+86400000);assert.notEqual(restarted.timers[0].runId,next.timers[0].runId);
});
test('연결 해제·삭제는 남은 항목끼리의 연결과 시간을 보존한다',()=>{
 let state=connect(setup(),0,[1,2]);const before=state.timers.map(t=>t.status);
 state=connect(state,0,[]);assert.deepEqual(state.startLinks,[[state.timers[1].id,state.timers[2].id]]);assert.deepEqual(state.timers.map(t=>t.status),before);
 state=act(state,1,'remove');assert.deepEqual(state.startLinks,[]);assert.equal(state.timers.length,3);
});
test('다른 연결에 들어간 항목은 묵시적으로 합치지 않고, 오래된 저장 요청도 거절한다',()=>{
 let state=connect(setup(),0,[1]);state=connect(state,2,[3]);
 assert.throws(()=>connect(state,0,[2]),{code:'invalid-storage'});
 const old={type:'link-start',id:state.timers[0].id,expectedVersion:state.timers[0].version,ids:[]};state=connect(state,1,[]);
 assert.throws(()=>reduce(state,old,2000),{code:'timer-conflict'});
});
test('일괄 시작 실패는 일부 항목도 시작시키지 않고 원본을 보존한다',()=>{
 const state=connect(setup(),0,[1]),before=structuredClone(state);
 assert.throws(()=>act(state,0,'start',{},Number.MAX_SAFE_INTEGER),{code:'invalid-storage'});assert.deepEqual(state,before);
});
test('그룹 숨김과 이동은 시작 연결을 바꾸지 않으며 정지·편집은 개별 동작이다',()=>{
 let state=connect(setup(),0,[1]);const id=crypto.randomUUID();state=reduce(state,{type:'group-add',group:{...state.groups[0],id,timerIds:[],visible:false}},1000);
 state=act(state,1,'move',{targetId:id});state=act(state,0,'start');assert.equal(state.timers[1].status,'running');
 const linked=structuredClone(state.timers[1]);state=act(state,0,'stop');assert.deepEqual(state.timers[1],linked);
});
