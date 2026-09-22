# USL AI native 어댑터 개발 로드맵

작성일: **2026-09-22** · 원안 기준 커밋: `250b493` · 상태: **단계별 구현 중**. 아래 계획 원안과 완료된 범위를 구분한다.

후속 구현: 같은 날짜의 사용자 요청으로 [공학 보완 계약](ENGINEERING_CONTRACTS.md)과 [40항목 검증 그래프](ENGINEERING_ADVERSARIAL_MATRIX.md)를 추가했다. 아래 원래 계획 전체를 완료한 것은 아니다. P0는 SDK descriptor/발견과 MCP tools·OpenAPI 3.1의 제한된 순수 importer, P1은 역할 타입/metadata 및 손실 gate, P3는 host callback의 사전 검사·단일 시도·불명 결과까지 구현했다. P2의 실제 SCIP/OpenLineage 연결, 범용 구독·durable 실행, P4의 외부 공학 driver는 남아 있다.

추가 진척: [등록된 기능 카탈로그](CAPABILITY_CATALOG.md)로 P0의 SDK·CLI·MCP 발견 경로를 연결했다. 같은 호스트 정책으로 사전 검사도 제공하며, 카탈로그를 설정한 MCP에서만 2개 tool이 추가된다. 기본 9개 tool과 임의 실행을 제공하지 않는 경계는 유지한다.

[유사 기술 조사](RESEARCH_AI_NATIVE_ADAPTERS_2026-09-22.md)를 실제 작업 단위로 옮긴다. 기존 사용자 방향인 문법·연결 계층, 원본 소유권 유지, TypeScript + Effect, Lean 연동을 따른다. 아래 타입 이름·파일 이름·순서는 구현 제안이며 사용자 결정 기록이나 새 공개 API가 아니다.

목표는 **새 도메인과 프로토콜을 adapter/profile로 추가하면서 AI가 연결의 의미·조건·근거를 확인할 수 있는 구조**다. 현재의 KG를 대체하거나 별도 USL DB를 요구하지 않는다.

## 1. 최소 공통 계약

모든 필드를 지금의 `SemanticPlan`에 한꺼번에 넣는 대신, 버전 있는 선택적 계약으로 시작한다. 기존 plan·digest를 바꾸는 변경은 별도 migration과 호환성 검사가 있어야 한다.

| 제안 요소 | 담을 정보 | 책임 경계 |
|---|---|---|
| `ResourceRef` | owner/connection 범위, native ID, type IRI, 선택적 revision·selector·representation binding | 논리 자원과 읽기 표현을 구분. 경로·credentials를 AI 입력에서 임의 생성하지 않음 |
| `CapabilityDescriptor` | adapter ID/version, 지원 operation, 입력/출력 schema, domain profile, 지원 제약 | 할 수 있다고 기술한 능력. 실제 권한·건강 상태와는 별개 |
| `BindingRef` | 호스트가 등록한 connection/binding ID와 대응 operation | URL·실행 명령·credential의 실제 선택은 호스트 소유 |
| `DomainProfile` | 버전 있는 meaning IRI, 역할별 타입·cardinality, 선택적 단위/조건, 검사기 참조 | 자연어 설명의 보완. profile 밖의 동치·상속을 자동 추론하지 않음 |
| `MappingReport` | 보존한 필드, 변환, 누락, unsupported feature, profile/version | 손실 없는 변환과 부분 변환을 구분 |
| `EvidenceRef` | source snapshot, claim/check ID, checker 버전, 결과·범위·유효 시점 | 선언·관측·검사·추론을 각각 식별 |
| `InvocationPlan` / `ExecutionReceipt` | capability/binding·입력 digest·예상 효과·정책 판정 참조·attempt·결과·사후검사 | 실행기 소유. 발견·graph traversal만으로 호출을 시작하지 않음 |

어댑터가 제공하는 capability와 현재 호출자의 permission은 다른 정보다. 원본에서 받은 `readOnlyHint` 같은 설명만으로 인가하지 않는다. 이 구분은 [MCP tool annotation의 신뢰 경계](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)와 현재 USL의 소유자 정책 분리를 함께 반영한다.

`ResourceRef` 확장은 특히 별도 설계가 필요하다. 지금은 resource graph의 locator가 필수이므로, 접근 표현이 없는 대상을 연결하려면 원본 시스템이 제공하는 유효한 snapshot/표현을 사용해야 한다. 아직 지원하지 않는 `mcp://`, `sql://`, `lean://`를 임의로 유효 locator로 취급하지 않는다. 장기적으로 참조와 표현 binding을 분리할 경우 명시적 새 schema 버전으로 도입한다.

