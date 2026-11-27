# 개발 안내

Chrono는 DHO Navigator의 격리된 HTML·CSS·JavaScript 표면에서 실행됩니다. Node.js는 테스트와 패키징에만 필요하며 모듈 실행에는 필요하지 않습니다.

## 환경

- Node.js 22 이상
- DHO Navigator 2.2.2 공개 Module SDK 키트
- 실제 실행 확인용 Windows와 DHO Navigator, Vault

외부 npm 의존성은 없습니다.

## 테스트와 빌드

```sh
npm test
```

[Navigator v2.2.2의 공개 SDK 키트](https://github.com/DHO-Unofficial-Dev/DHO-Manager/releases/download/v2.2.2/dho-module-node-tools.zip)를 받아 저장소 밖이나 `.tools/`에 압축 해제합니다. `tools/`와 `sdk/`가 들어 있는 폴더를 빌드 명령에 전달하세요.

```sh
npm run build -- /path/to/dho-module-node-tools
```

빌드 스크립트가 소스 검사, archive 생성, archive 검증을 순서대로 수행합니다. 결과는 `dist/chrono-1.1.0.dho-module`과 `dist/SHA256SUMS.txt`입니다. SDK가 계산한 최소 버전보다 manifest의 최소 버전이 높다는 경고는 Navigator 2.2.2의 HUD 동작을 대상으로 하므로 유지합니다.

CI도 같은 SDK 파일을 SHA-256으로 확인한 뒤 테스트와 빌드를 수행합니다. SDK를 갱신할 때는 앱 호환성과 함께 워크플로의 버전·체크섬을 갱신하세요.

## 구조

```text
module/                 모듈 archive에 들어가는 파일
  manifest.json         ID·권한·Vault 의존성·표면·조작 기능
  assets/               독 아이콘
  shared/               시간 계산·저장·서비스 연결·캐시
  surfaces/panel/       아이템 등록과 타이머·HUD 설정
  surfaces/hud/         아이콘·남은 시간과 항목 조작
media/                  저장소 소개 이미지
scripts/build.mjs       공개 SDK를 사용하는 패키징
tests/                 Node.js 내장 테스트
```

## 계약

- Module ID: `app.dhoport.chrono`
- 배포자: `app.dhoport` / DHO PORT
- Vault 서비스: `org.dho.vault.items` 버전1, `items.read`
- 저장 키: `timer.runtime.v1`, `timer.items.v1`
- HUD 조작: `focus-hud`

실행 중 타이머는 만료 시각으로 계산하고 매초 저장하지 않습니다. 일시정지 상태는 남은 시간을 보관합니다. 서로 다른 화면에서 수정할 때는 저장소 revision과 항목별 version으로 충돌을 검사합니다.

등록된 아이템의 아이콘은 blob으로 보관합니다. 검색·추천 이미지의 임시 캐시는 별도 이름으로 구분하고128개·4MiB 이내로 유지합니다. 제공자·데이터 세대·아이콘 참조를 키로 사용하므로 Vault의 데이터 세대가 바뀌면 새 아이콘을 받습니다.

공개 SDK 문서는 [DHO PORT](https://dhoport.app/navigator/docs)에서 확인할 수 있습니다. `interactionMode: interactive` 선언만으로 항상 클릭되는 것은 아니며 Navigator가 조작 모드 진입과 종료를 관리합니다.

## 배포

manifest와 package.json의 버전을 함께 맞춘 뒤 테스트·빌드를 실행합니다. 공개할 때는 검증된 `.dho-module`과 `SHA256SUMS.txt`를 같은 Release에 첨부합니다. CI는 검사와 빌드만 수행하며 태그나 Release를 자동 생성하지 않습니다.

이 모듈에는 `dho-official.sig`를 넣지 않습니다. 다른 배포자의 이름으로 수정본을 배포하려면 Module ID·배포자 ID·surface ID를 자신의 namespace로 변경하세요.
