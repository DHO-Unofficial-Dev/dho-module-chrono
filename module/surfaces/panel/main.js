// SPDX-License-Identifier: MPL-2.0
import { services, storage, actions } from '@dho/sdk';
import { removeCachedItem } from '../../shared/cache-control.js';
import { ItemStore } from '../../shared/item-store.js';
import { TimerStore } from '../../shared/timer-store.js';
import { remainingMs, phase, formatRemaining } from '../../shared/timer-model.js';
import { renderTimeLabel, fitTimeLabel } from '../../shared/time-label.js';
import { expiryInput } from '../../shared/expiry-input.js';
import { suggestedTimerKind } from '../../shared/timer-kind.js';
import { registrationCommand } from '../../shared/registration.js';
import { createPresetBrowser } from '../../shared/preset-browser.js';
import { PRESETS, CATEGORIES } from '../../shared/presets.js';
import { createServiceClient, serviceFailure } from '../../shared/service-client.js';
import { createPicker } from '../../shared/picker.js';
import { durationInput, splitDuration, joinDuration } from '../../shared/duration-input.js';
import { requestMotionPreview } from '../../shared/motion-preview.js';
import { observeShortcut } from '../../shared/shortcut-status.js';
import { createPersistentIconCache } from '../../shared/persistent-icon-cache.js';
import { createBlobReader } from '../../shared/blob-reader.js';
const $ = id => document.getElementById(id);
const timerControls = $('timer-controls');
let closed = false, debounce, rowsToken = '', lastDetail = null, lastSaveResult = null, registerButton = null;
let cachedSelection = null, kindSelectionId = null;
let registrationGroupId = null, controlSequence = 0;
let timerDrag = null, lastMotionSettings = null, linkingId = null;
let preset = null, selectedId = null, pending = false, controlsPhase = null;
let category = '전체', adding = false, selectingPreset = 0;
const rows = new Map(), iconUrls = new Map();
const blobReader = createBlobReader(storage);
const iconPersistence = createPersistentIconCache({storage});
const errors = {'cache-missing':'보관 사본이 삭제되었습니다. Vault에서 아이템을 다시 선택하세요.', 'cache-in-use':'사용 중인 타이머를 먼저 삭제한 뒤 보관 사본을 삭제하세요.', 'timer-conflict':'다른 화면에서 이 타이머를 변경했습니다. 최신 상태를 확인하고 다시 시도하세요.', 'storage-conflict':'다른 화면에서 저장 중입니다. 다시 시도하세요.', 'invalid-storage':'저장 데이터 또는 입력값을 확인할 수 없습니다. 기존 데이터를 유지합니다.', 'storage-write-failed':'저장하지 못했습니다. 다시 시도하세요.', 'storage-read-failed':'저장 목록을 읽지 못했습니다. 다시 읽기를 눌러 주세요.', 'unsupported-schema':'다른 버전의 저장 데이터입니다. 기존 데이터를 유지합니다.', 'invalid-registration':'기간·남은 시간·만료 시각을 확인하세요. 남은 시간은 기본 기간 이하여야 합니다.'};
function storageError(code) { return errors[code] || '작업을 완료하지 못했습니다. 입력값과 저장 상태를 확인하고 다시 시도하세요.'; }
function saveNotice(result) { if (!closed) $('save-status').textContent = result.ok ? `타이머를 등록했습니다.${result.warning ? ' 아이콘 없이 이름과 설명을 보관했습니다.' : ''}` : storageError(result.error?.code); }
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function button(text, action) { const node = el('button', text); if(/저장|등록|적용/.test(text))node.classList.add('primary');else if(/삭제/.test(text))node.classList.add('danger'); node.type = 'button'; node.addEventListener('click', action); return node; }
function field(parent, title, value, type = 'text') { const label = el('label', title), input = el('input'); input.type = type; if(type === 'checkbox') input.checked = value; else input.value = value; label.append(input); parent.append(label); return input; }
async function dispatch(command, message = '저장했습니다.') { const result = await timerStore.dispatch(command); if (!closed) $('save-status').textContent = result.ok ? message : storageError(result.error?.code); return result; }
function command(timer, type, extra = {}) { return { type, id: timer.id, expectedVersion: timer.version, ...extra }; }
const itemStore = new ItemStore({ storage, onChange: () => { renderSaved(); updateRegister(); } });
const timerStore = new TimerStore({ storage, onChange: renderRuntime });
const client = createServiceClient(services, { onBinding(ready, message) { if (closed) return; cancelPendingSelection(); if(adding)showStep(false); presetBrowser.reset(); picker.clearCache(); if (ready && adding) { void picker.refresh(); void loadPresets(); } else if (!ready) picker.disconnect(message); } });
const picker = createPicker({ client, iconPersistence, save: async (metadata, icon) => {
  let draft; try { draft = registrationInput(metadata); registrationCommand({ ...draft, item: { ...metadata, iconHandle: null } }); } catch { return {ok:false,error:{code:'invalid-registration'}}; }
  const result = await itemStore.add(metadata, icon);
  if (!result.ok || closed) return result;
  const item = itemStore.items.find(item => item.id === metadata.id && item.providerModuleId === metadata.providerModuleId);
  const saved = await registerItem(item, draft); return {...saved, warning: result.warning};
}, onChange: renderPicker });
const presetBrowser = createPresetBrowser({client,iconPersistence,onChange:renderPresets});
function samePresetItem(item) { return preset && item?.name.replace(/\s/g, '').toLowerCase() === preset.name.replace(/\s/g, '').toLowerCase(); }
function clearRegistrationSelection() { cachedSelection = null; lastDetail = null; registerButton = null; $('detail').replaceChildren(); $('item-description').textContent = ''; updateRegister(); }
function cancelPendingSelection() {
  selectingPreset++; clearTimeout(debounce); presetBrowser.cancel();
  clearRegistrationSelection(); picker.invalidateSearch();
}
function registrationInput(item) { if (!item || !timerStore.state.groups.some(group=>group.id===registrationGroupId) || (preset && !samePresetItem(item))) throw new Error('invalid-registration'); return { groupId: registrationGroupId, name: $('alias').value.trim() || undefined, kind: $('timer-kind').value, durationMs:joinDuration(['days','hours','minutes','seconds'].map(id=>$(id).value===''?NaN:Number($(id).value))), mode: $('mode').value, remainingMs:joinDuration(['remaining-days','remaining-hours','remaining-minutes','remaining-seconds'].map(id=>$(id).value===''?NaN:Number($(id).value))), expiresAt: new Date($('expires').value).getTime() }; }
async function registerItem(item, draft) { try { draft ??= registrationInput(item); const cmd = registrationCommand({...draft,item}); cmd.cacheRegistrationId = item.registrationId; return await timerStore.dispatch(cmd); } catch { return {ok:false,error:{code:'invalid-registration'}}; } }
function setDuration(ms) { splitDuration(ms).forEach((value,i)=>{$(['days','hours','minutes','seconds'][i]).value=String(value);}); }
function resetPreset() { kindSelectionId=null; $('timer-kind').value='item'; preset = null; setDuration(0); for (const id of ['days','hours','minutes','seconds']) $(id).disabled = false; $('kind-note').textContent = '일반 아이템 · 1분부터 366일까지 직접 입력하세요.'; }
function applyPresetTo(name) { if (!preset) return; if (name.replace(/\s/g,'').toLowerCase() !== preset.name.replace(/\s/g,'').toLowerCase()) { resetPreset(); return; } $('timer-kind').value=preset.kind; setDuration(preset.durationMs); for (const id of ['days','hours','minutes','seconds']) $(id).disabled = preset.kind === 'tarot'; $('kind-note').textContent = preset.kind === 'tarot' ? '타롯 · 3시간 고정 · 수동 일시정지' : '추천 기간을 적용했습니다. 실제 아이템 설명을 확인하세요.'; }
function image(icon) {
  const img = document.createElement('img'); img.alt = ''; img.src = `data:image/png;base64,${icon.base64}`;
  img.width = icon.width; img.height = icon.height; return img;
}
function updateRegister() {
  const detail = cachedSelection || picker.state.detail;
  $('submit-timer').disabled = !itemStore.ready || !timerStore.ready || !detail?.id || detail.iconState === 'loading' || picker.state.saving || pending;
  $('submit-timer').textContent = picker.state.saving || pending ? '등록 중…' : '타이머 등록';
}
function showStep(configure) {
  $('select-step').hidden = configure; $('configure-step').hidden = !configure;
  $('add-step').textContent = configure ? '타이머 설정 · 2 / 2' : '아이템 선택 · 1 / 2';
}
function showTab(name) {
  clearTimerDrag();
  adding = name === 'register'; if(!adding)cancelPendingSelection();
  for (const id of ['register','timers','groups']) $(`tab-${id}`).hidden = id !== name;
  for (const tab of document.querySelectorAll('[data-tab]')) tab.setAttribute('aria-pressed',String(tab.dataset.tab === name));
}
function openAdd(groupId=timerStore.state.groups[0]?.id) {
  if(!timerStore.ready||!timerStore.state.groups.some(group=>group.id===groupId))return;
  registrationGroupId=groupId;
  cancelPendingSelection(); resetPreset(); $('alias').value=''; $('query').value=''; $('mode').value='idle';
  $('remaining-field').hidden=true; $('expires-field').hidden=true; $('search-results').hidden=true;
  $('presets').hidden=false;showTab('register'); showStep(false); renderPresets(); void picker.refresh(); void loadPresets(true);
}
function setRegistrationKind(kind) {
  $('timer-kind').value=kind;
  if(kind==='tarot')setDuration(10800000);
  for(const id of ['days','hours','minutes','seconds'])$(id).disabled=kind==='tarot';
  $('kind-note').textContent=kind==='tarot'?'타롯 · 3시간 · 수동 일시정지 가능':'일반 아이템 · 일시정지 없이 만료 일시까지 계산합니다.';
}
$('timer-kind').addEventListener('change',()=>setRegistrationKind($('timer-kind').value));
function showSelected(item, icon) {
  if(kindSelectionId!==item.id){kindSelectionId=item.id;setRegistrationKind(preset?.kind ?? suggestedTimerKind(item));}
  const heading=el('div',undefined,'detail-heading'), imageSlot=el('span','—','icon');
  if(icon)imageSlot.replaceChildren(image(icon)); else if(item.iconHandle)void attachIcon(imageSlot,item.iconHandle);
  heading.append(imageSlot,el('h3',item.name)); $('detail').replaceChildren(heading);
  $('item-description').textContent=item.description || '등록된 설명이 없습니다.';
  showStep(true); updateRegister();
}
function chooseCached(item) {
  cancelPendingSelection(); cachedSelection=item;
  preset=PRESETS.find(entry=>entry.name.replace(/\s/g,'').toLowerCase()===item.name.replace(/\s/g,'').toLowerCase()) || null;
  if(preset)applyPresetTo(item.name);else resetPreset(); showSelected(item,null);
}
function durationLabel(ms) {return ms>=86400000 ? `${ms/86400000}일` : `${ms/3600000}시간`;}
function visiblePresets() {return PRESETS.filter(entry=>category==='전체'||entry.category===category);}
async function loadPresets(refresh=false) { if(adding)await presetBrowser.load(visiblePresets(),{refresh}); }
function renderPresets() {
  if(closed)return; $('presets').replaceChildren();
  for(const entry of visiblePresets()) {
    const data=presetBrowser.rows.get(entry.key), row=button('',async()=>{
      cancelPendingSelection();resetPreset();preset=entry;
      presetBrowser.cancel(); const token=++selectingPreset; $('query').value=entry.query; $('search-results').hidden=false;
      await picker.search(entry.query);
      if(closed||token!==selectingPreset||!adding)return;
      const matches=picker.state.results.filter(item=>item.name.replace(/\s/g,'').toLowerCase()===entry.name.replace(/\s/g,'').toLowerCase());
      if(data?.state==='ready'&&matches.length===1&&matches[0].id===data.item.id)await picker.select(matches[0]);
      else if(picker.state.available) $('connection-status').textContent='검색 결과에서 실제 아이템을 확인하고 선택하세요.';
    }); row.className='preset-row';row.disabled=!picker.state.available;
    const icon=el('span',data?.state==='loading'?'·':'—','icon');if(data?.icon)icon.replaceChildren(image(data.icon));
    const text=el('span',undefined,'item-copy');text.append(el('span',data?.item?.name || entry.name),el('small',data?.state==='missing'?'검색해서 선택':entry.category));
    row.append(icon,text,el('span',durationLabel(entry.durationMs),'duration-tag'));$('presets').append(row);
  }
}
function renderPicker(state) {
  if (closed) return;
  $('query').disabled = !state.available;
  $('connection-status').textContent = state.message;
  $('vault-connection').dataset.available=String(state.available);
  $('connection-help').hidden=state.available;
  for(const row of $('presets').querySelectorAll('button'))row.disabled=!state.available;
  $('previous').disabled = !state.available || state.offset === 0;
  $('next').disabled = !state.available || state.nextOffset === null;
  $('result-count').textContent = state.results.length ? `${state.total}개 중 ${state.offset + 1}–${state.offset + state.results.length}` : '';
  const token = state.results.map(item => `${item.identity.epoch}:${item.generation}:${item.id}`).join('|');
  if (token !== rowsToken) { rowsToken = token; rows.clear(); $('search-items').replaceChildren(); }
  for (const item of state.results) {
    let row = rows.get(item.id);
    if (!row) {
      const li = document.createElement('li'), button = document.createElement('button'), icon = document.createElement('span'), name = document.createElement('span');
      button.type = 'button'; button.className = 'result-button'; icon.className = 'icon'; name.textContent = item.name;
      button.append(icon, name); li.append(button); $('search-items').append(li);
      button.addEventListener('click', () => { const latest = picker.state.results.find(candidate => candidate.id === item.id); if (latest) { selectingPreset++;clearTimeout(debounce);presetBrowser.cancel();void picker.select(latest); } });
      row = { button, icon, rendered: undefined }; rows.set(item.id, row);
    }
    row.button.setAttribute('aria-pressed', String(state.detail?.id === item.id));
    if (row.rendered !== item.iconState) { row.rendered = item.iconState; if (item.icon) row.icon.replaceChildren(image(item.icon)); else row.icon.textContent = item.iconState === 'loading' ? '·' : '—'; }
  }
  if (lastDetail !== state.detail) {
    const changedItem = state.detail?.id && state.detail.id !== lastDetail?.id;
    lastDetail = state.detail; registerButton = null; cachedSelection = null;
    if (changedItem) applyPresetTo(state.detail.name);
    const detail = state.detail;
    if (!detail) $('detail').textContent = '검색 결과에서 아이템을 선택하세요.';
    else if (detail.loading) $('detail').textContent = '아이템 설명을 읽고 있습니다.';
    else if (detail.error) $('detail').textContent = detail.error;
    else { showSelected(detail,detail.icon);
    }
  }
  updateRegister();
  if (state.saveResult && state.saveResult !== lastSaveResult) { lastSaveResult = state.saveResult; saveNotice(state.saveResult); if(state.saveResult.ok)showTab('timers'); }
}
async function attachIcon(target, handle, retries=1) {
  if (!handle || closed) return;
  let promise = iconUrls.get(handle);
  if (!promise) { promise = (async () => { try { const blob = await blobReader.read(handle, () => !closed); if (!blob || closed || blob.info.mediaType !== 'image/png' || blob.bytes.byteLength > 40960) return null; return URL.createObjectURL(new Blob([blob.bytes], {type:'image/png'})); } catch { return null; } })(); iconUrls.set(handle,promise); }
  const retry=()=>{if(retries>0&&!closed&&target.isConnected)setTimeout(()=>{if(!closed&&target.isConnected)void attachIcon(target,handle,retries-1);},300);};
  const url = await promise;
  if (!url) {if(iconUrls.get(handle)===promise)iconUrls.delete(handle);retry();return;}
  if (closed || !target.isConnected || iconUrls.get(handle)!==promise) return;
  const img = el('img'); img.alt = ''; img.draggable=false;
  img.addEventListener('error',()=>{
    if(target.firstChild!==img)return;
    target.textContent='—';
    if(iconUrls.get(handle)===promise){iconUrls.delete(handle);URL.revokeObjectURL(url);}
    retry();
  },{once:true});
  img.src = url;target.replaceChildren(img);
}
function renderSaved() {
  if (closed) return;
  const usedHandles = new Set([...itemStore.items.map(item => item.iconHandle), ...timerStore.state.timers.map(timer => timer.item.iconHandle)]);
  for (const [handle, promise] of iconUrls) if (itemStore.ready && timerStore.ready && !usedHandles.has(handle)) { iconUrls.delete(handle); void promise.then(url => { if (url) URL.revokeObjectURL(url); }); }
  $('cached-picks').replaceChildren(); $('cached-picks-section').hidden = !itemStore.items.length;
  $('saved-count').textContent = `(${itemStore.items.length})`; $('saved-items').replaceChildren();
  if(itemStore.error) $('save-status').textContent = storageError(itemStore.error);
  for(const item of itemStore.items) { const row = el('li',undefined,'saved-row'), icon = el('span','—','icon'); const choose = el('span',item.name,'item-copy'); const remove = button('보관 사본 삭제', async () => {
      remove.disabled = true;
      let result;
      try { result = await removeCachedItem(storage, item.registrationId); }
      catch { result = {ok:false,error:{code:'storage-write-failed'}}; }
      if (closed) return;
      if (result.ok && cachedSelection?.registrationId === item.registrationId) clearRegistrationSelection();
      $('save-status').textContent = result.ok ? `보관 사본을 삭제했습니다.${result.warning ? ' 남은 아이콘 파일을 정리하지 못했습니다.' : ''}` : storageError(result.error?.code);
      if (!result.ok) remove.disabled = !itemStore.ready || !timerStore.ready || timerStore.state.timers.some(timer => timer.item.id === item.id && timer.item.providerModuleId === item.providerModuleId);
    });
    const inUse = timerStore.state.timers.some(timer => timer.item.id === item.id && timer.item.providerModuleId === item.providerModuleId);
    remove.disabled = inUse || !itemStore.ready || !timerStore.ready;
    if (inUse) remove.title = '사용 중인 타이머를 먼저 삭제한 뒤 보관 사본을 삭제하세요.';
    row.append(icon,choose,remove);$('saved-items').append(row);void attachIcon(icon,item.iconHandle); const pick=button('',()=>chooseCached(item));pick.className='preset-row';const pickIcon=el('span','—','icon');pick.append(pickIcon,el('span',item.name,'item-copy'));const pickLi=el('li');pickLi.append(pick);$('cached-picks').append(pickLi);void attachIcon(pickIcon,item.iconHandle); }
  $('storage-retry').hidden = itemStore.ready && timerStore.ready;
}
function renderRuntime() {
  if(closed) return;
  $('storage-retry').hidden = itemStore.ready && timerStore.ready;
  if(timerStore.error) $('save-status').textContent=storageError(timerStore.error);
  $('legacy-group-note').hidden=timerStore.state.groups.length<2;
  renderTimers(); renderGroups(); renderSaved(); updateRegister();
  const motionSettings=JSON.stringify([timerStore.state.style.motion,timerStore.state.style.easterEggs]);
  if(lastMotionSettings!==motionSettings){
    lastMotionSettings=motionSettings;
    $('motion-enabled').checked=timerStore.state.style.motion;
    $('eggs-enabled').checked=timerStore.state.style.easterEggs;
  }
  $('save-motion').disabled=!timerStore.ready;
}
function actionIcon(control, kind, label) {
  const paths={pause:'M6 4v16M18 4v16',stop:'M5 5h14v14H5z',play:'m7 4 13 8-13 8z',restart:'M4 9a8 8 0 1 1 0 6M4 3v6h6'};
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
  const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',paths[kind]);svg.append(path);control.replaceChildren(svg);control.title=label;control.setAttribute('aria-label',label);
}
function renderQuickActions(timer, entry) {
  const actions=entry.querySelector('.timer-quick'), notice=entry.querySelector('.timer-confirmation');
  const currentPhase=phase(timer,Date.now());entry.dataset.phase=currentPhase;actions.replaceChildren();
  {
    const pause=button(currentPhase==='paused'?'재개':'일시정지',()=>void dispatch(command(timer,currentPhase==='paused'?'resume':'pause')));
    actionIcon(pause,currentPhase==='paused'?'play':'pause',currentPhase==='paused'?'재개':'일시정지');
    pause.disabled=!['running','paused'].includes(currentPhase)||!timerStore.ready;if(timer.kind==='tarot'||currentPhase==='paused')actions.append(pause);
  }
  const stop=button('정지',()=>void dispatch(command(timer,'stop')));actionIcon(stop,'stop','정지');stop.disabled=currentPhase==='idle'||!timerStore.ready;
  const start=button(currentPhase==='idle'?'시작':'다시 시작',()=>{
    if(['idle','expired'].includes(phase(timer,Date.now()))) {void dispatch(command(timer,'start'),'타이머를 시작했습니다.');return;}
    notice.replaceChildren(el('p','남은 시간을 지우고 기본 기간으로 다시 시작할까요?'));
    notice.append(button('다시 시작 확인',()=>void dispatch(command(timer,'start'))),button('취소',()=>{notice.hidden=true;actions.querySelector('[data-timer-action="start"]')?.focus();}));notice.hidden=false;
  });actionIcon(start,currentPhase==='idle'?'play':'restart',currentPhase==='idle'?'시작':'다시 시작');start.dataset.timerAction='start';start.disabled=!timerStore.ready;actions.append(stop,start);
}
function toggleTimerSettings(id) {linkingId=null;renderLinks();selectedId=selectedId===id?null:id;renderControls();}
function clearDragIndicators() {
  for(const entry of document.querySelectorAll('.timer-entry[data-drop-position]')) delete entry.dataset.dropPosition;
}
function clearTimerDrag() {
  const previous=timerDrag;timerDrag=null;previous?.cleanup?.();clearDragIndicators();document.body.classList.remove('timer-reordering');
  for(const entry of document.querySelectorAll('.timer-entry.dragging')) entry.classList.remove('dragging');
}
function dragDestination(event, groupId, targetId, entry) {
  if(!timerDrag||!timerStore.ready||timerDrag.groupId!==groupId||timerDrag.id===targetId)return null;
  const group=timerStore.state.groups.find(g=>g.id===groupId),timer=timerStore.state.timers.find(t=>t.id===timerDrag.id);
  if(!group||!timer||timer.version!==timerDrag.version||group.timerIds.join(',')!==timerDrag.order)return null;
  const sourceIndex=group.timerIds.indexOf(timerDrag.id),targetIndex=group.timerIds.indexOf(targetId);
  if(sourceIndex<0||targetIndex<0)return null;
  const rect=entry.getBoundingClientRect(),after=event.clientY>=rect.top+rect.height/2;
  // move는 원본을 먼저 제거하므로 그 뒤의 삽입 인덱스로 보정한다.
  const boundary=targetIndex+(after?1:0),index=boundary-(sourceIndex<boundary?1:0);
  return {index,sourceIndex,position:after?'after':'before'};
}
function createDragHandle(timer, group, entry) {
  let suppressClick=false;
  const handle=button('',()=>{if(suppressClick){suppressClick=false;return;}toggleTimerSettings(timer.id);});
  handle.className='timer-drag-handle';
  handle.title='끌어서 순서 변경 · 클릭하면 위로/아래로 조작 열기';
  handle.setAttribute('aria-label',`${timer.name} 순서 변경: 끌어서 이동하거나 클릭 후 위로·아래로 버튼 사용`);
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 12 20');svg.setAttribute('aria-hidden','true');
  for(const x of [3,9])for(const y of [4,10,16]){const dot=document.createElementNS('http://www.w3.org/2000/svg','circle');dot.setAttribute('cx',String(x));dot.setAttribute('cy',String(y));dot.setAttribute('r','1');svg.append(dot);}handle.append(svg);
  handle.disabled=!timerStore.ready;
  handle.addEventListener('dragstart',event=>event.preventDefault());
  handle.addEventListener('pointerdown',event=>{
    if(event.button!==0||!event.isPrimary||!timerStore.ready)return;
    clearTimerDrag();suppressClick=false;
    const current=timerStore.state.timers.find(t=>t.id===timer.id),currentGroup=timerStore.state.groups.find(g=>g.id===group.id);
    if(!current||!currentGroup?.timerIds.includes(timer.id))return;
    const pointerId=event.pointerId,startX=event.clientX,startY=event.clientY;
    let moving=false;
    const destinationAt=e=>{
      const target=document.elementFromPoint(e.clientX,e.clientY)?.closest('.timer-entry');
      if(!target)return null;
      const targetGroup=timerStore.state.groups.find(g=>g.timerIds.includes(target.dataset.timerId));
      const destination=dragDestination(e,targetGroup?.id,target.dataset.timerId,target);
      return destination?{...destination,target}:null;
    };
    const move=e=>{
      if(e.pointerId!==pointerId||!timerDrag)return;
      if(!moving&&Math.hypot(e.clientX-startX,e.clientY-startY)<5)return;
      moving=true;suppressClick=true;e.preventDefault();entry.classList.add('dragging');document.body.classList.add('timer-reordering');
      // 패널 가장자리에서는 스크롤하며 같은 그룹의 먼 항목까지 이동한다.
      if(e.clientY<48)window.scrollBy(0,-18);else if(e.clientY>innerHeight-48)window.scrollBy(0,18);
      clearDragIndicators();const destination=destinationAt(e);
      if(destination)destination.target.dataset.dropPosition=destination.position;
    };
    const end=e=>{
      if(e.pointerId!==pointerId)return;
      const source=timerDrag,destination=moving?destinationAt(e):null;
      clearTimerDrag();
      if(!source||!destination||destination.index===destination.sourceIndex)return;
      void dispatch({type:'move',id:source.id,expectedVersion:source.version,targetId:source.groupId,index:destination.index,expectedOrder:source.order.split(',')},'타이머 순서를 저장했습니다.');
    };
    const cancel=()=>clearTimerDrag();
    const key=e=>{if(e.key==='Escape'){e.preventDefault();cancel();}};
    const cleanup=()=>{
      window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);window.removeEventListener('pointercancel',cancel);window.removeEventListener('blur',cancel);window.removeEventListener('keydown',key);handle.removeEventListener('lostpointercapture',cancel);
      if(handle.hasPointerCapture(pointerId))handle.releasePointerCapture(pointerId);
    };
    timerDrag={id:timer.id,groupId:group.id,version:current.version,order:currentGroup.timerIds.join(','),cleanup};
    window.addEventListener('pointermove',move,{passive:false});window.addEventListener('pointerup',end);window.addEventListener('pointercancel',cancel);window.addEventListener('blur',cancel);window.addEventListener('keydown',key);handle.addEventListener('lostpointercapture',cancel);
    handle.setPointerCapture(pointerId);
  });
  return handle;
}
function renderTimers() {
  clearTimerDrag();
  // 목록을 다시 그려도 설정 표면의 DOM 참조는 유지한다.
  timerControls.hidden=true;$('tab-timers').append(timerControls);$('timer-list').replaceChildren();
  for(const group of timerStore.state.groups) {const section=el('section',undefined,'timer-group');section.append(el('h3',`${group.name}${group.visible?'':' · 숨김 설정'}`));
    for(const id of group.timerIds) {
      const timer=timerStore.state.timers.find(t=>t.id===id), entry=el('div',undefined,'timer-entry');entry.dataset.timerId=id;
      entry.addEventListener('contextmenu',event=>{if(event.target.closest('input,textarea'))return;event.preventDefault();if(selectedId!==id||timerControls.hidden){selectedId=id;renderControls();}});
      const header=el('div',undefined,'timer-card-heading');
      const row=button('',async()=>{const p=phase(timer,Date.now());if(p==='idle'||p==='expired')await dispatch(command(timer,'start'),'타이머를 시작했습니다.');else toggleTimerSettings(id);});row.className='timer-row';
      const icon=el('span','—','icon'),name=el('span',timer.name),time=el('strong');time.dataset.timerTime=id;const copy=el('span',undefined,'timer-copy');name.className='timer-name';name.title=timer.name;const remaining=el('span',undefined,'timer-remaining'),bar=el('span',undefined,'timer-bar'),fill=el('span');bar.setAttribute('aria-hidden','true');bar.append(fill);remaining.append(bar,time);copy.append(name,remaining);row.append(icon,copy);
      const settings=button('⋯',()=>toggleTimerSettings(id));settings.className='timer-menu';settings.setAttribute('aria-label',`${timer.name} 설정 펼치기`);settings.setAttribute('aria-expanded',String(selectedId===id));settings.setAttribute('aria-controls','timer-controls');
      const linked=timerStore.state.startLinks.find(ids=>ids.includes(id));
      const link=button('',()=>{selectedId=null;renderControls();linkingId=linkingId===id?null:id;renderLinks();});link.className='timer-link';link.dataset.linkTimer=id;link.setAttribute('aria-label',`${timer.name} 동시 시작 연결`);link.setAttribute('aria-pressed',String(Boolean(linked)));link.title=linked?`동시 시작 연결 · ${linked.length}개`:'동시 시작 연결';link.disabled=!timerStore.ready;
      const chain=document.createElementNS('http://www.w3.org/2000/svg','svg');chain.setAttribute('viewBox','0 0 24 24');chain.setAttribute('aria-hidden','true');const path=document.createElementNS(chain.namespaceURI,'path');path.setAttribute('d','M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2');chain.append(path);link.append(chain);
      const quick=el('div',undefined,'timer-quick'),notice=el('div',undefined,'timer-confirmation');notice.hidden=true;
      header.append(createDragHandle(timer,group,entry),row,quick,link,settings);entry.append(header,notice);renderQuickActions(timer,entry);section.append(entry);void attachIcon(icon,timer.item.iconHandle);
    }
    const add=button('＋ 아이템 추가',()=>openAdd(group.id));add.className='add-item-card';add.dataset.groupId=group.id;add.setAttribute('aria-label',`${group.name}에 아이템 추가`);add.disabled=!timerStore.ready;section.append(add);
    $('timer-list').append(section);
  }
  updateTimes();renderControls();renderLinks();
}
function renderLinks() {
  for(const panel of document.querySelectorAll('.link-editor'))panel.remove();
  for(const button of document.querySelectorAll('.timer-link'))button.setAttribute('aria-expanded',String(button.dataset.linkTimer===linkingId));
  const timer=timerStore.state.timers.find(t=>t.id===linkingId);
  if(!timer){linkingId=null;return;}
  const entry=[...document.querySelectorAll('.timer-entry')].find(e=>e.dataset.timerId===timer.id);if(!entry)return;
  const members=timerStore.state.startLinks.find(ids=>ids.includes(timer.id))??[timer.id];
  const panel=el('section',undefined,'link-editor');panel.setAttribute('aria-label',`${timer.name} 동시 시작 연결 설정`);
  panel.append(el('h3','함께 시작할 아이템'),el('p','대기·만료된 항목만 각자의 기본 기간으로 시작합니다. 실행 중·일시정지 항목은 유지합니다.','muted'));
  const choices=el('div',undefined,'link-choices');
  for(const other of timerStore.state.timers){
    if(other.id===timer.id)continue;
    const foreign=timerStore.state.startLinks.some(ids=>ids!==members&&ids.includes(other.id));
    const row=el('label',undefined,'link-choice'),check=el('input');check.type='checkbox';check.value=other.id;check.checked=members.includes(other.id);check.disabled=foreign;
    const group=timerStore.state.groups.find(g=>g.timerIds.includes(other.id));
    row.append(check,el('span',`${other.name} · ${group?.name??''}${foreign?' · 다른 연결에 포함':''}`));choices.append(row);
  }
  panel.append(choices);
  if(timerStore.state.timers.length<2)panel.append(el('p','아이템을 하나 더 등록하면 연결할 수 있습니다.','muted'));
  const save=button('연결 저장',async()=>{const ids=[...choices.querySelectorAll('input:checked')].map(input=>input.value);const result=await dispatch(command(timer,'link-start',{ids}),'동시 시작 연결을 저장했습니다.');if(result.ok){linkingId=null;renderLinks();}});
  save.disabled=!timerStore.ready;
  const unlink=button('이 항목 연결 해제',async()=>{const result=await dispatch(command(timer,'link-start',{ids:[]}),'연결을 해제했습니다.');if(result.ok){linkingId=null;renderLinks();}});unlink.disabled=members.length<2||!timerStore.ready;
  const buttons=el('div',undefined,'link-buttons');buttons.append(save,unlink,button('닫기',()=>{linkingId=null;renderLinks();}));panel.append(buttons);entry.append(panel);
}
function updateTimes() {
  for(const node of document.querySelectorAll('[data-timer-time]')) {const timer=timerStore.state.timers.find(t=>t.id===node.dataset.timerTime);if(!timer)continue;const now=Date.now(),currentPhase=phase(timer,now);
    node.textContent=formatRemaining(timer,now);node.title=`${node.textContent}${currentPhase==='paused'?' · 일시정지':''}`;
    const entry=node.closest('.timer-entry'),ratio=currentPhase==='idle'?0:Math.max(0,Math.min(1,remainingMs(timer,now)/timer.durationMs));
    entry.querySelector('.timer-bar>span').style.width=`${ratio*100}%`;
    entry.querySelector('.timer-remaining').title=currentPhase==='idle'?'시작 전':`${node.title} · 기본 기간의 ${Math.round(ratio*100)}% 남음`;
    if(entry.dataset.phase!==currentPhase)renderQuickActions(timer,entry);}
  const selected=timerStore.state.timers.find(t=>t.id===selectedId);if(selected&&phase(selected,Date.now())!==controlsPhase)renderControls();
}
function renderControls() {
  const panel=timerControls,timer=timerStore.state.timers.find(t=>t.id===selectedId);
  const entry=[...document.querySelectorAll('.timer-entry')].find(e=>e.dataset.timerId===selectedId);
  panel.hidden=!timer||!entry;panel.replaceChildren();controlsPhase=timer?phase(timer,Date.now()):null;
  for(const card of document.querySelectorAll('.timer-entry')) {const open=Boolean(timer&&entry&&card===entry);card.classList.toggle('settings-open',open);card.querySelector('.timer-menu').setAttribute('aria-expanded',String(open));}
  if(!timer||!entry){selectedId=null;return;}
  entry.append(panel);panel.append(el('h3','타이머 설정'));
  if(timer.status!=='idle') {const editor=expiryInput(panel,timer);panel.append(button('시간 보정 저장',()=>{const patch=editor.read();if(patch)void dispatch(command(timer,'edit',patch));}));}
  if(timer.kind==='item'&&timer.status==='paused')panel.append(el('p','이전 버전에서 일시정지한 항목입니다. 재개 후에는 다시 일시정지할 수 없습니다.','muted'));
  const kindLabel=el('label','종류'),kind=el('select');for(const [value,text]of [['item','일반 아이템'],['tarot','타롯 · 일시정지 가능']]){const option=el('option',text);option.value=value;kind.append(option);}kind.value=timer.kind;kindLabel.append(kind);panel.append(kindLabel);
  const kindSave=button('종류 저장',()=>{const next=kind.value;void dispatch(command(timer,'settings',{patch:{kind:next,...(next==='tarot'?{durationMs:10800000,alerts:{...timer.alerts,leadMinutes:timer.alerts.leadMinutes.filter(v=>v<=180)}}:{})}}));});
  const updateKind=()=>{kindSave.disabled=kind.value==='tarot'&&timer.durationMs!==10800000&&!['idle','expired'].includes(phase(timer,Date.now()));};kind.addEventListener('change',updateKind);updateKind();panel.append(kindSave,el('p','타롯은 3시간입니다. 다른 기간으로 실행 중인 항목은 정지 후 타롯으로 바꿀 수 있습니다.','muted'));
  const name=field(panel,'별명',timer.name);name.maxLength=120;
  const locked=timer.status!=='idle'||timer.kind==='tarot';
  const duration=durationInput(panel,'기본 기간',timer.durationMs,{minimum:60000,disabled:locked});
  panel.append(button('이름·기간 저장',()=>{const ms=locked?timer.durationMs:duration.read();if(ms===null)return;void dispatch(command(timer,'settings',{patch:{name:name.value.trim(),...(locked?{}:{durationMs:ms})}}));}));
  const group=timerStore.state.groups.find(g=>g.timerIds.includes(timer.id));
  const index=group.timerIds.indexOf(timer.id);
  const up=button('위로',()=>void dispatch({type:'move',id:timer.id,expectedVersion:timer.version,targetId:group.id,index:index-1}));
  const down=button('아래로',()=>void dispatch({type:'move',id:timer.id,expectedVersion:timer.version,targetId:group.id,index:index+1}));
  up.disabled=index===0;down.disabled=index===group.timerIds.length-1;
  panel.append(up,down,button('타이머 삭제',()=>void dispatch(command(timer,'remove'))));
}
document.addEventListener('contextmenu',event=>{if(!event.target.closest('input,textarea'))event.preventDefault();});
function compactSlider(input,min,max,step,label,unit='',onChange=()=>{}) {
  const old=input.parentElement,row=el('div',undefined,'slider-setting'),caption=el('label',label==='시간 글자 크기'?'글자 크기':label),value=el('div',undefined,'slider-value');
  input.id=`chrono-setting-${++controlSequence}`;input.setAttribute('aria-label',label);caption.htmlFor=input.id;
  input.required=true;input.min=String(min);input.max=String(max);input.step=String(step);
  const range=el('input');range.type='range';range.min=String(min);range.max=String(max);range.step=String(step);range.value=input.value;range.setAttribute('aria-label',`${label} 슬라이더`);
  value.append(input);if(unit)value.append(el('span',unit));row.append(caption,range,value);old.replaceWith(row);
  range.addEventListener('input',()=>{input.value=range.value;onChange();});
  input.addEventListener('input',()=>{if(input.value!==''&&input.validity.valid){range.value=input.value;onChange();}});
  input.addEventListener('focus',()=>input.select());
}
function renderGroups() {
  $('group-list').replaceChildren();
  for(const group of timerStore.state.groups.slice(0,1)) {
    const section=el('section',undefined,'detail');const name=field(section,'그룹 이름',group.name);name.maxLength=100;
    const visible=field(section,'표시',group.visible,'checkbox'),showName=field(section,'그룹 이름 표시',group.showName,'checkbox');
    const transparency=field(section,'배경 투명도 (%)',group.transparency,'number'),count=field(section,'줄당 개수',group.count,'number');
    compactSlider(transparency,0,100,1,'배경 투명도','%');compactSlider(count,1,8,1,'줄당 개수');
    const direction=el('select');direction.setAttribute('aria-label','배치 방향');for(const [value,text] of [['row','가로'],['column','세로']]){const option=el('option',text);option.value=value;direction.append(option);}direction.value=group.direction;
    const menuLabel=el('label','HUD 메뉴 방향'),menuDirection=el('select');menuDirection.setAttribute('aria-label','HUD 메뉴 방향');
    for(const [value,text] of [['top','위'],['bottom','아래'],['left','왼쪽'],['right','오른쪽']]){const option=el('option',text);option.value=value;menuDirection.append(option);}
    menuDirection.value=group.menuDirection??'bottom';menuLabel.append(menuDirection);const directionLabel=el('label','아이콘 배치 방향');directionLabel.append(direction);const directionHelp=el('p',undefined,'muted');const updateDirectionHelp=()=>{directionHelp.textContent=direction.value==='row'?'가로로 나열하며, 줄당 개수는 한 행의 아이콘 수입니다.':'세로로 나열하며, 줄당 개수는 한 열의 아이콘 수입니다.';};direction.addEventListener('change',updateDirectionHelp);updateDirectionHelp();section.append(directionLabel,directionHelp,menuLabel);
    section.append(button('그룹 설정 저장',()=>{if(!transparency.reportValidity()||!count.reportValidity())return;void dispatch({type:'group-update',id:group.id,patch:{name:name.value.trim(),visible:visible.checked,showName:showName.checked,transparency:Number(transparency.value),count:Number(count.value),direction:direction.value,menuDirection:menuDirection.value}});}));
    $('group-list').append(section);
  }
  renderStyleForm();
}
function renderStyleForm() {
  const form=$('style-form');form.replaceChildren();const style=timerStore.state.style;
  const preview=el('div',undefined,'style-preview'),strip=el('div',undefined,'style-preview-items');
  preview.append(el('p','HUD 미리보기','muted'),strip);form.append(preview);
  const samples=[['2h17m',.76],['7d17h',.25],['23h17m',.08]];
  for(const [index,[time,ratio]] of samples.entries()) {
    const item=timerStore.state.timers[index]?.item??itemStore.items[index],tile=el('div',undefined,'style-preview-tile'),frame=el('div',undefined,'style-preview-frame'),art=el('span','—','style-preview-art');
    tile.title=item?.name??'예시 아이템';frame.append(art);
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 100 100');svg.setAttribute('aria-hidden','true');
    for(const kind of ['track','fill']){const rect=document.createElementNS('http://www.w3.org/2000/svg','rect');for(const [key,value] of Object.entries({x:4,y:4,width:92,height:92,rx:8,pathLength:100}))rect.setAttribute(key,String(value));rect.setAttribute('class',kind);if(kind==='fill'){rect.setAttribute('stroke-dasharray',`${ratio*100} 100`);}svg.append(rect);}
    const label=el('span',undefined,'style-preview-time');renderTimeLabel(label,time);
    frame.append(svg);tile.append(frame,label);strip.append(tile);void attachIcon(art,item?.iconHandle);
  }
  form.append(el('p','크기·간격·선 두께·시간 글자 크기를 바로 확인하세요. 시간과 배치는 예시이며, 저장 버튼을 눌러야 적용됩니다.','muted'));
  const size=field(form,'아이콘 크기 (32–80)',style.size,'number'),gap=field(form,'간격 (0–24)',style.gap,'number'),thickness=field(form,'선 두께 (0.5–3)',style.thickness,'number'),timeSize=field(form,'시간 글자 크기 (10–20)',style.timeSize??12,'number'),gauge=field(form,'시간 게이지 표시',style.gauge,'checkbox');
  const controls=[[size,32,80,1,'아이콘 크기'],[gap,0,24,1,'간격'],[thickness,.5,3,.5,'선 두께'],[timeSize,10,20,1,'시간 글자 크기']];
  const update=()=>{if(!controls.every(([input])=>input.value!==''&&input.validity.valid))return;for(const [key,input] of [['size',size],['gap',gap],['thickness',thickness],['time-size',timeSize]])if(input.value!==''&&input.validity.valid)preview.style.setProperty(`--preview-${key}`,`${input.value}px`);preview.style.setProperty('--preview-gauge-stroke',`${Number(thickness.value)*100/Number(size.value)}px`);preview.classList.toggle('no-gauge',!gauge.checked);for(const label of preview.querySelectorAll('.style-preview-time'))fitTimeLabel(label,Number(size.value)+Number(gap.value),Number(timeSize.value));};
  for(const [input,min,max,step,label] of controls)compactSlider(input,min,max,step,label,'',update);
  gauge.addEventListener('change',update);update();
  form.append(button('공통 배치 저장',()=>{if(!controls.every(([input])=>input.reportValidity()))return;void dispatch({type:'style',patch:{size:Number(size.value),gap:Number(gap.value),thickness:Number(thickness.value),timeSize:Number(timeSize.value),gauge:gauge.checked}});}));
}
for(const name of ['전체',...CATEGORIES]) {const chip=button(name,()=>{cancelPendingSelection();resetPreset();category=name;$('query').value='';$('search-results').hidden=true;$('presets').hidden=false;for(const node of $('categories').children)node.setAttribute('aria-pressed',String(node===chip));renderPresets();void loadPresets();});chip.setAttribute('aria-pressed',String(name===category));$('categories').append(chip);}
for(const tab of document.querySelectorAll('[data-tab]'))tab.addEventListener('click',()=>showTab(tab.dataset.tab));
$('close-add').addEventListener('click',()=>showTab('timers'));
$('back-select').addEventListener('click',()=>{cancelPendingSelection();showStep(false);renderPresets();void loadPresets();});
$('submit-timer').addEventListener('click',async()=>{
  if(pending)return;
  if(cachedSelection){const item=cachedSelection;pending=true;updateRegister();const result=await registerItem(item);pending=false;if(closed)return;saveNotice(result);updateRegister();if(result.ok)showTab('timers');}
  else await picker.register();
});
$('mode').addEventListener('change',()=>{$('remaining-field').hidden=$('mode').value!=='remaining';$('expires-field').hidden=$('mode').value!=='expires';});
$('query').addEventListener('input',()=>{cancelPendingSelection();resetPreset();$('search-results').hidden=false;$('presets').hidden=Boolean($('query').value.trim());if(!$('presets').hidden){renderPresets();void loadPresets();}debounce=setTimeout(()=>void picker.search($('query').value),300);});
$('previous').addEventListener('click',()=>{const offset=Math.max(0,picker.state.offset-20);cancelPendingSelection();void picker.search($('query').value,offset);});
$('next').addEventListener('click',()=>{if(picker.state.nextOffset!==null){const offset=picker.state.nextOffset;cancelPendingSelection();void picker.search($('query').value,offset);}});
$('retry').addEventListener('click',()=>{cancelPendingSelection();void picker.refresh().then(()=>{if(!closed)void loadPresets(true);});});
$('storage-retry').addEventListener('click',async()=>{const results=await Promise.all([itemStore.refresh(),timerStore.refresh()]);if(!closed)$('save-status').textContent=results.every(r=>r.ok)?'저장 목록을 다시 읽었습니다.':'저장 목록을 읽지 못했습니다. 기존 데이터를 유지합니다.';});
$('hide-motion-settings').addEventListener('click',()=>{$('motion-settings').open=false;});
$('save-motion').addEventListener('click',async()=>{
  const result=await dispatch({type:'style',patch:{motion:$('motion-enabled').checked,easterEggs:$('eggs-enabled').checked}},'모션 설정을 저장했습니다.');
  if(!closed){$('save-status').textContent='';$('motion-status').textContent=result.ok?'모션 설정을 저장했습니다.':storageError(result.error?.code);}
});
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
function showReducedMotion(){if(!closed)$('motion-reduced-note').hidden=!reducedMotion.matches;}
reducedMotion.addEventListener('change',showReducedMotion);showReducedMotion();
let previewPending=false;
async function previewEgg(action){
  if(previewPending||closed)return;
  previewPending=true;$('play-egg').disabled=true;$('stop-egg').disabled=true;
  try{await requestMotionPreview(storage,action);if(!closed)$('motion-status').textContent=action==='stop'?'연출 종료를 요청했습니다.':reducedMotion.matches?'시스템의 동작 줄이기가 켜져 있어 재생하지 않습니다.':'HUD에 실행을 요청했습니다. 표시된 HUD의 아이콘을 확인하세요.';}
  catch{if(!closed)$('motion-status').textContent='연출 요청을 전달하지 못했습니다. 다시 시도해 주세요.';}
  finally{previewPending=false;if(!closed){$('play-egg').disabled=false;$('stop-egg').disabled=false;}}
}
$('play-egg').addEventListener('click',()=>void previewEgg($('egg-action').value));
$('stop-egg').addEventListener('click',()=>void previewEgg('stop'));
const shortcutObserver=observeShortcut(actions,'focus-hud',state=>{
  if(closed)return;
  $('shortcut-value').textContent=state.status==='ready'?(state.shortcut||'미지정'):state.status==='loading'?'확인 중…':'확인 실패';
  $('shortcut-help').textContent=state.status==='error'?'현재 단축키를 읽지 못했습니다. 다시 확인하거나 Navigator 설정 → 모듈 → Chrono에서 확인해 주세요.':state.status==='loading'?'':state.shortcut?'단축키는 Navigator 설정 → 모듈 → Chrono에서 변경할 수 있습니다.':'Navigator 설정 → 모듈 → Chrono에서 HUD 조작 단축키를 설정해 주세요. 권장: Ctrl+Shift+T · 중복되면 다른 조합을 선택하세요.';
  $('shortcut-retry').hidden=state.status!=='error';
});
$('shortcut-retry').addEventListener('click',()=>void shortcutObserver.refresh());
void shortcutObserver.start();
const tick=setInterval(updateTimes,1000);
addEventListener('pagehide',()=>{closed=true;reducedMotion.removeEventListener('change',showReducedMotion);shortcutObserver.close();clearTimeout(debounce);clearInterval(tick);for(const promise of iconUrls.values())void promise.then(url=>{if(url)URL.revokeObjectURL(url);});iconUrls.clear();blobReader.close();itemStore.close();timerStore.close();picker.close();presetBrowser.close();client.close();},{once:true});
await Promise.allSettled([itemStore.start(),timerStore.start(),client.start().catch(error=>{if(!closed)picker.disconnect(serviceFailure(error?.code).error.message);})]);
if(!closed&&itemStore.ready&&timerStore.ready)$('save-status').textContent='';
