# USL 사용 경로·HSWM 기본값 보완

기존 CLI·MCP·스킬 구현에 설정 파일 기반 native 연결과 완전한 관측 envelope
검증·비교를 연결했다. [사용자 매뉴얼](../docs/USER_MANUAL.md)은 native UID 탐색,
선택 관측, 비교, MCP, HSWM, agent 스킬 사용 순서를 설명한다.

## 구현

- `usl mcp --config FILE`와 `usl-mcp --config FILE`로 같은 서버를 시작한다.
  graph/program 경로는 config 디렉터리 기준이며, 설정은 시작 때 고정한다.
  선택한 native graph는 호출마다 제한된 크기로 새로 읽는다.
- JSON 설정의 잘못된 필드·경로 등록 형식·정수 한도·locator·환경 변수 충돌을
  거부한다. 클라이언트의 connection ID를 파일 경로로 해석하지 않는다.
- CLI/MCP `compare`, `validate_observation`, 관측 baseline은 native envelope를
  그대로 받는다. 내부 관측과 receipt의 source/plan/result digest, 선택한
  identity 매핑 범위를 검사한다. 비교 결과의 `nativeSources`에 두 원본 identity가 남는다.
- CLI의 비교·검증·graph-import·HSWM 입력 파일도 크기를 제한해서 읽는다.
- `skills/usl`은 references와 함께 복사해 독립적으로 사용할 수 있다.
  현재 환경에 등록된 스킬 symlink는 같은 저장소 파일을 가리킨다.

## HSWM

`relation_synthesis_usl_v1/run.mts`의 기본값은 이제 `source-pins.v5.json`과
매번 새 timestamp/UUID 결과 파일이다. 잘못된 옵션과 pin 불일치는 결과 파일
생성 전에 거부한다. `--check-pins`는 pin 검증만 수행하고 관측하지 않는다.

v1–v4 manifests와 기존 attempts는 보존했다. v5에는 현재 소스 48개
(HSWM 13개, USL 35개)를 고정했다. [v5 갱신 기록](platform-completion-hswm-pins-2026-09-08.json)과
[실제 기본 pin 검사](platform-completion-hswm-check-2026-09-08.log)를 남겼다.
변환 규칙은 `property-graph/v2`를 유지하며 기존 v2 fixture plan digest도 유지된다.
현재 runner를 historical v4 소스로 오인하는 재현 안내도 정정했다.

## 검증

- `npm test`: **199 passed**, 실패·skip 없음.
- `npm run typecheck`, `npm run build`, skill `quick_validate.py`, `git diff --check` 통과.
- HSWM runner CLI 회귀 테스트 **3 passed** 및 Effect runtime 타입 검사 통과
  (HSWM 개발 episode `03482ae7-0c9e-48ab-9bfe-730883789255`).
- 기본 `--check-pins`: **PINS_VALID, 48 bindings, observation NOT_RUN**.
- [실제 실행 smoke](platform-completion-smoke-2026-09-08.json): built CLI 탐색,
  deny-all 조회 0회, 허용한 로컬 파일 조회 2회, envelope 검증·비교,
  관계 방향 반전의 의미 변경 감지, 설정 기반 stdio MCP의 9개 도구,
  built MCP 실행 파일, 기존 HSWM Python 소비자의 READY 확인.

Receipt는 내부 일관성 checksum이며 서명·의미적 참·권한 증명이 아니다.
HSWM READY는 pin이 맞는 참조의 가용성이다. 실제 모델 토큰 절약률이나
Cypher 대비 효용을 새로 측정한 결과는 아니다.

설계 확인에는 공식 [MCP TypeScript SDK v2 서버 문서](https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-server)를 사용했다.
