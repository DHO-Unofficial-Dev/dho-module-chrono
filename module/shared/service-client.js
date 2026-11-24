// SPDX-License-Identifier: MPL-2.0
import { RequestQueue } from './request-queue.js';

// SDK 오류의 원문·details는 경로나 내부 진단을 담을 수 있어 표시하지 않는다.
export const SERVICE_MESSAGES = Object.freeze({
  'services.unbound': 'Vault 라이브러리를 연결해 주세요. Navigator 모듈 관리에서 Chrono의 서비스 연결을 열고, Vault를 선택한 뒤 연결 버튼을 눌러 주세요. Vault가 없다면 먼저 설치해 주세요.',
  'services.approvalRequired': '모듈 관리에서 Vault 연결의 아이템 읽기 권한을 승인해 주세요.',
  'services.scopeDenied': '아이템 읽기 권한이 없습니다. 모듈 관리에서 Vault 연결 권한을 확인해 주세요.',
  'services.providerDisabled': '모듈 관리에서 Vault 라이브러리를 활성화해 주세요.',
  'services.contractMismatch': '연결한 제공자의 계약이 맞지 않습니다. Vault 계약 v1 제공자를 연결해 주세요.',
  'services.providerUnavailable': 'Vault 제공자 서비스가 준비되지 않았거나 연결이 끊겼습니다. 모듈 관리에서 서비스 상태를 확인한 뒤 다시 확인해 주세요.',
  'services.consumerUnavailable': '타이머 모듈의 설치 상태가 바뀌었습니다. 이 패널을 닫았다가 다시 열어 주세요.',
  'services.hostUnavailable': 'Navigator의 서비스 연결을 사용할 수 없습니다. 모듈 관리에서 상태를 확인해 주세요.',
  'services.timeout': 'Vault 공용 서비스의 응답 시간이 초과되었습니다. 잠시 후 상태를 다시 확인해 주세요.',
  'services.rateLimited': 'Vault 서비스 요청이 많습니다. 잠시 후 다시 시도해 주세요.',
  'services.invalidRequest': '공용 서비스 요청 형식이 맞지 않습니다. 제공자와 타이머 모듈 버전을 확인해 주세요.',
  'services.methodDenied': '연결한 제공자가 이 조회 기능을 제공하지 않습니다. 모듈 연결과 버전을 확인해 주세요.',
  'services.providerFailed': 'Vault 제공자가 공용 서비스 요청을 처리하지 못했습니다. 서비스 상태와 모듈 버전을 확인해 주세요.',
  'capability.denied': '타이머 모듈의 서비스 이용 권한이 허용되지 않았습니다. 모듈 관리에서 권한을 확인해 주세요.',
  'ipc.unauthorized-window': '이 화면에서 공용 서비스에 접근할 수 없습니다. 패널을 다시 열고 Navigator 버전을 확인해 주세요.',
  'services.failed': '공용 서비스 호출에 실패했습니다. 모듈 관리에서 Vault 연결을 확인해 주세요.',
});
const BINDING_CODES = Object.freeze({
  unbound: 'services.unbound', 'approval-required': 'services.approvalRequired',
  'provider-disabled': 'services.providerDisabled', 'contract-mismatch': 'services.contractMismatch',
  'provider-unavailable': 'services.providerUnavailable',
});
export function serviceFailure(code) {
  const known = typeof code === 'string' && Object.hasOwn(SERVICE_MESSAGES, code) ? code : 'services.failed';
  return { ok: false, error: { code: known, message: SERVICE_MESSAGES[known] } };
}
export function serviceMessage(code) { return typeof code === 'string' && Object.hasOwn(SERVICE_MESSAGES, code) ? SERVICE_MESSAGES[code] : undefined; }

export function createServiceClient(services, { onBinding = () => {}, pace, timeout = 30000, queueOptions = {} } = {}) {
  let revision = -1, binding = null, bindingKey = '', connectionEpoch = 0, closed = false, unsubscribe;
  const queue = new RequestQueue({ ...(pace === undefined ? {} : { interval: pace, burst: 1 }), ...queueOptions });
  // binding 조회가 지연돼도 실제 공용 호출 시작이 한꺼번에 몰리지 않게 별도로 제한한다.
  const calls = new RequestQueue({ ...(pace === undefined ? {} : { interval: pace, burst: 1 }), ...queueOptions });
  function accept(snapshot, notify = true) {
    if (closed || !Number.isSafeInteger(snapshot?.revision) || snapshot.revision <= revision) return;
    revision = snapshot.revision;
    binding = snapshot.bindings.find(item => item.dependencyId === 'vault') ?? null;
    const key = JSON.stringify([binding?.state, binding?.provider?.moduleId, binding?.provider?.version, binding?.grantedScopes]);
    const changed = key !== bindingKey; bindingKey = key;
    if (changed) connectionEpoch++;
    if (notify && changed) onBinding(binding?.state === 'ready', serviceFailure(BINDING_CODES[binding?.state] ?? 'services.unbound').error.message);
  }
  return {
    identity() { return binding?.state === 'ready' && binding.provider?.moduleId ? { providerModuleId: binding.provider.moduleId, epoch: connectionEpoch } : null; },
    async start() {
      unsubscribe = await services.subscribeBindings(accept);
      if (closed) { unsubscribe(); return; }
      accept(await services.getBindings());
    },
    call(method, params = {}) {
      if (closed) return Promise.resolve(serviceFailure('services.consumerUnavailable'));
      const queuedEpoch = connectionEpoch, deadline = Date.now() + timeout;
      return queue.enqueue(async () => {
        try {
          // 다시 확인은 구독 상태에만 기대지 않고 현재 binding을 읽는다.
          if (method === 'get-status') accept(await services.getBindings(), false);
          if (closed) return serviceFailure('services.consumerUnavailable');
          if (binding?.state !== 'ready') return serviceFailure(BINDING_CODES[binding?.state] ?? 'services.unbound');
          const epoch = connectionEpoch;
          const response = await calls.enqueue(() => services.call('vault', method, params), {
            ttl: Math.max(0, deadline - Date.now()), isCurrent: () => !closed && epoch === connectionEpoch,
          });
          if (closed || epoch !== connectionEpoch) return serviceFailure('services.providerUnavailable');
          return response;
        } catch (error) { return serviceFailure(
          closed ? 'services.consumerUnavailable' : error?.code === 'queue.timeout' ? 'services.timeout' : error?.code === 'queue.busy' ? 'services.rateLimited' : error?.code === 'queue.stale' ? 'services.providerUnavailable' : error?.code,
        ); }
      }, { ttl: timeout, isCurrent: () => !closed && queuedEpoch === connectionEpoch }).catch(error => serviceFailure(
        closed ? 'services.consumerUnavailable' : error?.code === 'queue.timeout' ? 'services.timeout' : error?.code === 'queue.busy' ? 'services.rateLimited' : 'services.providerUnavailable',
      ));
    },
    close() { closed = true; queue.close(); calls.close(); unsubscribe?.(); },
  };
}
