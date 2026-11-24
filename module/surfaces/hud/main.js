// SPDX-License-Identifier: MPL-2.0
import { storage, surface, actions } from '@dho/sdk';
import { TimerStore } from '../../shared/timer-store.js';
import { phase, remainingMs, formatRemaining } from '../../shared/timer-model.js';
import { renderTimeLabel, fitTimeLabel } from '../../shared/time-label.js';
import { durationInput } from '../../shared/duration-input.js';
import { createBlobReader } from '../../shared/blob-reader.js';
import { createRareScheduler, createMotionPlayer, nearExpiry } from '../../shared/hud-motion.js';
import { observeMotionPreview } from '../../shared/motion-preview.js';

const $ = id => document.getElementById(id);
const rows = new Map(), icons = new Map();
const reader = createBlobReader(storage);
let closed = false, selected = null, pending = false, menuPhase = '', menuTime, pauseButton, startButton, stopButton, editToggle, editInput;
let resizeRunning = false, desiredSize = null, appliedSize = '', resizeFrame = 0;
let revealTarget = null, revealFrame = 0;
let localError = '';
const motionPlayer=createMotionPlayer(), rareScheduler=createRareScheduler();
const reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)');
let touching=false, hovering=false, previewActive=false, motionSignature='', lastBreath=0;
function motionAllowed(force=false){return !closed&&store.ready&&!document.hidden&&store.state.groups[0].visible&&!selected&&!pending&&!touching&&!reducedMotion.matches&&(force||store.state.style.motion!==false);}
function stopMotion(){previewActive=false;motionPlayer.cancel();$('hud').dataset.motion='false';}
function rareRows(force=false){
  const now=Date.now();
  return store.state.groups[0].timerIds.map(id=>({timer:store.state.timers.find(t=>t.id===id),row:rows.get(id)})).filter(({timer,row})=>timer&&row?.art.querySelector('img')&&(force||(phase(timer,now)==='running'&&!nearExpiry(timer,now))));
}
function playRare(action,force=false){
  if(!motionAllowed(true)||(!force&&store.state.style.easterEggs===false))return false;
  const candidates=rareRows(force);if(!candidates.length)return false;
  const chosen=candidates[Math.floor(Math.random()*candidates.length)];
  const slot=chosen.row.node.getBoundingClientRect(),bounds=$('group').getBoundingClientRect();
  const width=store.state.style.size,left=Math.max(0,slot.left-bounds.left),right=Math.max(0,bounds.right-slot.left-width);
  const sign=right===left?(Math.random()<.5?-1:1):right>left?1:-1;
  const room=sign>0?right:left;
  const geometry={travel:sign*Math.min(Math.max(0,room-2),width+store.state.style.gap),edge:sign*(room+width+2),peek:sign*(room+width*.65),hop:Math.max(0,Math.min(12,slot.top-bounds.top-1))};
  const played=motionPlayer.play(action,chosen.row,geometry,()=>{previewActive=false;});
  previewActive=force&&played;
  if(played)rareScheduler.triggered(action);return played;
}
const motionPreview=observeMotionPreview(storage,action=>{stopMotion();for(const row of rows.values())row.pendingMotion=null;lastBreath=Date.now();if(action!=='stop')playRare(action,true);});
function updateMotion(){
  if(previewActive&&motionAllowed(true))return;
  const allowed=motionAllowed();$('hud').dataset.motion=String(allowed);
  if(!motionAllowed(true)){stopMotion();return;}
  if(!allowed)for(const row of rows.values())row.pendingMotion=null;
  for(const row of rows.values())if(row.pendingMotion){const action=row.pendingMotion;row.pendingMotion=null;motionPlayer.play(action,row);return;}
  const count=store.state.groups[0].timerIds.length;
  const rare=rareScheduler.next(!motionPlayer.active&&!hovering&&!$('hud').contains(document.activeElement)&&store.state.style.easterEggs!==false&&count>=2&&count<=4&&rareRows(true).length>=2&&rareRows().length>0);
  if(rare){playRare(rare);return;}
  if(allowed&&!motionPlayer.active&&Date.now()-lastBreath>=5000){
    const timer=store.state.timers.find(timer=>rows.has(timer.id)&&nearExpiry(timer,Date.now()));
    if(timer){lastBreath=Date.now();motionPlayer.play('breathe',rows.get(timer.id));}
  }
}

