// SPDX-License-Identifier: MPL-2.0
import { validateMetadata, validIconHandle, validRegistrationId } from './contracts.js';

export const KEY = 'timer.runtime.v1';
export const DEFAULT_GROUP_ID = '00000000-0000-4000-8000-000000000001';
const MINUTE = 60_000;
const MAX_DURATION = 366 * 24 * 60 * MINUTE;
const TAROT_DURATION = 180 * MINUTE;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const number = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const label = (value, max = 128) => typeof value === 'string' && value.trim().length > 0
  && new TextEncoder().encode(value).length <= max && !/[\u0000-\u001f\u007f]/.test(value);
function fail(code = 'invalid-storage') { throw Object.assign(new Error(code), { code }); }
function require(value) { if (!value) fail(); }
function nowValue(now) { require(integer(now, 0, Number.MAX_SAFE_INTEGER)); }
function cleanStyle(style) {
  require(record(style) && integer(style.size, 32, 80) && number(style.gap, 0, 24)
    && number(style.thickness, 0.5, 3) && typeof style.gauge === 'boolean'
    && (style.timeSize === undefined || integer(style.timeSize, 10, 20))
    && (style.motion === undefined || typeof style.motion === 'boolean')
    && (style.easterEggs === undefined || typeof style.easterEggs === 'boolean'));
  return { size: style.size, gap: style.gap, thickness: style.thickness, gauge: style.gauge, timeSize: style.timeSize ?? 12, motion: style.motion ?? true, easterEggs: style.easterEggs ?? true };
}
function cleanGroup(group) {
  require(record(group) && validRegistrationId(group.id) && group.id === group.id.toLowerCase() && label(group.name, 512)
    && typeof group.visible === 'boolean' && typeof group.showName === 'boolean'
    && number(group.transparency, 0, 100) && ['row', 'column'].includes(group.direction)
    && (group.menuDirection === undefined || ['top','bottom','left','right'].includes(group.menuDirection))
    && integer(group.count, 1, 8) && Array.isArray(group.timerIds));
  require(group.timerIds.every(validRegistrationId));
  return { id: group.id, name: group.name, visible: group.visible, showName: group.showName,
    transparency: group.transparency, direction: group.direction, count: group.count, menuDirection: group.menuDirection ?? 'bottom',
    timerIds: [...group.timerIds] };
}
function cleanTimer(timer) {
  require(record(timer) && validRegistrationId(timer.id) && integer(timer.version, 1, Number.MAX_SAFE_INTEGER)
    && label(timer.name, 512) && ['item', 'tarot'].includes(timer.kind)
    && integer(timer.durationMs, MINUTE, MAX_DURATION)
    && (timer.kind !== 'tarot' || timer.durationMs === TAROT_DURATION)
    && ['idle', 'running', 'paused'].includes(timer.status));
  let item;
  try { item = validateMetadata(timer.item); } catch { fail(); }
  require(timer.item.iconHandle === null || validIconHandle(timer.item.iconHandle));
  require(timer.runId === null || validRegistrationId(timer.runId));
  if (timer.status === 'idle') {
    require(timer.expiresAt === null && timer.remainingMs === null && timer.runId === null);
  } else if (timer.status === 'running') {
    require(integer(timer.expiresAt, 0, Number.MAX_SAFE_INTEGER) && timer.remainingMs === null && timer.runId !== null);
  } else {
    require(timer.expiresAt === null
      && integer(timer.remainingMs, 1, timer.durationMs) && timer.runId !== null);
  }
  const alerts = timer.alerts;
  require(record(alerts) && typeof alerts.toast === 'boolean' && typeof alerts.sound === 'boolean'
    && Array.isArray(alerts.leadMinutes) && alerts.leadMinutes.length <= 100
    && alerts.leadMinutes.every(value => integer(value, 1, Math.floor(timer.durationMs / MINUTE)))
    && new Set(alerts.leadMinutes).size === alerts.leadMinutes.length);
  return { id: timer.id, version: timer.version, item: { ...item, iconHandle: timer.item.iconHandle },
    name: timer.name, kind: timer.kind, durationMs: timer.durationMs, status: timer.status,
    expiresAt: timer.expiresAt, remainingMs: timer.remainingMs, runId: timer.runId,
    alerts: { toast: alerts.toast, sound: alerts.sound, leadMinutes: [...alerts.leadMinutes] } };
}
export function createState() {
  return { schemaVersion: 1, groups: [{ id: DEFAULT_GROUP_ID, name: '기본 그룹', visible: true,
    showName: true, transparency: 12, direction: 'row', menuDirection: 'bottom', count: 4, timerIds: [] }],
  timers: [], startLinks: [], style: { size: 48, gap: 10, thickness: 1.5, gauge: true, timeSize: 12, motion: true, easterEggs: true }, soundRef: 'default' };
}
export function validateState(value) {
  require(record(value));
  if (value.schemaVersion !== 1) fail('unsupported-schema');
  require(Array.isArray(value.groups) && value.groups.length >= 1 && value.groups.length <= 20
    && Array.isArray(value.timers) && value.timers.length <= 100
    && (value.soundRef === 'default' || (typeof value.soundRef === 'string' && /^user\.[a-zA-Z0-9]{32}$/.test(value.soundRef))));
  const groups = value.groups.map(cleanGroup);
  const timers = value.timers.map(cleanTimer);
  const ids = new Set(timers.map(timer => timer.id.toLowerCase()));
  require(ids.size === timers.length && new Set(groups.map(group => group.id)).size === groups.length);
  const assigned = new Set();
  for (const group of groups) for (const id of group.timerIds) {
    // 참조는 원본 ID와 정확히 일치해야 한다.
    require(timers.some(timer => timer.id === id) && !assigned.has(id.toLowerCase()));
    assigned.add(id.toLowerCase());
  }
  require(assigned.size === timers.length);
  const startLinks = value.startLinks === undefined ? [] : value.startLinks;
  require(Array.isArray(startLinks) && startLinks.length <= 50);
  const linked = new Set();
  for (const members of startLinks) {
    require(Array.isArray(members) && members.length >= 2 && members.length <= 100);
    for (const id of members) {require(timers.some(timer => timer.id === id) && !linked.has(id));linked.add(id);}
  }
  return { schemaVersion: 1, groups, timers, startLinks: startLinks.map(ids => [...ids]), style: cleanStyle(value.style), soundRef: value.soundRef };
}
export function remainingMs(timer, now) {
  nowValue(now);
  return timer.status === 'idle' ? timer.durationMs : timer.status === 'paused'
    ? timer.remainingMs : Math.max(0, timer.expiresAt - now);
}
export function phase(timer, now) {
  return timer.status === 'running' && remainingMs(timer, now) === 0 ? 'expired' : timer.status;
}
export function formatRemaining(timer, now) {
  const currentPhase = phase(timer, now);
  if (currentPhase === 'idle') return '대기';
  if (currentPhase === 'expired') return '만료';
  const seconds = Math.ceil(remainingMs(timer, now) / 1000);
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d${Math.floor(seconds % 86400 / 3600)}h`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h${Math.floor(seconds % 3600 / 60)}m`;
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}
export function reduce(value, command, now) {
  const state = validateState(value);
  nowValue(now);
  require(record(command));
  const groupById = id => { const group = state.groups.find(group => group.id === id); require(group); return group; };
  const timerById = id => { const timer = state.timers.find(timer => timer.id === id); require(timer); return timer; };
  const detach = id => { for (const group of state.groups) group.timerIds = group.timerIds.filter(entry => entry !== id); };
  switch (command.type) {
    case 'link-start': {
      const timer = timerById(command.id);
      if (command.expectedVersion !== timer.version) fail('timer-conflict');
      require(Array.isArray(command.ids) && command.ids.length <= 99 && new Set(command.ids).size === command.ids.length && !command.ids.includes(timer.id));
      const old = state.startLinks.find(ids => ids.includes(timer.id)) ?? [timer.id];
      const next = [timer.id, ...command.ids];
      for (const id of next) {timerById(id);require(!state.startLinks.some(ids => ids !== old && ids.includes(id)));}
      state.startLinks = state.startLinks.filter(ids => ids !== old);
      const removed = old.filter(id => !next.includes(id));
      if (removed.length > 1) state.startLinks.push(removed);
      if (next.length > 1) state.startLinks.push(next);
      for (const id of new Set([...old, ...next])) timerById(id).version += 1;
      break;
    }
    case 'add': {
      const timer = cleanTimer(command.timer);
      require(timer.version === 1);
      groupById(command.groupId).timerIds.push(timer.id);
      state.timers.push(timer);
      break;
    }
    case 'start': case 'pause': case 'resume': case 'stop': case 'edit': case 'settings': case 'remove': {
      const timer = timerById(command.id);
      if (command.expectedVersion !== timer.version) fail('timer-conflict');
      if (command.type === 'remove') {
        detach(timer.id);
        const linked = state.startLinks.find(ids => ids.includes(timer.id));
        for (const id of linked ?? []) if(id !== timer.id) timerById(id).version += 1;
        state.startLinks = state.startLinks.map(ids => ids.filter(id => id !== timer.id)).filter(ids => ids.length > 1);
        state.timers = state.timers.filter(entry => entry.id !== timer.id); break;
      }
      const currentPhase = phase(timer, now);
      if (command.type === 'settings') {
        require(record(command.patch) && Object.keys(command.patch).every(key => ['name', 'durationMs', 'alerts', 'kind'].includes(key)));
        if (Object.hasOwn(command.patch, 'durationMs') && command.patch.durationMs !== timer.durationMs)
          require(currentPhase === 'idle' || currentPhase === 'expired');
        Object.assign(timer, command.patch);
      } else if (command.type === 'stop') {
        timer.status = 'idle'; timer.expiresAt = null; timer.remainingMs = null; timer.runId = null;
      } else if (command.type === 'start') {
        timer.status = 'running'; timer.expiresAt = now + timer.durationMs;
        timer.remainingMs = null; timer.runId = crypto.randomUUID();
        const linked = state.startLinks.find(ids => ids.includes(timer.id)) ?? [];
        for (const id of linked) {
          if(id === timer.id)continue;
          const other = timerById(id);
          if(!['idle','expired'].includes(phase(other,now)))continue;
          other.status='running';other.expiresAt=now+other.durationMs;other.remainingMs=null;other.runId=crypto.randomUUID();other.version+=1;
        }
      } else if (command.type === 'pause') {
        require(currentPhase === 'running' && timer.kind === 'tarot');
        timer.remainingMs = Math.min(timer.durationMs, remainingMs(timer, now));
        timer.status = 'paused'; timer.expiresAt = null;
      } else if (command.type === 'resume') {
        require(currentPhase === 'paused');
        timer.expiresAt = now + timer.remainingMs; timer.remainingMs = null; timer.status = 'running';
      } else {
        const hasExpiry = Object.hasOwn(command, 'expiresAt');
        require(!hasExpiry || (!Object.hasOwn(command, 'remainingMs') && integer(command.expiresAt, now, Number.MAX_SAFE_INTEGER)));
        const left = hasExpiry ? command.expiresAt - now : command.remainingMs;
        require(currentPhase !== 'idle' && integer(left, 0, timer.durationMs));
        if (currentPhase === 'paused' && left > 0) timer.remainingMs = left;
        else { timer.status = 'running'; timer.remainingMs = null; timer.expiresAt = now + left; }
      }
      timer.version += 1;
      break;
    }
    case 'group-add': state.groups.push(cleanGroup(command.group)); break;
    case 'group-update': {
      const group = groupById(command.id);
      require(record(command.patch) && Object.keys(command.patch).every(key => ['name', 'visible', 'showName', 'transparency', 'direction', 'count', 'menuDirection'].includes(key)));
      Object.assign(group, command.patch); break;
    }
    case 'group-remove': {
      const group = groupById(command.id), target = groupById(command.targetId);
      require(group !== target && state.groups.length > 1);
      for (const id of group.timerIds) timerById(id).version += 1;
      target.timerIds.push(...group.timerIds); state.groups = state.groups.filter(entry => entry !== group); break;
    }
    case 'move': {
      const timer = timerById(command.id);
      if (command.expectedVersion !== timer.version) fail('timer-conflict');
      const target = groupById(command.targetId);
      if (command.expectedOrder !== undefined) {
        if (!Array.isArray(command.expectedOrder) || !target.timerIds.includes(command.id)
          || command.expectedOrder.length !== target.timerIds.length
          || command.expectedOrder.some((id, index) => id !== target.timerIds[index])) fail('timer-conflict');
      }
      detach(command.id);
      const index = command.index === undefined ? target.timerIds.length : command.index;
      require(integer(index, 0, target.timerIds.length));
      target.timerIds.splice(index, 0, command.id); timer.version += 1; break;
    }
    case 'sound': state.soundRef = command.soundRef; break;
    case 'style':
      require(record(command.patch) && Object.keys(command.patch).every(key => ['size', 'gap', 'thickness', 'gauge', 'timeSize', 'motion', 'easterEggs'].includes(key)));
      Object.assign(state.style, command.patch); break;
    default: fail();
  }
  return validateState(state);
}
