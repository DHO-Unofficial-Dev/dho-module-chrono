// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBlobReader } from '../module/shared/blob-reader.js';
test('재렌더가 겹쳐도 blob 읽기는 하나만 실행하고 낡은 대기 요청을 건너뛴다', async () => {
  const calls = []; let finish, generation = 0;
  const reader = createBlobReader({ getBlob: async handle => { calls.push(handle); return new Promise(resolve => { finish = resolve; }); } });
  const first = reader.read('old', () => generation === 0); await Promise.resolve();
  const stale = Array.from({ length: 20 }, () => reader.read('stale', () => generation === 0));
  generation = 1; const latest = reader.read('new', () => generation === 1);
  assert.deepEqual(calls, ['old']); finish({ bytes: 'old' }); assert.equal(await first, null);
  await Promise.all(stale); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['old', 'new']); finish({ bytes: 'new' }); assert.deepEqual(await latest, { bytes: 'new' }); reader.close();
});
test('읽기 실패 뒤 다음 요청을 처리하고 닫힌 화면의 응답을 버린다', async () => {
  let finish; const calls = [];
  const reader = createBlobReader({ getBlob: async handle => { calls.push(handle); if (handle === 'bad') throw Error('disk'); return new Promise(resolve => { finish = resolve; }); } });
  await assert.rejects(reader.read('bad'));
  const good = reader.read('good'); await new Promise(resolve => setImmediate(resolve)); reader.close(); finish({ bytes: 'good' });
  assert.equal(await good, null); assert.equal(await reader.read('closed'), null); assert.deepEqual(calls, ['bad', 'good']);
});
