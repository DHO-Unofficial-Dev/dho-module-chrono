// SPDX-License-Identifier: MPL-2.0
// 사용: node scripts/build.mjs <Navigator 공개 SDK 키트 경로>
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw new Error('공개 SDK 키트 경로를 지정하세요.');
const sdk = resolve(process.argv[2]);
const project = join(root, 'module');
const { version } = JSON.parse(readFileSync(join(project, 'manifest.json'), 'utf8'));
if (!new RegExp('^[0-9]+\\.[0-9]+\\.[0-9]+$').test(version)) throw new Error('버전 형식이 올바르지 않습니다.');
const output = join(root, 'dist'); mkdirSync(output, { recursive: true });
const artifact = join(output, `chrono-${version}.dho-module`);
for (const [command, args] of [['validate', [project]], ['build', [project, artifact]], ['verify', [artifact]]]) {
  const tool = join(sdk, 'tools', `${command}-module.mjs`);
  if (!existsSync(tool)) throw new Error('SDK 도구를 찾지 못했습니다.');
  const result = spawnSync(process.execPath, [tool, ...args], { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 검사 실패`);
}
console.log(`Chrono 모듈: ${artifact}`);

writeFileSync(join(output, 'SHA256SUMS.txt'), `${createHash('sha256').update(readFileSync(artifact)).digest('hex')}  chrono-${version}.dho-module\n`);
