// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRareScheduler,createMotionPlayer,nearExpiry,REST_MS} from '../module/shared/hud-motion.js';

test('희귀 동작은 첫 30분 대기, 분당 확률 검사, 재대기와 연속 중복 금지',()=>{
 let time=0,calls=0;const scheduler=createRareScheduler({now:()=>time,random:()=>{calls++;return 0;}});
 time=REST_MS-1;assert.equal(scheduler.next(true),null);assert.equal(calls,0);
 time++;const first=scheduler.next(true);assert.equal(first,'bounce');
 time+=REST_MS-1;assert.equal(scheduler.next(true),null);
 time++;assert.notEqual(scheduler.next(true),first);
 time+=REST_MS;assert.equal(scheduler.next(false),null);const previous=calls;
 time+=59999;assert.equal(scheduler.next(true),null);assert.equal(calls,previous);
 time++;assert.ok(scheduler.next(true));
});
test('확률 경계와 짧은 기간의 임박 기준',()=>{
 let time=0;const scheduler=createRareScheduler({now:()=>time,random:()=>.05});time=REST_MS;assert.equal(scheduler.next(true),null);
 const timer={status:'running',durationMs:60000,expiresAt:60000};
 assert.equal(nearExpiry(timer,53999),false);assert.equal(nearExpiry(timer,54000),true);assert.equal(nearExpiry(timer,60000),false);
 assert.equal(nearExpiry({...timer,status:'paused'},55000),false);
 assert.equal(nearExpiry({...timer,durationMs:86400000,expiresAt:86400000},85800000),true);
});
test('애니메이션은 유한하며 교체·취소와 미지원 시 상태를 남기지 않는다',async()=>{
 const effects=[];const node={animate(frames,options){let resolve;const effect={frames,options,cancelled:false,finished:new Promise(r=>resolve=r),cancel(){this.cancelled=true;resolve();}};effects.push(effect);return effect;}};
 const row={art:node,gauge:node,frame:node},player=createMotionPlayer();
 assert.equal(player.play('start',row),true);assert.equal(effects.length,2);
 assert.ok(effects.every(e=>e.options.duration<=3000&&e.options.iterations===1));
 player.play('nudge',row,row);assert.ok(effects.slice(0,2).every(e=>e.cancelled));
 player.cancel();assert.equal(player.active,false);assert.ok(effects.every(e=>e.cancelled));
 assert.equal(player.play('bounce',{art:{}}),false);
 assert.equal(player.play('bounce',{art:{animate(){throw Error();}}}),false);assert.equal(player.active,false);
 await Promise.resolve();assert.equal(player.active,false);
});

test('장난은 한 프레임만 움직이고 통통·빼꼼·후다닥 이동을 되돌린다',()=>{
 const effects=[];const frame={animate(frames,options){const a={frames,options,finished:new Promise(()=>{}),cancel(){}};effects.push(a);return a;}};
 const row={frame,art:{animate(){assert.fail('그림만 따로 움직이지 않는다');}},gauge:{animate(){assert.fail('장난 중 게이지 따로 움직이지 않는다');}}};
 const player=createMotionPlayer(),geometry={travel:58,edge:108,peek:88,hop:12};
 for(const action of ['bounce','look','nod','nudge','peek','dash']){
  const before=effects.length;assert.equal(player.play(action,row,geometry),true);assert.equal(effects.length,before+1);const effect=effects.at(-1);assert.ok(['translate(0,0)','translateX(0)','scaleY(1)'].includes(effect.frames.at(-1).transform));assert.ok(effect.options.duration<=3000);player.cancel();
 }
 assert(effects[0].frames.some(f=>f.transform==='translate(58px,0)'));
 assert(effects[4].frames.some(f=>f.transform==='translateX(108px)'));
});
