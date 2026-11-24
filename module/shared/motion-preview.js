// SPDX-License-Identifier: MPL-2.0
export const MOTION_PREVIEW_KEY = 'timer.motion-preview.v1';
export const MOTION_ACTIONS = ['bounce','look','nod','nudge','peek','dash'];
export async function requestMotionPreview(storage, action) {
  if (![...MOTION_ACTIONS,'stop'].includes(action)) throw new Error('invalid-motion-action');
  const command = { id: crypto.randomUUID(), action, expiresAt: Date.now() + 5000 };
  for (let attempt=0; attempt<3; attempt++) {
    const snapshot = await storage.getSnapshot();
    try { await storage.batch({ expectedRevision:snapshot.revision, operations:[{kind:'set',key:MOTION_PREVIEW_KEY,value:command}] }); return; }
    catch(error) { if(error.code!=='storage.conflict'||attempt===2)throw error; }
  }
}
// 시작 snapshot은 재생하지 않는다. 다른 키 변경으로 같은 명령이 재전달돼도 한 번만 처리한다.
export function observeMotionPreview(storage, onCommand, now=Date.now) {
  let closed=false, armed=false, revision=-1, lastId=null, stop=null;
  const accept = snapshot => {
    if(closed||!Number.isSafeInteger(snapshot?.revision)||snapshot.revision<=revision)return;
    revision=snapshot.revision;
    const command=snapshot.values?.[MOTION_PREVIEW_KEY];
    if(!command||typeof command.id!=='string'||command.id===lastId)return;
    lastId=command.id;
    if(armed&&[...MOTION_ACTIONS,'stop'].includes(command.action)&&Number.isFinite(command.expiresAt)&&command.expiresAt>now()&&command.expiresAt<=now()+5000)onCommand(command.action);
  };
  return {
    async start(){
      try {
        const unsubscribe=await storage.subscribe(accept);
        if(closed){unsubscribe();return;}
        stop=unsubscribe;
        accept(await storage.getSnapshot());
        if(!closed)armed=true;
      }catch{stop?.();stop=null;}
    },
    close(){closed=true;armed=false;stop?.();stop=null;}
  };
}
