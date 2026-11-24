// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresetBrowser } from '../module/shared/preset-browser.js';
const entry={key:'vault2',name:'선박 금고(No.2) 사용증(15일)',query:'선박 금고(No.2) 사용증(15일)'};
const row={id:'item:42',name:'선박 금고(NO.2) 사용증(15일)',iconRef:'item:42'};
const identity={providerModuleId:'app.dhoport.vault',epoch:1};
const page=items=>({ok:true,result:{generation:'g1',total:items.length,items,nextOffset:null}});
const image={ok:true,result:{generation:'g1',mediaType:'image/png',width:1,height:1,base64:'AAAA'}};
test('추천은 정확히 하나 일치할 때만 연결하고 아이콘을 재사용한다',async()=>{
 const calls=[];const browser=createPresetBrowser({client:{identity:()=>identity,call:async(method)=>{calls.push(method);return method==='search-items'?page([row]):image;}},onChange:()=>{}});
 await browser.load([entry]);assert.equal(browser.rows.get(entry.key).state,'ready');assert.equal(browser.rows.get(entry.key).item.id,row.id);assert.ok(browser.rows.get(entry.key).icon);
 await browser.load([entry]);assert.deepEqual(calls,['search-items','get-icon']);browser.close();
});
test('이름이 다르거나 중복 검색 결과이면 임의 ID를 고르지 않는다',async()=>{
 for(const items of [[{...row,name:'다른 아이템'}],[row,{...row,id:'item:43'}]]){
  let icons=0;const browser=createPresetBrowser({client:{identity:()=>identity,call:async method=>{if(method==='get-icon')icons++;return page(items);}},onChange:()=>{}});await browser.load([entry]);assert.equal(browser.rows.get(entry.key).state,'missing');assert.equal(icons,0);browser.close();
 }
});
test('리셋이나 제공자 변경 뒤 늦게 도착한 아이콘은 적용하지 않는다',async()=>{
 let release,current=identity;const gate=new Promise(r=>release=r);
 const browser=createPresetBrowser({client:{identity:()=>current,call:async method=>method==='search-items'?page([row]):gate},onChange:()=>{}});
 const pending=browser.load([entry]);await new Promise(r=>setImmediate(r));browser.reset();current={...identity,epoch:2};release(image);await pending;assert.equal(browser.rows.size,0);browser.close();
});
test('연결이 없으면 추천 아이콘을 얻으려고 요청하지 않는다',async()=>{
 let calls=0;const browser=createPresetBrowser({client:{identity:()=>null,call:async()=>{calls++;return page([]);}},onChange:()=>{}});await browser.load([entry]);assert.equal(calls,0);browser.close();
});

test('아이콘 수신 중 분류를 바꿨다가 돌아오면 누락 없이 재시도한다',async()=>{
 let release,requests=0;const gate=new Promise(r=>release=r);
 const browser=createPresetBrowser({client:{identity:()=>identity,call:async method=>method==='search-items'?page([row]):(++requests===1?gate:image)},onChange:()=>{}});
 const first=browser.load([entry]);await new Promise(r=>setImmediate(r));browser.cancel();release(image);await first;await browser.load([entry]);assert.ok(browser.rows.get(entry.key).icon);assert.equal(requests,2);browser.close();
});
test('잘못된 응답 행과 호출 실패는 다음 항목이나 재시도를 막지 않는다',async()=>{
 let bad=true;const browser=createPresetBrowser({client:{identity:()=>identity,call:async method=>bad?page([null]):method==='search-items'?page([row]):image},onChange:()=>{}});
 await browser.load([entry]);assert.equal(browser.rows.get(entry.key).state,'failed');bad=false;await browser.load([entry]);assert.equal(browser.rows.get(entry.key).state,'ready');browser.close();
});
test('명시적 새로 확인은 동일 세대의 추천·아이콘을 유지하고 새 세대만 다시 읽는다',async()=>{
 let generation='g1';const calls=[];
 const browser=createPresetBrowser({client:{identity:()=>identity,call:async method=>{
  calls.push(method);
  if(method==='get-status')return {ok:true,result:{state:'ready',generation}};
  if(method==='search-items')return {ok:true,result:{...page([row]).result,generation}};
  return {ok:true,result:{...image.result,generation}};
 }},onChange:()=>{}});
 await browser.load([entry]);await browser.load([entry],{refresh:true});
 assert.deepEqual(calls,['search-items','get-icon','get-status']);
 generation='g2';await browser.load([entry],{refresh:true});
 assert.equal(browser.rows.get(entry.key).icon.generation,'g2');assert.deepEqual(calls.slice(3),['get-status','search-items','get-icon']);browser.close();
});
test('새로 확인 실패나 도중 취소는 오래된 추천을 새 결과로 표시하지 않는다',async()=>{
 let status={ok:false},release;
 const browser=createPresetBrowser({client:{identity:()=>identity,call:async method=>method==='get-status'?status:method==='search-items'?page([row]):image},onChange:()=>{}});
 await browser.load([entry]);await browser.load([entry],{refresh:true});assert.equal(browser.rows.size,0);
 await browser.load([entry]);status=new Promise(resolve=>release=resolve);
 const refreshing=browser.load([entry],{refresh:true});browser.reset();release({ok:true,result:{state:'ready',generation:'g2'}});await refreshing;assert.equal(browser.rows.size,0);browser.close();
});
