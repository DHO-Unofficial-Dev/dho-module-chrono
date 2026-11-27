// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GROUP_ID, createState, validateState, reduce, remainingMs, phase, formatRemaining } from '../module/shared/timer-model.js';
const MINUTE = 60000;
const SECOND_GROUP_ID = '00000000-0000-4000-8000-000000000002';
const fixture = (patch = {}) => ({ id: crypto.randomUUID(), version: 1,
  item: { providerModuleId: 'test.vault', id: 'item:1', name: '아이템', description: '', iconHandle: null },
  name: '타이머', kind: 'item', durationMs: MINUTE, status: 'idle', expiresAt: null,
  remainingMs: null, runId: null, alerts: { toast: true, sound: false, leadMinutes: [] }, ...patch });
const add = (timer = fixture(), state = createState()) => reduce(state, { type: 'add', timer, groupId: DEFAULT_GROUP_ID }, 1000);
const act = (state, type, patch = {}, now = 1000) => reduce(state, { type, id: state.timers[0].id,
  expectedVersion: state.timers[0].version, ...patch }, now);
const invalid = fn => assert.throws(fn, { code: 'invalid-storage' });

test('기본 상태와 검증 사본은 원본을 공유하지 않는다', () => {
  const state = add(); const clean = validateState(state);
  clean.groups[0].timerIds.pop(); clean.timers[0].item.name = '수정'; clean.timers[0].alerts.leadMinutes.push(1);
  assert.equal(state.groups[0].timerIds.length, 1); assert.equal(state.timers[0].item.name, '아이템');
  assert.deepEqual(state.timers[0].alerts.leadMinutes, []);
  assert.throws(() => validateState({ ...state, schemaVersion: 2 }), { code: 'unsupported-schema' });
});
test('같은 아이템은 별도 인스턴스로 등록되고 ID 중복은 거부한다', () => {
  const state = add(); assert.equal(add(fixture(), state).timers.length, 2);
  invalid(() => add(state.timers[0], state));
});
test('기간 경계와 타로 고정 기간을 검증한다', () => {
  for (const durationMs of [MINUTE, 366 * 86400000]) assert.equal(add(fixture({ durationMs })).timers[0].durationMs, durationMs);
  for (const durationMs of [0, MINUTE - 1, 366 * 86400000 + 1, NaN, Infinity]) invalid(() => add(fixture({ durationMs })));
  invalid(() => add(fixture({ kind: 'tarot' })));
  assert.equal(add(fixture({ kind: 'tarot', durationMs: 180 * MINUTE })).timers.length, 1);
});
test('시작·만료·정지와 실행 ID는 시간을 저장하지 않고 계산한다', () => {
  const idle = add(); const running = act(idle, 'start');
  assert.equal(idle.timers[0].version, 1); assert.equal(running.timers[0].version, 2);
  assert.equal(remainingMs(running.timers[0], 1100), 59900);
  assert.equal(formatRemaining(running.timers[0], 1100), '1m0s');
  assert.equal(phase(running.timers[0], 61000), 'expired');
  assert.equal(remainingMs(running.timers[0], 999999), 0);
  const restart = act(running, 'start'); assert.notEqual(restart.timers[0].runId, running.timers[0].runId);
  const stopped = act(restart, 'stop'); assert.equal(stopped.timers[0].status, 'idle');
  assert.equal(stopped.timers[0].runId, null); assert.equal(stopped.timers[0].durationMs, MINUTE);
});
test('타로 일시정지는 저장 복원·편집·재개에서 유지한다', () => {
  const state = act(add(fixture({ kind: 'tarot', durationMs: 180 * MINUTE })), 'start');
  const paused = act(state, 'pause', {}, 2000);
  const restored = validateState(JSON.parse(JSON.stringify(paused)));
  assert.equal(remainingMs(restored.timers[0], 99999999), 180 * MINUTE - 1000);
  const edited = act(restored, 'edit', { remainingMs: MINUTE }); assert.equal(edited.timers[0].status, 'paused');
  const resumed = act(edited, 'resume', {}, 9000); assert.equal(resumed.timers[0].expiresAt, 69000);
  assert.equal(resumed.timers[0].runId, state.timers[0].runId);
  const expired = act(edited, 'edit', { remainingMs: 0 }); assert.equal(phase(expired.timers[0], 1000), 'expired');
  invalid(() => act(expired, 'pause'));
  invalid(() => act(act(add(), 'start'), 'pause'));
});
test('남은 시간 편집은 기본 기간을 보존하고 잘못된 전이는 거부한다', () => {
  invalid(() => act(add(), 'edit', { remainingMs: 100 }));
  const state = act(add(), 'start');
  for (const remainingMs of [-1, MINUTE + 1, 1.2, undefined]) invalid(() => act(state, 'edit', { remainingMs }));
  assert.equal(act(state, 'edit', { remainingMs: 123 }).timers[0].durationMs, MINUTE);
  invalid(() => act(state, 'resume'));
  invalid(() => act(state, 'start', {}, Number.MAX_SAFE_INTEGER));
});
test('동일 타이머의 오래된 버전은 모든 변경에서 충돌한다', () => {
  const state = act(add(), 'start');
  for (const type of ['start', 'stop', 'edit', 'settings', 'pause', 'resume', 'remove'])
    assert.throws(() => act(state, type, { expectedVersion: 1, remainingMs: 0 }), { code: 'timer-conflict' });
  assert.equal(state.timers[0].version, 2);
});
test('그룹 숨김·이동·삭제는 타이머를 보존하고 참조 오류를 거부한다', () => {
  let state = add(); const id = state.timers[0].id;
  const group = { ...state.groups[0], id: SECOND_GROUP_ID, timerIds: [] };
  state = reduce(state, { type: 'group-add', group }, 0);
  state = reduce(state, { type: 'group-update', id: DEFAULT_GROUP_ID, patch: { visible: false } }, 0);
  assert.equal(state.timers[0].status, 'idle');
  state = reduce(state, { type: 'move', id, expectedVersion: 1, targetId: SECOND_GROUP_ID, index: 0 }, 0);
  assert.deepEqual(state.groups.map(group => group.timerIds.length), [0, 1]);
  state = reduce(state, { type: 'group-remove', id: SECOND_GROUP_ID, targetId: DEFAULT_GROUP_ID }, 0);
  assert.deepEqual(state.groups[0].timerIds, [id]);
  invalid(() => reduce(state, { type: 'group-remove', id: DEFAULT_GROUP_ID, targetId: DEFAULT_GROUP_ID }, 0));
  invalid(() => validateState({ ...state, groups: [{ ...state.groups[0], timerIds: [] }] }));
  invalid(() => reduce(state, { type: 'group-update', id: DEFAULT_GROUP_ID, patch: { timerIds: [] } }, 0));
  assert.deepEqual(act(state, 'remove').groups[0].timerIds, []);
});
test('저장 알림·소리·메타데이터와 표현 상한을 검증한다', () => {
  const state = add();
  for (const soundRef of ['', null, 'blob:abc', 'https://example.com']) invalid(() => validateState({ ...state, soundRef }));
  assert.equal(validateState({ ...state, soundRef: `user.${'a'.repeat(32)}` }).soundRef, `user.${'a'.repeat(32)}`);
  invalid(() => add(fixture({ alerts: { toast: true, sound: false, leadMinutes: [1, 1] } })));
  invalid(() => add(fixture({ alerts: { toast: true, sound: false, leadMinutes: [2] } })));
  invalid(() => add(fixture({ item: { ...fixture().item, id: 'guessed-id' } })));
  invalid(() => reduce(state, { type: 'style', patch: { size: 100 } }, 0));
  invalid(() => reduce(state, { type: 'group-update', id: DEFAULT_GROUP_ID, patch: { count: 9 } }, 0));
});
test('타이머·그룹 상한과 그룹 내 순서를 보존한다', () => {
  let state = createState();
  for (let i = 0; i < 100; i++) state = add(fixture(), state);
  invalid(() => add(fixture(), state));
  const id = state.timers[0].id;
  const moved = reduce(state, { type: 'move', id, expectedVersion: 1, targetId: DEFAULT_GROUP_ID, index: 99 }, 0);
  assert.equal(moved.groups[0].timerIds[99], id);
  assert.equal(state.groups[0].timerIds[0], id);
  for (let i = 1; i < 20; i++) state = reduce(state, { type: 'group-add',
    group: { ...state.groups[0], id: crypto.randomUUID(), timerIds: [] } }, 0);
  invalid(() => reduce(state, { type: 'group-add', group: { ...state.groups[0], id: crypto.randomUUID(), timerIds: [] } }, 0));
});
test('HUD 시간은 대기·만료와 일·시간·분 경계를 표시한다', () => {
  const timer = fixture({ durationMs: 10 * 86400000 });
  assert.equal(formatRemaining(timer, 0), '대기');
  const running = { ...timer, status: 'running', runId: crypto.randomUUID() };
  for (const [expiresAt, expected] of [[0, '만료'], [1, '0m1s'], [59000, '0m59s'],
    [60000, '1m0s'], [3599000, '59m59s'], [3600000, '1h0m'], [86399000, '23h59m'],
    [86400000, '1d0h'], [(7 * 24 + 17) * 3600000, '7d17h']])
    assert.equal(formatRemaining({ ...running, expiresAt }, 0), expected);
});
test('설정 변경은 버전을 올리고 실행 중 기간 변경을 거부한다', () => {
  const idle = add(fixture({ durationMs: 2 * MINUTE, alerts: { toast: true, sound: false, leadMinutes: [2] } }));
  invalid(() => act(idle, 'settings', { patch: { durationMs: MINUTE } }));
  const configured = act(idle, 'settings', { patch: { durationMs: MINUTE, name: '새 이름',
    alerts: { toast: false, sound: true, leadMinutes: [1] } } });
  assert.equal(configured.timers[0].version, 2); assert.equal(configured.timers[0].name, '새 이름');
  assert.equal(idle.timers[0].name, '타이머');
  const running = act(configured, 'start');
  invalid(() => act(running, 'settings', { patch: { durationMs: 2 * MINUTE } }));
  assert.equal(act(running, 'settings', { patch: { name: '실행 이름' } }).timers[0].name, '실행 이름');
  assert.equal(act(running, 'settings', { patch: { durationMs: 2 * MINUTE } }, 61000).timers[0].durationMs, 2 * MINUTE);
  invalid(() => act(idle, 'settings', { patch: { status: 'running' } }));
  invalid(() => act(idle, 'settings', { patch: { alerts: { toast: true } } }));
});
test('소리 변경은 SDK 사용자 참조만 허용하고 원본을 보존한다', () => {
  const state = createState(), soundRef = `user.${'A9'.repeat(16)}`;
  assert.equal(reduce(state, { type: 'sound', soundRef }, 0).soundRef, soundRef);
  assert.equal(state.soundRef, 'default');
  invalid(() => reduce(state, { type: 'sound', soundRef: 'blob-handle' }, 0));
});
test('개별 이동과 그룹 삭제 이동은 오래된 타이머 변경을 차단한다', () => {
  let state = add(); const id = state.timers[0].id;
  state = reduce(state, { type: 'group-add', group: { ...state.groups[0], id: SECOND_GROUP_ID, timerIds: [] } }, 0);
  const command = { type: 'move', id, targetId: SECOND_GROUP_ID, expectedVersion: 1 };
  state = reduce(state, command, 0);
  assert.equal(state.timers[0].version, 2);
  assert.throws(() => reduce(state, { ...command, targetId: DEFAULT_GROUP_ID }, 0), { code: 'timer-conflict' });
  state = reduce(state, { type: 'group-remove', id: SECOND_GROUP_ID, targetId: DEFAULT_GROUP_ID }, 0);
  assert.equal(state.timers[0].version, 3);
  assert.throws(() => reduce(state, { ...command, targetId: DEFAULT_GROUP_ID, expectedVersion: 2 }, 0), { code: 'timer-conflict' });
  assert.throws(() => act(state, 'start', { expectedVersion: 2 }), { code: 'timer-conflict' });
});
test('그룹 안정 ID는 소문자 UUID이며 기본 ID는 생성마다 같다', () => {
  const state = createState();
  assert.equal(state.groups[0].id, DEFAULT_GROUP_ID);
  assert.equal(createState().groups[0].id, DEFAULT_GROUP_ID);
  for (const id of ['default', 'second', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', '', 'abc'])
    invalid(() => validateState({ ...state, groups: [{ ...state.groups[0], id }] }));
  const id = crypto.randomUUID();
  assert.equal(validateState({ ...state, groups: [{ ...state.groups[0], id }] }).groups[0].id, id);
});

test('드래그 후 다른 타이머 순서가 바뀌면 위치를 조용히 덮어쓰지 않는다',()=>{
  let state=createState();for(let i=0;i<4;i++)state=add(fixture(),state);
  const order=[...state.groups[0].timerIds], source=state.timers[0],last=state.timers[3];
  const drag={type:'move',id:source.id,expectedVersion:source.version,targetId:DEFAULT_GROUP_ID,index:2,expectedOrder:order};
  const latest=reduce(state,{type:'move',id:last.id,expectedVersion:last.version,targetId:DEFAULT_GROUP_ID,index:0},1000);
  assert.throws(()=>reduce(latest,drag,1000),{code:'timer-conflict'});
  assert.deepEqual(reduce(state,drag,1000).groups[0].timerIds,[order[1],order[2],order[0],order[3]]);
});

test('이전 버전에서 일시정지한 일반 아이템은 보존하고 재개 뒤에는 다시 정지할 수 없다',()=>{
  const running=act(add(fixture({durationMs:30*86400000})), 'start');
  const paused=structuredClone(running);Object.assign(paused.timers[0],{status:'paused',expiresAt:null,remainingMs:30*86400000-60000});
  const restored=validateState(JSON.parse(JSON.stringify(paused)));
  const left=30*86400000-60000;
  assert.equal(remainingMs(restored.timers[0],999999999999),left);
  const edited=act(restored,'edit',{remainingMs:3601000});
  assert.equal(edited.timers[0].status,'paused');
  const resumed=act(edited,'resume',{},999000);
  assert.equal(resumed.timers[0].expiresAt,4600000);
  assert.equal(resumed.timers[0].kind,'item');invalid(()=>act(resumed,'pause',{},999000));
  assert.equal(resumed.timers[0].runId,running.timers[0].runId);
  invalid(()=>act(add(),'pause'));
  invalid(()=>act(edited,'pause'));
  invalid(()=>act(act(edited,'edit',{remainingMs:0}),'pause'));
});
test('기존 그룹은 메뉴 아래 방향으로 복원하며 네 방향만 저장한다',()=>{
  const old=createState();delete old.groups[0].menuDirection;
  assert.equal(validateState(old).groups[0].menuDirection,'bottom');
  for(const menuDirection of ['top','bottom','left','right'])assert.equal(reduce(old,{type:'group-update',id:DEFAULT_GROUP_ID,patch:{menuDirection}},0).groups[0].menuDirection,menuDirection);
  invalid(()=>reduce(old,{type:'group-update',id:DEFAULT_GROUP_ID,patch:{menuDirection:'auto'}},0));
});

test('만료 일시 보정은 저장 시각과 실행 ID를 보존하며 중복 입력과 범위 밖을 거절한다',()=>{
 const running=act(add(),'start');
 const fixed=act(running,'edit',{expiresAt:51000},10000);
 assert.equal(fixed.timers[0].expiresAt,51000);assert.equal(fixed.timers[0].runId,running.timers[0].runId);
 assert.equal(fixed.timers[0].durationMs,MINUTE);
 for(const expiresAt of [9999,70001,NaN,Infinity,10000.5])invalid(()=>act(running,'edit',{expiresAt},10000));
 invalid(()=>act(running,'edit',{expiresAt:51000,remainingMs:1},10000));
 assert.equal(phase(act(running,'edit',{expiresAt:10000},10000).timers[0],10000),'expired');
});
test('일시정지 타롯의 만료 일시 입력은 저장 당시 남은 시간으로 바꾸며 정지를 유지한다',()=>{
 let state=act(add(fixture({kind:'tarot',durationMs:180*MINUTE})),'start');state=act(state,'pause');
 const fixed=act(state,'edit',{expiresAt:61000},1000);assert.equal(fixed.timers[0].status,'paused');assert.equal(fixed.timers[0].remainingMs,60000);
 assert.equal(act(fixed,'resume',{},9000).timers[0].expiresAt,69000);
});
test('종류 변경은 기존 실행 시각을 보존하고 타롯은 3시간만 허용한다',()=>{
 const state=act(add(fixture({durationMs:180*MINUTE})),'start');
 const tarot=act(state,'settings',{patch:{kind:'tarot'}});assert.equal(tarot.timers[0].expiresAt,state.timers[0].expiresAt);
 assert.equal(act(tarot,'pause').timers[0].status,'paused');
 invalid(()=>act(add(),'settings',{patch:{kind:'tarot'}}));
 const idle=act(add(),'settings',{patch:{kind:'tarot',durationMs:180*MINUTE}});assert.equal(idle.timers[0].kind,'tarot');
});
