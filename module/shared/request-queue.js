// SPDX-License-Identifier: MPL-2.0
const queueError = code => Object.assign(new Error(code), { code });

// 시작 빈도와 진행 중 작업 수를 함께 제한한다. 완료 뒤에는 지연을 추가하지 않는다.
export class RequestQueue {
  constructor({ concurrency = 4, interval = 300, burst = 2, maxQueued = 64 } = {}) {
    Object.assign(this, { concurrency, interval, burst, maxQueued });
    this.queued = []; this.active = new Set(); this.starts = []; this.timer = null; this.closed = false;
  }
  enqueue(task, { ttl = 30000, isCurrent = () => true, signal } = {}) {
    if (this.closed) return Promise.reject(queueError('queue.closed'));
    if (this.queued.length >= this.maxQueued) return Promise.reject(queueError('queue.busy'));
    if (signal?.aborted) return Promise.reject(queueError('queue.cancelled'));
    return new Promise((resolve, reject) => {
      const job = { task, isCurrent, deadline: Date.now() + ttl, settled: false };
      job.finish = (ok, value) => {
        if (job.settled) return;
        job.settled = true; clearTimeout(job.timer); signal?.removeEventListener('abort', job.abort);
        if (ok) resolve(value); else reject(value);
      };
      job.cancel = code => {
        this.queued = this.queued.filter(item => item !== job);
        job.finish(false, queueError(code)); this.pump();
      };
      job.abort = () => job.cancel('queue.cancelled');
      signal?.addEventListener('abort', job.abort, { once: true });
      job.timer = setTimeout(() => job.cancel('queue.timeout'), Math.max(1, ttl));
      this.queued.push(job); this.pump();
    });
  }
  pump() {
    if (this.closed) return;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    while (this.active.size < this.concurrency && this.queued.length) {
      const now = Date.now(); const job = this.queued[0];
      if (job.deadline <= now || !job.isCurrent()) {
        this.queued.shift(); job.finish(false, queueError(job.deadline <= now ? 'queue.timeout' : 'queue.stale')); continue;
      }
      this.starts = this.starts.filter(start => !start.started || now - start.at < this.interval);
      if (this.starts.length >= this.burst) {
        this.timer = setTimeout(() => { this.timer = null; this.pump(); }, Math.max(1, this.starts[0].at + this.interval - now));
        return;
      }
      this.queued.shift(); this.active.add(job);
      const start = { at: now, started: false }; this.starts.push(start);
      Promise.resolve().then(() => {
        if (job.settled || this.closed || !job.isCurrent()) throw queueError('queue.stale');
        if (job.deadline <= Date.now()) throw queueError('queue.timeout');
        // microtask 실행 전 메인 스레드가 막혔어도 실제 호출 시각부터 간격을 센다.
        start.at = Date.now(); start.started = true;
        return job.task();
      }).then(value => job.finish(true, value), error => job.finish(false, error)).finally(() => {
        // 취소/시간 초과도 실제 SDK 작업이 끝날 때까지 동시 실행 슬롯을 점유한다.
        this.active.delete(job);
        if (!start.started) this.starts = this.starts.filter(value => value !== start);
        this.pump();
      });
    }
  }
  cancelAll(code = 'queue.cancelled') {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    for (const job of [...this.queued, ...this.active]) job.finish(false, queueError(code));
    this.queued = [];
  }
  close() { this.closed = true; this.cancelAll('queue.closed'); }
}