## 2. P0 — 기능 계약과 읽기 전용 발견

**첫 구현 대상:** 기존 `connectUsl` 위에 capability description을 추가하고, 소유자가 제공한 MCP/OpenAPI 명세를 순수 변환하는 입력 adapter를 만든다. 기존 읽기·관측의 권한 범위를 유지한다.

예상 작업 지점:

- 신규 `src/capabilities.ts`: versioned descriptor schema, 중복·참조·지원 feature 검증, 순수 기능 선택.
- 신규 `src/integrations/mcp-inventory.ts`, `src/integrations/openapi.ts`: 입력 명세 → resource/capability 표현 + mapping report.
- 기존 [adapters](../src/adapters.ts), [application](../src/application.ts), [MCP](../src/mcp.ts): 호스트 등록 descriptor를 조회하는 선택적 경로.
- 소유자 측 inventory 수집은 별도 IO callback으로 둔다. 원본 명세에 나온 주소를 순수 import 중 따라가지 않는다.

완료 조건:

1. 같은 입력을 두 번 해석하면 같은 plan·descriptor digest가 나온다.
2. MCP의 도구·자원, OpenAPI operation을 connection 범위의 native ID와 source digest로 추적한다. 누락된 `operationId`는 명세 snapshot + path/method 등 명시한 대체 규칙으로 식별한다.
3. schema를 읽었다는 이유로 업무 meaning을 확정하지 않는다. 확인된 매핑이 없으면 unbound 상태를 보존한다.
4. 지원하지 않는 schema keyword, 외부 `$ref`, pagination 불완전성을 조용히 버리지 않고 결과에 명시한다. 호스트 정책이 없으면 외부 `$ref`를 읽지 않는다.
5. 발견은 등록된 connection 안에서만 동작하고 실제 `tools/call`, mutation, 임의 URL fetch는 발생하지 않는다.
6. 기존 v1 plan·기존 adapter·MCP 9 operation의 결과와 정책 동작이 유지된다. 새 capability API는 명시적 추가다.

검증: 실제 명세를 축소한 고정 fixture로 입력 검증·ID 충돌·기능 선택·unknown feature·IO 없음·호환성을 검사한다. 기대 결과를 구현으로 다시 생성하는 테스트 대신, 서로 다른 두 명세에서 같은 의미 조건을 만족하는 기능을 선택하는 사례를 넣는다.

산출물은 **기능을 설명하고 찾을 수 있는 USL**이다. 이 단계의 `invoke`는 지원하지 않는 것으로 명확히 반환한다.

## 3. P1 — 의미 profile과 변환의 적합성

