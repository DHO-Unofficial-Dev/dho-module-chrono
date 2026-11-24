// SPDX-License-Identifier: MPL-2.0
// 화면이 재렌더되어도 하나의 읽기 대기열을 공유해 Host 동시 요청 상한을 지킨다.
export function createBlobReader(storage) {
  let tail = Promise.resolve(), closed = false;
  return {
    read(handle, current = () => true) {
      const result = tail.then(async () => {
        if (closed || !current()) return null;
        const blob = await storage.getBlob(handle);
        return closed || !current() ? null : blob;
      });
      tail = result.catch(() => {}); return result;
    },
    close() { closed = true; },
  };
}
