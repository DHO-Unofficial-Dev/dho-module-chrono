// SPDX-License-Identifier: MPL-2.0
const SECOND = 1000;
const UNITS = [['days','일',86400,366],['hours','시',3600,23],['minutes','분',60,59],['seconds','초',1,59]];
export function splitDuration(milliseconds) {
  let seconds=Math.max(0,Math.ceil(milliseconds/SECOND));
  return UNITS.map(([, , unit])=>{const value=Math.floor(seconds/unit);seconds%=unit;return value;});
}
export function joinDuration(values) {
  if(values.length!==4||values.some((v,i)=>!Number.isInteger(v)||v<0||v>UNITS[i][3]))return null;
  return values.reduce((sum,value,i)=>sum+value*UNITS[i][2]*SECOND,0);
}
export function durationInput(parent, label, milliseconds, {minimum=0,maximum=366*86400000,disabled=false}={}) {
  const element=document.createElement('fieldset');element.className='duration-editor';
  const legend=document.createElement('legend');legend.textContent=label;element.append(legend);
  const grid=document.createElement('div');grid.className='duration-grid';element.append(grid);
  const values=splitDuration(milliseconds);
  const inputs=UNITS.map(([key,unit,,max],i)=>{
    const cell=document.createElement('label'),input=document.createElement('input');
    const suffix=document.createElement('span');suffix.textContent=['d','h','m','s'][i];suffix.setAttribute('aria-hidden','true');cell.className=i===0?'duration-days':'';input.type='number';input.min='0';input.max=String(max);input.step='1';input.required=true;input.value=String(values[i]);input.disabled=disabled;input.dataset.durationUnit=key;input.setAttribute('aria-label',`${label} ${unit}`);cell.append(input,suffix);grid.append(cell);return input;
  });
  const clearValidity=()=>inputs.forEach(input=>input.setCustomValidity(''));
  for(const input of inputs)input.addEventListener('input',clearValidity);
  parent.append(element);
  return {element,inputs,setDisabled(value){for(const input of inputs)input.disabled=value;},setMaximum(value){maximum=value;},setValue(ms){splitDuration(ms).forEach((value,i)=>{inputs[i].value=String(value);});clearValidity();},read(){
    clearValidity();if(!inputs.every(input=>input.reportValidity()))return null;
    const result=joinDuration(inputs.map(input=>input.value===''?NaN:Number(input.value)));
    if(result===null||result<minimum||result>maximum){inputs[3].setCustomValidity('허용된 기간 범위 안에서 입력해 주세요.');inputs[3].reportValidity();return null;}
    return result;
  }};
}
