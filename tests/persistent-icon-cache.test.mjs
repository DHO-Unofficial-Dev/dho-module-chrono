// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersistentIconCache } from '../module/shared/persistent-icon-cache.js';
import { createPresetBrowser } from '../module/shared/preset-browser.js';
import { createPicker } from '../module/shared/picker.js';
const png = generation => ({ok:true,result:{generation,mediaType:'image/png',width:32,height:32,base64:'AAAA'}});
function store() {
  const blobs = new Map(); let sequence = 0;
  return { blobs,
    async listBlobs() { return {items:[...blobs.values()].map(blob => blob.info),nextCursor:null}; },
    async putBlob(bytes, options) { const info = {handle:`blob:${++sequence}`,name:options.name,mediaType:options.mediaType,byteLength:bytes.byteLength,createdAtUnixMillis:sequence}; blobs.set(info.handle,{info,bytes}); return info; },
    async getBlob(handle) { if (!blobs.has(handle)) throw new Error('missing'); return blobs.get(handle); },
    async removeBlob(handle) { return {removed:blobs.delete(handle)}; },
    async batch() { throw new Error('KV 쓰기 금지'); },
  };
}
const load = (cache, id='item:1', generation='g1', provider='vault', fetch=()=>png(generation), current) => cache.load(provider,generation,id,fetch,current);

