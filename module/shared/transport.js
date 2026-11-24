// SPDX-License-Identifier: MPL-2.0
export const PUBLIC_METHODS = new Set(['get-status', 'search-items', 'get-item', 'get-icon']);
const labels = { unavailable: '라이브러리에 연결할 수 없습니다. 다시 시도해 주세요.', timeout: '읽기 시간이 초과되었습니다. 잠시 후 다시 조회해 주세요.', busy: '라이브러리를 준비 중입니다. 잠시 후 다시 시도해 주세요.', 'invalid-request': '요청 형식이 올바르지 않습니다.', 'storage-failed': '설정을 저장하지 못했습니다. 이전 설정으로 다시 시작합니다.' };
export const failure = (code) => ({ ok: false, error: { code, message: labels[code] || '아이템을 읽지 못했습니다.' } });
export const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export class LatestResult {
  constructor() { this.version = 0; }
  next() { return ++this.version; }
  current(version) { return version === this.version; }
}