const errors = {
  'timer-conflict':'다른 화면에서 변경했습니다. 최신 상태를 확인하고 다시 시도하세요.',
  'storage-conflict':'다른 화면에서 저장 중입니다. 다시 시도하세요.',
  'storage-read-failed':'타이머를 읽지 못했습니다. 다시 읽기를 눌러 주세요.',
  'storage-subscribe-failed':'저장소 연결에 실패했습니다. 다시 읽기를 눌러 주세요.',
  'storage-write-failed':'저장하지 못했습니다. 다시 시도하세요.',
  'invalid-storage':'저장 데이터를 확인할 수 없습니다. 기존 데이터를 유지합니다.',
  'unsupported-schema':'다른 버전의 저장 데이터입니다. 기존 데이터를 유지합니다.',
};
const store = new TimerStore({ storage, onChange: render });
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function button(text, action) { const node = el('button', text); node.type = 'button'; node.addEventListener('click', action); return node; }
function notice(message) { localError = message; renderNotice(); }
function renderNotice() {
  const message = localError || (store.error && (errors[store.error] || '타이머 작업을 완료하지 못했습니다. 다시 시도하세요.'));
  const changed = message && ($('notice').hidden || $('message').textContent !== message);
  $('notice').hidden = !message; $('message').textContent = message || ''; $('retry').hidden = store.ready;
  if (changed) reveal($('notice'));
  scheduleSize();
}
function scheduleSize() {
  if (closed || resizeFrame) return;
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0;
    // 현재 Host viewport는 스크롤만 제한한다. 요청 크기는 내부 콘텐츠의 자연 크기로 계산한다.
    const bounds = $('content').getBoundingClientRect();
    desiredSize = { width: Math.min(1280, Math.max(40, Math.ceil(bounds.width))), height: Math.min(720, Math.max(40, Math.ceil(bounds.height))) };
    void resize();
  });
}
async function resize() {
  if (resizeRunning || closed) return;
  resizeRunning = true;
  try {
    while (desiredSize && !closed) {
      const size = desiredSize; desiredSize = null;
      const key = `${size.width}x${size.height}`;
      if (key === appliedSize) continue;
      try { await surface.setSize(size); appliedSize = key; }
      catch { appliedSize = key; notice('HUD 크기를 조절하지 못했습니다. HUD를 다시 열어 주세요.'); }
    }
  } finally {
    resizeRunning = false;
    revealAfterResize();
  }
}
function reveal(node) {
  revealTarget = node;
  scheduleSize();
}
function revealAfterResize() {
  if (closed || !revealTarget || revealFrame || resizeFrame || desiredSize) return;
  // 창 크기 응답 뒤 다음 레이아웃에서 한 번만 이동한다. 매초 갱신은 스크롤을 건드리지 않는다.
  revealFrame = requestAnimationFrame(() => {
    revealFrame = 0;
    if (closed || resizeRunning || resizeFrame || desiredSize) return;
    const node = revealTarget; revealTarget = null;
    if (node?.isConnected && node.getClientRects().length) node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  });
}
function releaseUnusedIcons(handles) {
  for (const [handle, entry] of icons) if (!handles.has(handle)) { icons.delete(handle); if (entry.url) URL.revokeObjectURL(entry.url); }
}
function loadIcon(handle) {
  if (!handle || icons.has(handle)) return;
  const entry = { url: null }; icons.set(handle, entry);
  void (async () => {
    try {
      const blob = await reader.read(handle, () => !closed && icons.get(handle) === entry);
      if (!blob || closed || icons.get(handle) !== entry || blob.info.mediaType !== 'image/png' || blob.bytes.byteLength > 40960) return;
      entry.url = URL.createObjectURL(new Blob([blob.bytes], { type: 'image/png' }));
      for (const row of rows.values()) if (row.handle === handle) paintIcon(row);
    } catch { /* 아이콘 손상은 이름·시간 표시를 막지 않는다. */ }
  })();
}
function paintIcon(row) {
  const url = icons.get(row.handle)?.url;
  row.art.replaceChildren();
  if (url) {
    const img = el('img'); img.alt = ''; img.draggable=false;
    img.addEventListener('error', () => {
      if (!closed && row.art.firstChild === img) row.art.textContent = row.name.slice(0, 1);
    }, { once: true });
    img.src = url; row.art.append(img);
  }
  else row.art.textContent = row.name.slice(0, 1);
}
function makeRow(timer) {
  const node = button('', () => {
    const current = store.state.timers.find(t => t.id === timer.id);
    if (!current || !store.ready || pending) return;
    const currentPhase=phase(current,Date.now());
    if(selected)closeMenu();
    void act(current.id,['idle','expired'].includes(currentPhase)?'start':currentPhase==='paused'?'resume':'pause');
  });
  node.className = 'timer';
  node.addEventListener('contextmenu',event=>{event.preventDefault();if(store.ready&&!pending&&store.state.timers.some(t=>t.id===timer.id))openMenu(timer.id);});
  const frame = el('span', undefined, 'frame'), art = el('span', undefined, 'art');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 80 80'); svg.setAttribute('aria-hidden', 'true');
  for (const name of ['track','gauge']) {
    const rect = document.createElementNS(svg.namespaceURI, 'rect');
    for (const [key,value] of Object.entries({x:3,y:3,width:74,height:74,rx:6,pathLength:100,class:name})) rect.setAttribute(key,String(value));
    svg.append(rect);
  }
  const paused=el('span','Ⅱ','pause-mark');paused.setAttribute('aria-hidden','true');frame.append(art, svg, paused); const label = el('span', undefined, 'remaining'); node.append(frame,label);
  return { node, frame, art, svg, gauge: svg.lastChild, label, handle: undefined, name: timer.name };
}
function render() {
  if (closed) return;
  const { groups, timers, style } = store.state, group = groups[0];
  const visible = group.visible && store.ready;
  const signature=JSON.stringify([groups,timers,style]);
  if(signature!==motionSignature){stopMotion();motionSignature=signature;}
  $('group').hidden = !visible;
  const root = $('hud');
  $('content').dataset.menuDirection=group.menuDirection??'bottom';
  root.style.setProperty('--size', `${style.size}px`); root.style.setProperty('--gap', `${style.gap}px`);
  root.style.setProperty('--time-size', `${style.timeSize}px`);
  root.style.setProperty('--gauge-stroke', `${style.thickness*80/style.size}px`); root.style.setProperty('--opacity', `${100-group.transparency}%`);
  $('group-name').textContent = group.name; $('group-name').title = group.name; $('group-name').hidden = !group.showName;
  const ids = new Set(group.timerIds);
  for (const [id,row] of rows) if (!ids.has(id)) { row.node.remove(); rows.delete(id); }
  const handles = new Set(group.timerIds.map(id => timers.find(t => t.id === id)?.item.iconHandle).filter(Boolean));
  releaseUnusedIcons(handles);
  for (const id of group.timerIds) {
    const timer = timers.find(t => t.id === id); if (!timer) continue;
    let row = rows.get(id); if (!row) { row = makeRow(timer); rows.set(id,row); }
    if (row.handle !== timer.item.iconHandle || row.name !== timer.name) { row.handle = timer.item.iconHandle; row.name = timer.name; loadIcon(row.handle); paintIcon(row); }
    row.svg.toggleAttribute('hidden', !style.gauge);
    $('timers').append(row.node);
  }
  const count = Math.min(group.count, Math.max(1, group.timerIds.length));
  $('timers').style.gridAutoFlow = group.direction === 'column' ? 'column' : 'row';
  $('timers').style.gridTemplateColumns = group.direction === 'row' ? `repeat(${count},var(--cell-size))` : 'none';
  $('timers').style.gridTemplateRows = group.direction === 'column' ? `repeat(${count},auto)` : 'none';
  $('empty').hidden = group.timerIds.length > 0;
  if (selected && (!visible || !ids.has(selected))) closeMenu();
  tick(); renderNotice();
}
function tick() {
  if (closed) return;
  const now = Date.now();
  for (const timer of store.state.timers) {
    const row = rows.get(timer.id); if (!row) continue;
    const current = phase(timer, now), label = formatRemaining(timer, now);
    const previous=row.node.dataset.phase;
    if(previous&&(previous!==current||(current==='running'&&row.runId!==timer.runId))){
      stopMotion();
      row.pendingMotion=current==='running'?'start':current==='expired'?'expire':null;
    }
    if(!store.state.groups[0].visible||document.hidden||reducedMotion.matches||store.state.style.motion===false)row.pendingMotion=null;
    row.runId=timer.runId;row.node.dataset.phase = current; row.node.disabled = !store.ready || pending;
    row.node.title = `${timer.name} · ${label}${current === 'paused' ? ' · 일시정지' : ''}`;
    row.node.setAttribute('aria-label', `${row.node.title} · ${['idle','expired'].includes(current) ? '시작' : current==='paused'?'재개':'일시정지'} · 우클릭으로 메뉴`);
    renderTimeLabel(row.label,label);
    fitTimeLabel(row.label,store.state.style.size+store.state.style.gap,store.state.style.timeSize);
    row.gauge.setAttribute('stroke-dasharray', `${Math.min(100,remainingMs(timer,now)/timer.durationMs*100)} 100`);
  }
  updateMenu(); updateMotion();
}
async function act(id, type, extra = {}) {
  const timer = store.state.timers.find(t => t.id === id);
  if (!timer || pending || !store.ready) return false;
  pending = true; localError = ''; tick(); renderNotice();
  const result = await store.dispatch({ type, id, expectedVersion: timer.version, ...extra });
  pending = false;
  if (closed) return result.ok;
  if (!result.ok) notice(errors[result.error?.code] || '입력값을 확인하고 다시 시도하세요.');
  else if (selected === id) closeMenu();
  tick(); renderNotice(); return result.ok;
}
function closeMenu() {
  const source = rows.get(selected)?.node;
  selected = null; menuPhase = ''; $('content').dataset.menuOpen='false'; $('menu').hidden = true; $('menu').replaceChildren();
  reveal(source ?? null);
}
function openMenu(id) {
  stopMotion();
  if(selected===id&&!$('menu').hidden)return;
  selected = id; menuPhase = ''; const timer = store.state.timers.find(t => t.id === id);
  $('content').dataset.menuOpen='true';
  const menu = $('menu'); menu.hidden = false; menu.replaceChildren();
  const header = el('header'), title = el('h2',timer.name); title.id = 'menu-title';
  header.append(title, button('닫기',closeMenu)); menuTime = el('p','', 'menu-time');
  const actions = el('div',undefined,'actions');
  pauseButton = button('', () => { const current = store.state.timers.find(t => t.id === selected); if (current) void act(current.id,current.status === 'paused' ? 'resume' : 'pause'); });
  stopButton = button('정지', () => void act(id,'stop'));
  const confirmation = el('div',undefined,'confirm'); confirmation.hidden = true;
  startButton = button('다시 시작', () => {
    const current = store.state.timers.find(t => t.id === id);
    if (!current) return;
    if (['idle','expired'].includes(phase(current,Date.now()))) { void act(id,'start'); return; }
    confirmation.hidden = false; reveal(confirmation);
  });
  confirmation.append(el('p','기본 기간으로 다시 시작할까요?'),button('다시 시작 확인', () => void act(id,'start')),button('취소', () => { confirmation.hidden = true; scheduleSize(); }));
  actions.append(pauseButton,startButton,stopButton);
  const separator = el('hr');
  let editOpened = false;
  const form = el('form',undefined,'edit'); form.id = 'remaining-editor'; form.hidden = true;
  editToggle = button('남은 시간 편집', () => {
    if(!editOpened){const current=store.state.timers.find(t=>t.id===id);if(current)editInput.setValue(remainingMs(current,Date.now()));editOpened=true;}
    form.hidden = !form.hidden; editToggle.setAttribute('aria-expanded',String(!form.hidden));
    if (!form.hidden) { reveal(form); form.querySelector('input')?.focus({preventScroll:true}); }
    else scheduleSize();
  });
  editToggle.className = 'edit-toggle'; editToggle.setAttribute('aria-label','남은 시간 편집'); editToggle.setAttribute('aria-controls',form.id); editToggle.setAttribute('aria-expanded','false');
  editInput = durationInput(form,'남은 시간',remainingMs(timer,Date.now()),{maximum:timer.durationMs});
  const save = el('button','적용'); save.type = 'submit'; save.className = 'primary'; form.append(save);
  form.addEventListener('submit', event => {
    event.preventDefault();const current=store.state.timers.find(t=>t.id===id);
    if(!current)return;
    editInput.setMaximum(current.durationMs);const ms=editInput.read();if(ms===null)return;
    void act(id,'edit',{remainingMs:ms});
  });
  menu.append(header,menuTime,actions,confirmation,separator,editToggle,form); updateMenu(); reveal(menu);
}
function updateMenu() {
  if (!selected) return;
  const timer = store.state.timers.find(t => t.id === selected);
  if (!timer) { closeMenu(); return; }
  const current = phase(timer,Date.now());
  $('menu-title').textContent = timer.name; menuTime.textContent = `${formatRemaining(timer,Date.now())}${current === 'paused' ? ' · 일시정지' : ''}`;
  pauseButton.hidden = !['running','paused'].includes(current);
  pauseButton.textContent = current === 'paused' ? '재개' : '일시정지';
  startButton.textContent = ['idle','expired'].includes(current) ? '시작' : '다시 시작';
  for (const node of $('menu').querySelectorAll('button,input')) node.disabled = pending || !store.ready;
  stopButton.disabled = pending || !store.ready || current === 'idle';
  editToggle.disabled = pending || !store.ready || current === 'idle';
  editInput.setDisabled(pending || !store.ready || current === 'idle');
  $('menu').querySelector('button[type="submit"]').disabled = pending || !store.ready || current === 'idle';
  editInput.setMaximum(timer.durationMs);
  if (menuPhase !== current) { menuPhase = current; scheduleSize(); }
}
document.addEventListener('contextmenu',event=>{if(!event.target.closest('input,textarea'))event.preventDefault();});
document.addEventListener('pointerdown',event=>{if(selected&&!event.target.closest('#menu,.timer'))closeMenu();});
$('retry').addEventListener('click', () => { localError = ''; void store.refresh(); });
$('dismiss').addEventListener('click', () => { localError = ''; $('notice').hidden = true; scheduleSize(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
const observer = new ResizeObserver(scheduleSize); observer.observe($('hud')); observer.observe($('content'));
const interval = setInterval(tick,1000);
document.addEventListener('pointerdown',()=>{touching=true;stopMotion();},true);
window.addEventListener('pointerup',()=>{touching=false;});
window.addEventListener('pointercancel',()=>{touching=false;});
window.addEventListener('blur',()=>{touching=false;stopMotion();});
$('hud').addEventListener('pointerenter',()=>{hovering=true;stopMotion();});
$('hud').addEventListener('pointerleave',()=>{hovering=false;});
document.addEventListener('keydown',stopMotion,true);
document.addEventListener('visibilitychange',()=>{stopMotion();for(const row of rows.values())row.pendingMotion=null;tick();});
reducedMotion.addEventListener('change',()=>{stopMotion();tick();});
void motionPreview.start();
let stopActions = null;
void actions.subscribe(invocation => {
  if (closed || invocation.actionId !== 'focus-hud') return;
  const target = !$('menu').hidden ? $('menu').querySelector('button:not(:disabled)') : $('timers').querySelector('button:not(:disabled)');
  target?.focus();
}).then(stop => { if (closed) stop(); else stopActions = stop; }).catch(() => {
  if (!closed) notice('HUD 단축키 연결에 실패했습니다. HUD를 다시 열어 주세요.');
});
window.addEventListener('pagehide', () => {
  closed = true; motionPreview.close(); stopMotion(); stopActions?.(); clearInterval(interval); cancelAnimationFrame(resizeFrame); cancelAnimationFrame(revealFrame); observer.disconnect(); store.close(); reader.close(); releaseUnusedIcons(new Set());
});
void store.start();
