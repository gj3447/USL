# Core CLI 실행 계획

## 현재 개발 공백

USL의 바인딩 CLI와 등록 CLI host는 구현되어 있고 각각의 단위 테스트도 있다. C01은 메인 `usl` 명령의 도움말과 명령군 계약을 정리했다. 다음 코어 개발은 탐색 옵션, 입출력과 빌드된 실행 파일을 정리한다.

- 최상위·명령군·개별 명령 도움말은 하나의 명령 계약에서 만든다. `help core|platform|adapter|capability|host|legacy`와 기존 `COMMAND --help`는 실행 없이 stdout으로 도움말을 낸다.
- `context`는 hop/link/visit/route 제한과 compact byte/digest 옵션을 제공한다. `adapt --operation context`는 focus/target/compact와 기존 `--max-resources` 정책 한도를 받지만, hop/link/visit/route와 `--max-bytes`, `--known-context`, `--stats`를 전달하지 못한다.
- core CLI의 입력은 파일뿐이다. 작은 순수 `check`/`compile`/`context` 파이프라인용 bounded stdin 계약이 없고, stdin을 받는 child-process host의 invocation 경로와 구분되어 있지 않다.
- package의 `bin`은 build 결과물 `dist/src/cli.js`를 가리키지만, `usl` package bin 자체를 build 뒤 실제로 실행하는 smoke test는 없다.

USL 문법은 Resource·Meaning·이름 있는 Participant role·Link의 단순 바인딩을 유지한다. 가중치, 계층 알고리즘, M-map, 학습 규칙은 선택 애드온 또는 등록 프로그램이 소유한다.

## 현재 CLI 계약

| 흐름 | 입력 | stdout | stderr / 종료 상태 |
| --- | --- | --- | --- |
| `check`, `compile`, `context`, `observe` | `.usl` 파일 | JSON 결과 또는 plan/context | 사용 오류 64, 일반 실패 1, 관측 미해결·변화 2 |
| `context --compact` | `.usl`, focus, 선택 target/route | `usl-agent-context-compact/v1` JSON | `--stats`만 JSON stderr; `--max-bytes`, `--known-context` 지원 |
| `adapt` | property/resource graph JSON, namespace | 검사·context·observe·JSON-LD JSON | profile은 resource graph에서만 명시적으로 선택; observe 미해결은 2 |
| 등록 host | host config, stable resource/action ID, JSON invocation | list/locate/plan/run/inspect JSON | `REJECTED`·`INDETERMINATE`는 2, 사용 오류 64 |

자원 ID는 경로와 분리된다. 여러 로컬/Git/URL 표현은 binding의 `resource`와 `representation` 선택으로 다룬다. `bind-graph`는 선택한 locator를 기존 resource graph에 결속한다. 실제 권한·원격 접근은 host/소유자가 별도로 강제한다.

## 실행 순서

| ID | 의존 | 변경 파일 | 현재 공백과 완료 조건 | 상태 |
| --- | --- | --- | --- | --- |
| C01 | 없음 | `src/cli.ts`, `src/cli-help.ts`, `src/cli-platform.ts`, `src/cli-adapter.ts`, `src/cli-capabilities.ts`, `src/cli-host-command.ts`, `docs/CLI.md`, `test/cli.test.ts`, `test/cli-help.test.ts` | 명령 이름을 바꾸지 않고 `usl help core\|platform\|adapter\|host`와 capability·legacy 명령군 및 각 명령의 `--help`를 같은 usage source에서 만든다. 각 명령군의 JSON stdout, 오류 stderr, 0/1/2/64를 contract test로 고정했다. | `COMPLETED` / `COMPLETE` / `NOT_PROVEN` |
| C02 | C01 | `src/cli-adapter.ts`, `src/adapters.ts`, `docs/CLI.md`, `test/adapter-boundaries.test.ts`, `test/cli.test.ts` | `adapt --operation context`에 `--max-hops`, `--max-resources`, `--max-links`, `--max-visits`, 반복 `--via`, `--max-bytes`, `--known-context`, `--stats`를 core context와 같은 검증·출력 규칙으로 추가한다. profile 선택과 native ID는 보존한다. | `PLANNED` / `NOT_STARTED` / `NOT_PROVEN` |
| C03 | C01 | `src/cli.ts`, 새 `src/cli-io.ts`, `docs/CLI.md`, `test/cli.test.ts`, `test/cli-project-inputs.test.ts` | 순수 core `check`/`compile`/`context`에만 명시적 `--source -` bounded UTF-8 stdin을 추가한다. byte 한도, source label, `--out` 충돌, JSON stdout envelope를 검증한다. `observe`, 파일 변경 명령, 등록 host 실행은 stdin 대상이 아니다. | `PLANNED` / `NOT_STARTED` / `NOT_PROVEN` |
| C04 | C01 | `package.json`, `test/cli-package-bin.test.ts`, `docs/GETTING_STARTED.md` | `npm run build` 뒤 package bin symlink로 `usl --help`와 순수 `check` fixture를 실행해 dist import·shebang·exit status를 확인한다. 별도 tokenizer 의존성이나 API 비용 추정은 넣지 않는다. | `PLANNED` / `NOT_STARTED` / `NOT_PROVEN` |

기존 `adapt --max-resources`의 정책 한도는 C02에서도 유지한다. 이동 workspace/복수
representation 및 `cli-list → cli-plan → cli-run → cli-inspect` 검증도 C02/C04의
회귀 수용 기준이다. C04 실행 검사는 build 이후의 별도 명령으로 제공해 현재
build 이전 `npm test` 순서와 충돌하지 않게 한다.

token budget은 현재 CLI 기능이 아니다. 필요해지면 counter ID·버전·입력 범위·실패 정책을 먼저 정하고, 두 encoding에서 lossless 복원 측정을 통과한 뒤 별도 작은 작업으로 추가한다. offline token count는 heap, API 청구액, 모델 품질을 뜻하지 않는다.

Lean 4는 현재 CLI 실행·외부 효과·tokenizer 계산의 증명을 제공하지 않는다. 따라서 모든 계획 작업의 proof 상태는 `NOT_PROVEN`이다.

## 근거 스냅샷

아래 파일은 2026-09-30 로컬 작업 트리에서 읽은 SHA-256 스냅샷이다. C01 완료 근거는 별도 검증 영수증의 source commit과 파일 pin으로 남긴다. 이 표는 원격 관측이나 Lean 증명이 아니다.

| 파일 | SHA-256 |
| --- | --- |
| `src/cli.ts` | `5843b269a772cabcf62c700448af6fc331d97553c51d365f7b75657bd71abaa7` |
| `src/cli-help.ts` | `4df34b8da44cfa1dfbcd316610b6d44df11ff13e9209e21fdbb7167d5887c5dc` |
| `src/cli-platform.ts` | `289c4a3a8bcd6c26811924bb703a0038894c7b64207964142ce25ae588c0771a` |
| `src/cli-adapter.ts` | `4d2f6a159b40bbeb5b437cd9a600210453cafa598997b82246ba910b996349b4` |
| `src/cli-capabilities.ts` | `48cee118eeccaaea3e2a0aefa3bdd292382a91a51e33a6895e4d7bd810ee1c70` |
| `src/cli-host-command.ts` | `f328f49fdd91046d1216f307e23e91cc06481e08af0f180609b8b3f07fd95f77` |
| `src/cli-host.ts` | `80c4d9e143a42c5aafcdb788e3e77b6c7384c2cce2a6f43a9b8b1ef993bdb692` |
