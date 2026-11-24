import test from 'node:test';
import assert from 'node:assert/strict';
import {observeShortcut} from '../module/shared/shortcut-status.js';
test('단축키 구독의 최신 revision은 늦은 snapshot보다 우선한다',async()=>{
  let listener,resolve,stopped=false;const states=[];
  const observer=observeShortcut({subscribeShortcuts:async fn=>{listener=fn;return()=>stopped=true;},getShortcuts:()=>new Promise(r=>resolve=r)},'focus-hud',s=>states.push(s));
  const start=observer.start();await Promise.resolve();
  listener({revision:3,shortcuts:[{actionId:'focus-hud',shortcut:'Ctrl+Shift+T'}]});
  resolve({revision:2,shortcuts:[]});await start;
  assert.equal(states.at(-1).shortcut,'Ctrl+Shift+T');
  listener({revision:4,shortcuts:[]});assert.equal(states.at(-1).shortcut,null);
  observer.close();assert.equal(stopped,true);
});
test('읽기 실패는 미지정과 구분하고 재시도한다',async()=>{
  let fail=true;const states=[];
  const observer=observeShortcut({subscribeShortcuts:async()=>()=>{},getShortcuts:async()=>{if(fail)throw Error();return{revision:0,shortcuts:[]};}},'focus-hud',s=>states.push(s));
  await observer.start();assert.equal(states.at(-1).status,'error');fail=false;await observer.refresh();assert.equal(states.at(-1).status,'ready');assert.equal(states.at(-1).shortcut,null);observer.close();
});
test('종료 뒤 늦게 연결된 구독도 해제한다',async()=>{
  let resolve,stopped=false;const states=[];
  const observer=observeShortcut({subscribeShortcuts:()=>new Promise(r=>resolve=r)},'focus-hud',s=>states.push(s));
  const start=observer.start();observer.close();resolve(()=>stopped=true);await start;assert.equal(stopped,true);assert.equal(states.length,1);
});
