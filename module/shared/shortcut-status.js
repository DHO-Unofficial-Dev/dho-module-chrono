// SPDX-License-Identifier: MPL-2.0
// 구독을 먼저 연결하고 revision 역전 및 종료 뒤 완료를 무시한다.
export function observeShortcut(actions, actionId, onChange) {
  let closed=false, revision=-1, unsubscribe=null, attempt=0, subscribed=false, lastReady=null;
  const accept=snapshot=>{
    if(closed||!Number.isSafeInteger(snapshot?.revision)||snapshot.revision<revision||!Array.isArray(snapshot.shortcuts))return;
    revision=snapshot.revision;
    const shortcut=snapshot.shortcuts.find(value=>value.actionId===actionId)?.shortcut;
    lastReady={status:'ready',shortcut:typeof shortcut==='string'&&shortcut.trim()?shortcut:null};onChange(lastReady);
  };
  async function refresh() {
    if(closed)return;
    const current=++attempt, previous=revision;
    onChange({status:'loading'});
    try {
      if(!subscribed){
        const stop=await actions.subscribeShortcuts(accept);
        if(closed){stop();return;}
        if(subscribed)stop();else{unsubscribe=stop;subscribed=true;}
      }
      const snapshot=await actions.getShortcuts();
      if(!closed&&current===attempt){if(snapshot?.revision<revision&&lastReady)onChange(lastReady);else accept(snapshot);}
    }catch{
      if(!closed&&current===attempt&&revision===previous)onChange({status:'error'});
    }
  }
  return {start:refresh,refresh,close(){closed=true;attempt++;unsubscribe?.();unsubscribe=null;}};
}
