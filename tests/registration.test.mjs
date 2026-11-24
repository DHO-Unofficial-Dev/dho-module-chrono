// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { registrationCommand } from '../module/shared/registration.js';
const hour=3600000, now=1700000000000;
const item={providerModuleId:'app.dhoport.vault',id:'item:123',name:'세계',description:'타로 카드',iconHandle:null};
const input=()=>({item:{...item},groupId:'00000000-0000-4000-8000-000000000001',kind:'tarot',durationMs:3*hour});
test('동일 Vault 아이템도 독립 인스턴스이며 원본과 기본 기간은 보존한다',()=>{
 const value=input(),a=registrationCommand(value,now),b=registrationCommand(value,now);
 assert.notEqual(a.timer.id,b.timer.id);assert.equal(a.timer.status,'idle');assert.equal(a.timer.runId,null);
 value.item.name='바뀐 이름';assert.equal(a.timer.item.name,'세계');assert.equal(a.timer.durationMs,3*hour);
});
test('지금 사용·남은 시간·만료 시각을 같은 절대 시각 계약으로 변환한다',()=>{
 const a=registrationCommand({...input(),mode:'now'},now);assert.equal(a.timer.expiresAt,now+3*hour);
 for(const args of [{mode:'remaining',remainingMs:hour},{mode:'expires',expiresAt:now+hour}]){
  const c=registrationCommand({...input(),...args},now);assert.equal(c.timer.expiresAt,now+hour);assert.equal(c.timer.durationMs,3*hour);assert.ok(c.timer.runId);
 }
});
test('잘못된 타로 기간·초과 남은 시간·지난 만료 시각은 저장 명령을 만들지 않는다',()=>{
 for(const patch of [{durationMs:4*hour},{mode:'remaining',remainingMs:4*hour},{mode:'remaining',remainingMs:NaN},{mode:'expires',expiresAt:now-1},{mode:'expires',expiresAt:String(now+hour)},{name:'   '}]){
  assert.throws(()=>registrationCommand({...input(),...patch},now),{code:'invalid-registration'});
 }
});

test('Vault가 허용하는 긴 원본 이름도 별명 없이 등록한다',()=>{
 const long='가'.repeat(160), command=registrationCommand({...input(),item:{...item,name:long}},now);
 assert.equal(command.timer.name,long);
 assert.throws(()=>registrationCommand({...input(),name:'가'.repeat(171)},now),{code:'invalid-registration'});
});
