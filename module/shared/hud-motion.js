// SPDX-License-Identifier: MPL-2.0
import { MOTION_ACTIONS } from './motion-preview.js';
export const REST_MS=30*60*1000, CHANCE_INTERVAL_MS=60000;
export function nearExpiry(timer, now) {
  const remaining=timer.expiresAt-now;
  return timer.status==='running'&&remaining>0&&remaining<=Math.min(600000,timer.durationMs*.1);
}
export function createRareScheduler({now=Date.now,random=Math.random}={}) {
  let lastTrigger=now(), lastCheck=lastTrigger, lastAction=null;
  return {
    next(eligible){
      const time=now();
      if(time-lastTrigger<REST_MS||time-lastCheck<CHANCE_INTERVAL_MS)return null;
      lastCheck=time;
      if(!eligible||random()>=.05)return null;
      const choices=MOTION_ACTIONS.filter(action=>action!==lastAction);
      lastAction=choices[Math.min(choices.length-1,Math.floor(random()*choices.length))];lastTrigger=time;
      return lastAction;
    },
    triggered(action){lastTrigger=now();lastCheck=lastTrigger;lastAction=action;}
  };
}
const transforms={
  bounce:['translateY(0)','translateY(-3px) scale(1.03)','translateY(1px) scale(.98)','translateY(-2px) scale(1.02)','translateY(0)'],
  look:['translateX(0)','translateX(-2px) rotate(-4deg)','translateX(2px) rotate(4deg)','translateX(0)'],
  nod:['scaleY(1)','scaleY(.88) translateY(2px)','scaleY(1.02) translateY(-1px)','scaleY(1)'],
  nudge:['translateX(0)','translateX(3px) rotate(5deg)','translateX(0)'],
  peek:['translateY(0)','translateY(120%)','translateY(65%)','translateY(65%)','translateY(0)'],
  start:['scale(1)','scale(1.07)','scale(1)'],
};
// 하나의 유한 시퀀스만 유지한다. 취소·지원 실패는 DOM과 타이머 데이터를 바꾸지 않는다.
export function createMotionPlayer() {
  let current=null;
  function cancel(){if(!current)return;const old=current;current=null;for(const animation of old.animations)animation.cancel();old.finish?.();}
  function play(action,row,geometry=null,onFinish) {
    cancel();
    if(typeof row.frame?.animate!=='function')return false;
    const entry={animations:[],finish:onFinish};current=entry;
    try {
      const add=(node,frames,duration)=>entry.animations.push(node.animate(frames,{duration,easing:'ease-in-out',iterations:1}));
      let movement=transforms[action];
      let duration=action==='start'?380:1400;
      if(action==='bounce'&&geometry){
        const x=geometry.travel,y=-geometry.hop;
        movement=['translate(0,0)',`translate(${x*.5}px,${y}px)`,`translate(${x}px,0)`,`translate(${x}px,0)`,`translate(${x*.5}px,${y}px)`,'translate(0,0)'];duration=2200;
      }
      if(action==='peek'&&geometry){
        movement=['translateX(0)',`translateX(${geometry.edge}px)`,`translateX(${geometry.edge}px)`,`translateX(${geometry.peek}px)`,`translateX(${geometry.edge}px)`,'translateX(0)'];duration=2800;
      }
      if(action==='dash'&&geometry){
        movement=['translateX(0)',`translateX(${geometry.edge}px)`,`translateX(${geometry.edge}px)`,`translateX(${geometry.edge}px)`,'translateX(0)'];duration=1800;
      }
      if(movement)add(row.frame,movement.map(transform=>({transform,zIndex:2})),duration);
      if(action==='start')add(row.gauge,[{opacity:1},{opacity:.45},{opacity:1}],600);
      if(action==='expire')add(row.frame,[{opacity:1,filter:'grayscale(0)'},{opacity:.7,filter:'grayscale(.5)'},{opacity:.4,filter:'grayscale(1)'}],650);
      if(action==='breathe')add(row.gauge,[{opacity:1},{opacity:.55},{opacity:1}],2500);
      if(!entry.animations.length){cancel();return false;}
      Promise.all(entry.animations.map(animation=>animation.finished)).then(()=>{if(current===entry){current=null;entry.finish?.();}},()=>{});
      return true;
    }catch{cancel();return false;}
  }
  return {play,cancel,get active(){return current!==null;}};
}
