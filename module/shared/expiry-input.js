// SPDX-License-Identifier: MPL-2.0
import { durationInput } from './duration-input.js';
import { remainingMs } from './timer-model.js';
export function localDateTime(timestamp) {
  const date = new Date(timestamp), pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
export function parseLocalDateTime(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return null;
  const date = new Date(value), time = date.getTime();
  return Number.isSafeInteger(time) && localDateTime(time) === (value.length === 16 ? `${value}:00` : value) ? time : null;
}
export function expiryInput(parent, timer) {
  let maximum=timer.durationMs, paused=timer.status==='paused', disabled=false;
  const element=document.createElement('fieldset');element.className='expiry-editor';
  const legend=document.createElement('legend');legend.textContent='시간 보정';element.append(legend);
  const mode=document.createElement('select');mode.setAttribute('aria-label','시간 입력 방식');
  for(const [value,text] of [['expires','만료 일시'],['remaining','남은 시간']]) {const o=document.createElement('option');o.value=value;o.textContent=text;mode.append(o);}
  const input=document.createElement('input');input.type='date';input.required=true;input.setAttribute('aria-label','만료 날짜');
  const time=document.createElement('input');time.type='time';time.step='1';time.required=true;time.setAttribute('aria-label','만료 시간 · PC 현지 시간');
  const readDate=()=>parseLocalDateTime(`${input.value}T${time.value}`);
  const quick=document.createElement('div');quick.className='expiry-quick';
  for(const [days,text] of [[0,'오늘'],[1,'내일']]) {const button=document.createElement('button');button.type='button';button.textContent=text;button.addEventListener('click',()=>{const date=new Date();date.setDate(date.getDate()+days);input.value=localDateTime(date.getTime()).slice(0,10);preview();});quick.append(button);}
  const dateWrap=document.createElement('div');dateWrap.className='expiry-date';dateWrap.append(input,time,quick);
  element.append(mode,dateWrap);
  const duration=durationInput(element,'남은 시간',remainingMs(timer,Date.now()),{maximum});duration.element.hidden=true;
  const hint=document.createElement('p');hint.className='muted expiry-hint';hint.setAttribute('aria-live','polite');element.append(hint);parent.append(element);
  function preview() {
    input.setCustomValidity('');
    if(mode.value!=='expires'){hint.textContent=paused?'일시정지를 유지하며 남은 시간을 저장합니다.':'';return;}
    const target=readDate(), delta=target===null?null:target-Date.now();
    if(delta===null){hint.textContent='날짜와 시간을 입력하세요.';return;}
    if(delta<0||delta>maximum){hint.textContent='현재부터 기본 기간 이내의 만료 일시를 입력하세요.';return;}
    const minutes=Math.floor(delta/60000);hint.textContent=`${Math.floor(minutes/1440)}일 ${Math.floor(minutes%1440/60)}시간 ${minutes%60}분 남음 · PC 현지 시간${paused?' · 저장 후에도 일시정지 유지':''}`;
  }
  function applyDisabled() {
    mode.disabled=disabled;
    for(const node of dateWrap.querySelectorAll('input,button'))node.disabled=disabled||mode.value!=='expires';
    duration.setDisabled(disabled||mode.value!=='remaining');
  }
  function setTimer(value) {paused=value.status==='paused';maximum=value.durationMs;const stamp=localDateTime(value.status==='running'?value.expiresAt:Date.now()+remainingMs(value,Date.now()));input.value=stamp.slice(0,10);time.value=stamp.slice(11);duration.setValue(remainingMs(value,Date.now()));preview();}
  mode.addEventListener('change',()=>{dateWrap.hidden=mode.value!=='expires';duration.element.hidden=mode.value!=='remaining';applyDisabled();preview();element.dispatchEvent(new Event('change',{bubbles:true}));});input.addEventListener('input',preview);time.addEventListener('input',preview);
  setTimer(timer);applyDisabled();
  return {element,setTimer,setMaximum(value){maximum=value;duration.setMaximum(value);},setDisabled(value){disabled=value;applyDisabled();},read(){
    if(mode.value==='remaining'){const value=duration.read();return value===null?null:{remainingMs:value};}
    const target=readDate(), delta=target===null?null:target-Date.now();
    if(delta===null||delta<0||delta>maximum){input.setCustomValidity('현재부터 기본 기간 이내의 만료 일시를 입력하세요.');input.reportValidity();return null;}
    input.setCustomValidity('');return {expiresAt:target};
  }};
}
