// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {observeMotionPreview,requestMotionPreview,MOTION_PREVIEW_KEY as KEY} from '../module/shared/motion-preview.js';
function mock(){let fn;return {snapshot:{revision:0,values:{}},async subscribe(callback){fn=callback;callback(this.snapshot);return()=>{fn=null;};},async getSnapshot(){return this.snapshot;},async batch(input){assert.equal(input.expectedRevision,this.snapshot.revision);assert.equal(input.operations[0].kind,'set');this.send(input.operations[0].value);},send(value,revision=this.snapshot.revision+1){this.snapshot={revision,values:{[KEY]:value}};fn?.(this.snapshot);}};}
test('시작 명령 재생 금지, revision 역전·중복·만료 무시와 즉시 stop',async()=>{
 const storage=mock(),seen=[];const command={id:'old',action:'bounce',expiresAt:2000};storage.send(command);
 const observer=observeMotionPreview(storage,action=>seen.push(action),()=>1000);await observer.start();assert.deepEqual(seen,[]);
 storage.send({...command,id:'new'});storage.send({...command,id:'new'});storage.send({...command,id:'stale'},1);
 storage.send({...command,id:'expired',expiresAt:1000},8);storage.send({...command,id:'stop',action:'stop'},9);
 assert.deepEqual(seen,['bounce','stop']);observer.close();storage.send({...command,id:'late'});assert.equal(seen.length,2);
});
test('종료 뒤 늦은 구독을 해제하고 읽기 실패는 명령을 받지 않는다',async()=>{
 let resolve,stopped=0;const observer=observeMotionPreview({subscribe:()=>new Promise(r=>resolve=r)},()=>assert.fail());
 const starting=observer.start();observer.close();resolve(()=>stopped++);await starting;assert.equal(stopped,1);
 let callback;const failed=observeMotionPreview({async subscribe(fn){callback=fn;return()=>stopped++;},async getSnapshot(){throw Error();}},()=>assert.fail());await failed.start();callback({revision:9,values:{[KEY]:{id:'x',action:'stop',expiresAt:Date.now()+1000}}});assert.equal(stopped,2);failed.close();
});
test('보내기는 짧은 유효 기간·명령 ID를 쓰고 CAS 충돌만 재시도한다',async()=>{
 const storage=mock();let tries=0;const batch=storage.batch.bind(storage);storage.batch=async input=>{if(++tries===1)throw Object.assign(Error(),{code:'storage.conflict'});return batch(input);};
 await requestMotionPreview(storage,'peek');assert.equal(tries,2);const command=storage.snapshot.values[KEY];assert.equal(command.action,'peek');assert.ok(command.expiresAt>Date.now());assert.ok(command.id);
 await assert.rejects(requestMotionPreview(storage,'unknown'));
 storage.batch=async()=>{throw Error('failed');};await assert.rejects(requestMotionPreview(storage,'stop'),/failed/);
});