P0의 선택 로직에 도메인 역할 타입과 변환 계약을 추가한다. [LinkML](https://linkml.io/linkml/generators/), [SHACL](https://www.w3.org/TR/shacl/), [SKOS](https://www.w3.org/TR/skos-reference/)는 profile과 교환의 참고점이며 모두를 필수 runtime dependency로 넣는 제안은 아니다.

작업:

- `MeaningContract`의 선언 검사와 실제 실행된 검사 결과를 별도 객체로 구분한다.
- 역할별 허용 type IRI·cardinality·schema version을 검증한다. 초기 버전은 명시적 일치/등록 매핑에 한정한다.
- 단위가 필요한 profile에서 quantity kind·dimension·단위를 검사하고, 변환이 필요하면 등록된 변환과 가정을 기록한다.
- `MappingReport`에서 손실 없음, 변환됨, 일부 손실, 미지원의 구분을 정의한다. 이름은 schema 설계 때 확정한다.
- 제한된 JSON-LD profile부터 수입을 지원한다. 임의 RDF 전체를 v1 resource graph로 무손실 변환한다고 주장하지 않는다.

완료 조건:

1. `Requirement` 역할에 `Dataset`만 선언된 자원을 넣으면 profile 검사에서 구체 이유와 함께 실패한다.
2. 같은 숫자 schema라도 시간·길이처럼 dimension이 다르면 연결을 거부한다. 온도 단위 변환처럼 조건이 있는 변환은 명시적 adapter를 요구한다.
3. 다자 링크·역할·native ID·provenance의 지원 범위 내 왕복 보존을 검사한다. 이항 형식으로 내보낼 때 사라지는 정보를 표시한다.
4. `closeMatch` 연쇄에서 `exactMatch`나 물리적 동일성을 자동 생성하지 않는다.
5. profile 검사 성공과 실제 관계의 참을 결과 필드에서 구분한다.

공통 schema의 성장을 관리하기 위해 처음에는 **소프트웨어 요구사항/코드/시험**과 **측정량** 두 profile만 사용한다. 두 도메인에서 필요한 차이를 확인한 뒤 코어를 확대한다.

## 4. P2 — 실제 코드 심볼과 실행 근거

기존 Lean 연결에 일반 코드와 실행 근거를 붙여서 end-to-end 가치를 확인한다.

작업:

- [SCIP](https://github.com/scip-code/scip/blob/main/docs/scip.md) index importer: 저장소·commit·indexer version·package·symbol·occurrence 연결. 직접 LSP 호출은 세션 수명 계약을 추가한 뒤 검토한다.
- [OpenLineage](https://openlineage.io/docs/spec/object-model/) importer: job 정의, run, input/output dataset, 실제 제공된 dependency와 provenance를 구분한다.
- 빌드/시험의 실행 결과를 snapshot과 연결하고, 필요한 경우 [SLSA provenance](https://slsa.dev/spec/v1.1/provenance)와 [OpenTelemetry trace](https://opentelemetry.io/docs/concepts/signals/traces/)를 참조한다.
- adapter 구현·profile·checker version도 근거가 참조할 수 있는 자원으로 모델링한다.

완료 조건:

1. 요구사항 하나에서 정확한 commit의 symbol, Lean 선언, 시험 실행 결과로 탐색 가능하다.
2. 같은 이름의 symbol이 다른 package·revision에 있으면 혼동하지 않는다. stale index는 성공한 최신 해석으로 보고하지 않는다.
3. 시험 코드, 시험 run, 결과를 각각 식별한다. 재시도는 별도 attempt로 남는다.
4. Lean 정리의 가정·명제와 코드/요구사항 사이의 대응 주장도 명시한다. 정리 이름 일치로 대응을 확정하지 않는다.
5. 원본 revision이 바뀌면 어떤 관측·검사 결과를 다시 확인해야 하는지 출력한다. 기존 비교 기능을 재사용한다.

SCIP/OpenLineage의 순수 입력 변환은 P0 이후 시작할 수 있다. 역할의 도메인 적합성을 보장하는 완료 조건은 P1의 profile 검사에 의존한다.

## 5. P3 — 계획·실행·변경 구독

P0/P1의 계약이 정해진 뒤, **호스트가 등록한 executor**에 대한 실행 계획과 결과 계약을 추가한다. 기존 HSWM 준비 경로를 출발점으로 삼을 수 있으나 HSWM의 authority를 USL 그래프에서 생성하지 않는다.

작업:

- `InvocationPlan`: capability/profile/binding 버전, 입력 digest, 예상 effect, 필요한 scope, 비용·시간 제한, 사후검사.
- 호스트의 인가 결과와 실행 직전 revision 확인을 받아 executor에 전달한다. 만료·변경된 계획은 다시 검사한다.
- 결과에는 성공·실패뿐 아니라 timeout 후 결과 불명, 취소 요청, 부분 완료를 표현한다.
- idempotency 지원 여부를 binding이 명시한다. 결과 불명인 mutation을 무조건 재시도하지 않는다.
- 구독 가능한 binding에만 cursor·resume·중복 제거·backpressure·gap 감지 계약을 추가한다. [CloudEvents](https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md)는 envelope 참고다.
- 현재 snapshot 비교와 새 이벤트를 연결해 근거의 stale 상태를 갱신한다. 과거 영수증을 새 상태처럼 덮어쓰지 않는다.

완료 조건:

1. 순수 discovery/import/context는 executor를 호출하지 않는다.
2. 권한 없는 plan, 바뀐 snapshot, 초과 예산은 효과 발생 전에 거부된다.
3. 한 번 발생한 효과 뒤 응답이 끊긴 사례를 성공/실패로 단정하지 않는다. owner operation ID로 상태 확인을 지원한다.
4. 재시도·취소·부분 실패·이벤트 gap의 처리 결과를 고정 시나리오로 검증한다.
5. 서로 다른 시스템의 호출을 하나의 원자적 transaction처럼 표시하지 않는다. 보상 동작이 있으면 별도 효과로 기록한다.

첫 executor는 한 가지 명확한 로컬 검증 작업으로 제한해 계약을 검증한다. 외부 서비스 추가는 이 계약이 실제 실패 상황을 표현하는지 확인한 뒤 진행한다.

## 6. P4 — 공학 도구와 물리 도메인 확장

우선순위는 실제 사용할 수 있는 소유자 시스템과 fixture에 맞춰 정한다.

| 순서 | 후보 | 첫 성공 사례 |
|---|---|---|
| 1 | OSLC 또는 SysML v2 API | 실제 요구사항/모델 요소를 기존 코드·Lean·시험 연결에 추가 |
| 2 | WoT TD 또는 AAS | 장치/자산의 의미·기능·접근 binding을 가져와 발견하고 검사 |
| 3 | OPC UA | scope가 명확한 NodeId와 단위·시각을 가진 읽기 결과 연결 |
| 4 | FMI | model/FMU version, 변수, 입력, simulation run, 결과 연결 |
| 선택 확장 | A2A, DataHub/Egeria, Cube/dbt, MMT/CQL 연구 | agent task, metadata, metric 또는 형식 변환을 기존 profile로 연결 |

각 adapter는 새 문법 예약어 없이 추가되고, ID·역할·provenance·손실 보고·예산·정책 테스트를 공통으로 통과해야 한다. 테스트용 응답 변환, 실제 서비스 읽기, 실제 action 실행의 세 지원 수준을 구분해 문서화한다.

## 7. Lean 검증을 확대할 범위

현재의 [37개 모델 정리와 TS 대조](LEAN4_INTEGRATION.md#형식-검증-범위)는 유지한다. 다음 정리는 실행 가능한 계약이 먼저 정해진 뒤 추가할 후보다.

- 새 profile 검사기가 받아들인 링크는 모델에 명시한 역할·참조·타입 조건을 만족한다.
- 등록된 매핑의 전제하에서 합성이 타입 적합성을 보존한다. 외부 의미의 동치를 전제로 숨기지 않는다.
- 제안된 호출의 필요 scope가 owner scope를 넘지 않으며, 발견 데이터가 권한을 확장하지 않는다.
- 손실 없는 변환이라고 보고한 지원 부분집합에서 native ID·역할·필수 근거의 왕복 보존이 성립한다.
- 제한 예산을 초과한 계획은 모델의 effect 실행 전 단계에서 거부된다.

Lean 모델의 성질과 TS 구현의 실제 성질 사이에는 계속 대조 검사가 필요하다. 전체 구현에 대한 refinement proof를 제공하지 않는 한 그 범위를 명시한다. 호스트 callback·원격 시스템·LLM의 모든 행동을 이 정리들로 증명했다고 주장하지 않는다.

## 8. 단계별 검증과 도입 기준

각 구현 단계에서 바뀐 계약에 맞는 테스트를 추가하고 기존 호환성을 확인한다. 일반 TS 변경에는 `npm run typecheck`, 관련 테스트, `npm run build`를 실행한다. 공유 계약·공개 API를 바꾸면 `npm test`도 실행한다. Lean 모델 변경 시 `npm run test:lean`, RDF/SHACL 출력 변경 시 `npm run test:standards`를 추가한다. 문서는 `python3 scripts/check-docs.py`로 확인한다. 변경 완료 전 Git 커밋을 남기고 미해결 실패가 있으면 커밋과 보고에 적는다.

효과는 다음 baseline과 비교한다.

| 평가 | 비교 방식 | 기록할 값 |
|---|---|---|
| AI 작업 | 직접 도구 이용 vs USL 이용, 동일 질문·데이터·모델·권한 | 정답률, 근거 revision 오류, 부당한 검증 주장, 호출 수, bytes/tokens |
| 어댑터 확장 | 두 번째 도메인 adapter 추가 | 코어 수정 수, 구현 규모, 통과한 공통 계약 검사 |
| 대규모 연결 | 소규모 fixture와 더 큰 bounded owner response | p50/p95 지연, 메모리, 제한 초과 처리, 누락 상태의 정확성 |
| 변화와 실패 | schema 변경, stale snapshot, timeout, 중복 이벤트 | silent loss, 잘못된 재사용, 중복 효과, gap 미검출 |

성능 목표와 SLA는 아직 측정되지 않았다. 먼저 **P0 + 소프트웨어 profile + 기존 Lean을 잇는 한 사례**를 완성하고 측정한 뒤 확장 순서를 조정한다.