test('다시 만든 캐시는 blob을 복원하며 제공자·세대·아이콘 키를 분리한다',async()=>{
 const storage=store();let calls=0;const fetch=()=>{calls++;return png('g1');};
 await load(createPersistentIconCache({storage}),'item:1','g1','vault',fetch);
 const reopened=createPersistentIconCache({storage});assert.equal((await load(reopened,'item:1','g1','vault',fetch)).ok,true);assert.equal(calls,1);
 await load(reopened,'item:2','g1','vault',fetch);await load(reopened,'item:1','g1','other',fetch);await load(reopened,'item:1','g2','vault',()=>{calls++;return png('g2');});assert.equal(calls,4);
});
test('개수·바이트 상한을 적용하고 등록 사본은 정리하지 않는다',async()=>{
 const storage=store();const registered=await storage.putBlob(new Uint8Array(8),{name:'아이템 아이콘',mediaType:'image/png'});
 const cache=createPersistentIconCache({storage,maxEntries:2,maxBytes:400});
 for(let i=0;i<8;i++) await load(cache,`item:${i}`);
 const cached=[...storage.blobs.values()].filter(blob=>blob.info.name!=='아이템 아이콘');
 assert.ok(cached.length<=2);assert.ok(cached.reduce((sum,blob)=>sum+blob.info.byteLength,0)<=400);assert.ok(storage.blobs.has(registered.handle));
 assert.ok(cached.some(blob=>new TextDecoder().decode(blob.bytes).includes('item:7')));
});
test('손상 캐시·저장 실패·미지원 SDK에서도 원격 성공을 보존한다',async()=>{
 const storage=store();await load(createPersistentIconCache({storage}));
 storage.blobs.values().next().value.bytes=new TextEncoder().encode('{broken');
 let calls=0;const fetch=()=>{calls++;return png('g1');};
 assert.equal((await load(createPersistentIconCache({storage}),'item:1','g1','vault',fetch)).ok,true);assert.equal(calls,1);
 for(const broken of [{}, {...storage,listBlobs:async()=>{throw new Error('offline');}}, {...store(),putBlob:async()=>{throw new Error('quota');}}]) {
  assert.equal((await load(createPersistentIconCache({storage:broken}))).ok,true);
 }
});
test('실패 응답과 잘못된 세대는 저장하지 않는다',async()=>{
 const storage=store(),cache=createPersistentIconCache({storage});
 for(const response of [{ok:false,error:{code:'busy'}},png('old')]) await load(cache,'item:1','g1','vault',()=>response);
 assert.equal(storage.blobs.size,0);
});
test('대기 중 화면이 바뀌면 원격 조회와 저장을 시작하지 않는다',async()=>{
 let release,current=true,calls=0;const storage=store();
 storage.listBlobs=()=>new Promise(resolve=>release=()=>resolve({items:[],nextCursor:null}));
 const pending=load(createPersistentIconCache({storage}),'item:1','g1','vault',()=>{calls++;return png('g1');},()=>current);
 while(!release) await new Promise(resolve=>setImmediate(resolve));
 current=false;release();assert.equal((await pending).ok,false);assert.equal(calls,0);assert.equal(storage.blobs.size,0);
});
test('추천과 검색 화면 재개방은 같은 영속 아이콘을 사용한다',async()=>{
 const storage=store();let calls=0;
 const identity={providerModuleId:'vault',epoch:1},row={id:'item:1',name:'세계',iconRef:'item:1'};
 const client={identity:()=>identity,call:async method=>{
  if(method==='get-status') return {ok:true,result:{state:'ready'}};
  if(method==='search-items') return {ok:true,result:{generation:'g1',total:1,items:[row],nextOffset:null}};
  calls++;return png('g1');
 }};
 const browser=createPresetBrowser({client,onChange:()=>{},iconPersistence:createPersistentIconCache({storage})});
 await browser.load([{key:'world',name:'세계',query:'세계'}]);browser.close();assert.equal(calls,1);
 const picker=createPicker({client,save:()=>{},iconPersistence:createPersistentIconCache({storage})});
 await picker.refresh();assert.equal(picker.state.results[0].iconState,'ready');assert.equal(calls,1);picker.close();
});
test('정리 실패 때 상한을 넘겨 쓰지 않고 현재 원격 이미지는 제공한다',async()=>{
 const storage=store(),cache=createPersistentIconCache({storage,maxEntries:1});
 await load(cache);storage.removeBlob=async()=>{throw new Error('locked');};
 assert.equal((await load(cache,'item:2')).ok,true);assert.equal(storage.blobs.size,1);
});
test('여러 목록 페이지의 캐시를 찾고 같은 인스턴스의 동시 저장 상한을 지킨다',async()=>{
 const storage=store(),cache=createPersistentIconCache({storage,maxEntries:2});
 await Promise.all([load(cache,'item:1'),load(cache,'item:2'),load(cache,'item:3')]);assert.equal(storage.blobs.size,2);
 const values=[...storage.blobs.values()];let pages=0;
 storage.listBlobs=async({cursor})=>{pages++;return cursor?{items:[values[1].info],nextCursor:null}:{items:[values[0].info],nextCursor:'next'};};
 let calls=0;const record=JSON.parse(new TextDecoder().decode(values[1].bytes)),id=JSON.parse(record.key)[2];
 await load(createPersistentIconCache({storage}),id,'g1','vault',()=>{calls++;return png('g1');});assert.equal(calls,0);assert.equal(pages,2);
});
test('연속 blob 쓰기는 120ms 간격이며 캐시 읽기는 기다리지 않는다',async()=>{
 const storage=store(),waits=[];let clock=0;
 const cache=createPersistentIconCache({storage,now:()=>clock,wait:async ms=>{waits.push(ms);clock+=ms;}});
 await load(cache,'item:1');await load(cache,'item:2');await load(cache,'item:3');assert.deepEqual(waits,[120,120]);
 await load(cache,'item:1');assert.deepEqual(waits,[120,120]);
});

test('용량 교체의 삭제와 저장도 하나의 쓰기 간격을 공유한다',async()=>{
 const storage=store(),waits=[];let clock=0;
 const cache=createPersistentIconCache({storage,maxEntries:1,now:()=>clock,wait:async ms=>{waits.push(ms);clock+=ms;}});
 await load(cache,'item:1');await load(cache,'item:2');assert.deepEqual(waits,[120,120]);assert.equal(storage.blobs.size,1);
});
