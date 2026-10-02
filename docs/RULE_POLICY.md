# 선택형 규칙 강제 수준과 가중치

기존 `rule / target / configuration / consumer` 바인딩에 선택형
`usl-rule-policy/v1` 계약을 추가했다. 필수 조건, 권고 감점, 참고 정보를 구분하며
규칙 선언과 평가 결과를 별도 자원으로 보존한다. 코어 `.usl`, resource graph,
기존 `DomainProfile`의 엄격한 구조 검사는 변경하지 않는다.

사용자가 전달한 `metahumotonic_dashboard` 피드백과 구축 요청은
[원문 기록](../research/rule-policy/request.json)에 보존한다. 외부 대시보드의
원문을 직접 조회한 기록은 아니며, 필드명·계산식·예제는 AI 구현 선택이다.

## 계약과 평가 의미

| 필드 | 계약 |
|---|---|
| `id`, `version` | policy 및 개별 규칙의 안정적인 ID와 버전 |
| `target`, `consumer`, `scope` | 적용 대상·해석 프로그램·범위. 접근 권한을 부여하지 않음 |
| `requirement` | `REQUIRED`, `RECOMMENDED`, `INFORMATIONAL` |
| `severity` | `VIOLATION`, `WARNING`, `INFO`. 표시용이며 통과/거부와 별개 |
| `onViolation` | `BLOCK`, `WARN`, `PENALIZE`, `RECORD` |
| `weight` | `PENALIZE`만 `(0,1]`, 그 외 0. 신뢰도나 확률이 아님 |
| `evaluator` | 술어 검사 구현의 ID와 버전. 문자열로 코드를 로드하지 않음 |
| `conflictPolicy` | v1은 `REJECT`. 보고된 충돌을 가중치로 숨기지 않음 |
| `scoring` | `WEIGHTED_MEAN_VIOLATION_V1` |

필수 규칙은 `BLOCK`, 권고 규칙은 `WARN` 또는 `PENALIZE`, 참고 규칙은
`RECORD`를 사용한다. 충돌하는 조합, 중복 ID, 미지원 dialect와 알려지지 않은
필드는 거부한다. JSON Schema는 구조를 명시하고 조합·중복·참조·digest 조건은
TS 검사가 추가한다. 임의 JSON 보존과 이 계약의 해석은 구분한다.

`evaluateRulePolicy`는 **소비자가 제공한 관측을 분류하는 순수 참조 소비자**다.
평가 코드를 실행하거나 근거의 사실성을 입증하지 않는다. 호출자가 그래프와
별도로 등록한 policy digest, consumer ID, 대상 snapshot digest, scope, 지원 evaluator 버전을 제공한다.
관측의 policy digest·대상·scope가 다르면 거부한다.

관측에는 규칙/평가자 버전, 시각, 상태, 위반 정도, 근거 자원 ID/digest가 들어간다.
`PASS`의 위반 정도는 0, `FAIL`은 `(0,1]`, `UNKNOWN`은 null이다. 알려진 결과에는
대상 snapshot의 근거가 필요하다. 내용·시각·지원 목록의 진실성과 최신 여부는
소유 소비자의 책임이다. hash는 서명이나 인가가 아니다. 예제의 대상 digest는
실제로 읽은 UTF-8 파일 바이트의 SHA-256이다.

| 상황 | 결정 / 평가 |
|---|---|
| 보고된 규칙 충돌 | `CONFLICT`, penalty 없음 |
| 필수 규칙 실패 | `BLOCKED`, penalty 없음 |
| 필수 규칙 UNKNOWN·미지원·미평가 | `UNDETERMINED`, penalty 없음 |
| 필수 통과, 다른 규칙 미평가 | `ELIGIBLE`, coverage `INCOMPLETE`, penalty 없음 |
| 필수 통과, 모든 규칙 평가 | `ELIGIBLE`, coverage `COMPLETE`, penalty 계산 |

`penalty = Σ(weight × violation) / Σ(weight)`이며 `PENALIZE`만 포함한다.
대상 규칙이 없으면 0이다. 0이 가장 좋고 1이 가장 나쁘다. 같은 policy digest와
scope, 호환되는 평가 기준 안에서만 비교한다. 필수 실패는 권고 점수로 상쇄되지
않으며, 미평가 항목을 분모에서 빼서 순위가 좋아지는 것도 허용하지 않는다.
개별 결과를 보존하므로 경고와 감점 이유를 표시할 수 있다.

`ELIGIBLE`은 이 규칙 집합에 따른 적격 판정이며 실행 허가가 아니다.
실제 차단·경고 표시·정렬은 소비 프로그램이 담당한다. 자동 충돌 탐지, 예외 승인,
우선순위 추론, 원격 평가자 driver는 v1에 포함하지 않는다.

## 사용

```sh
npm run example:rule-policy
```

[예제 소비자](../examples/rule-policy-workflow.ts)는 fixture 레코드의 참조 대상
존재, 원문 주소 기재, 태그 존재를 실제 검사한다. 필수 규칙 1개와 권고 규칙 2개로
기본 결과는 `ELIGIBLE`, `COMPLETE`, penalty 약 `0.6`이다. 원문 주소의 기재만
확인하고 주소나 주장의 사실성을 검증하지 않는다. 실제 대시보드 연결이나 그
프로젝트의 승인된 업무 규칙은 아니다.

```ts
import { readRulePolicyBinding, evaluateRulePolicy } from "usl/rule-policy"

const policy = readRulePolicyBinding(graph, configurationResourceId)
const report = evaluateRulePolicy(policy, ownerObservations, {
  expectedPolicyDigest: registeredPolicyDigest,
  consumer: registeredConsumerId,
  target: selectedTargetId,
  targetDigest: currentTargetDigest,
  scope: selectedScope,
  supportedEvaluators: registeredEvaluators,
})
```

선택해서 import하는 subpath이며 기본 adapter나 MCP tool이 자동 실행하지 않는다.
`readRulePolicyBinding`은 선택 configuration의 규칙마다 정확히 한 binding이
있는지, target/consumer/타입/버전이 맞는지 확인한다. 일반 graph 구조 검사만으로
이 평가 의미가 검증되는 것은 아니다.

## 표준 그래프와 관계 계약

[공학 그래프](../research/rule-policy/graph.json)는 요청·표준·구현·테스트 정의·
한계·예제 결과를 연결한다. [JSON-LD](../research/rule-policy/graph.jsonld),
[profile](../research/rule-policy/profile.json),
[정책 RDF 투영](../examples/fixtures/rule-policy/policy.jsonld),
[SHACL shapes](../schemas/rule-policy/policy.shacl.ttl)를 제공한다.

| 관계 | 역할과 domain/range | 의미 / cardinality |
|---|---|---|
| 기존 `applies_binding_rule` | rule: BindingRule, target: BindingTarget, configuration: BindingConfiguration, consumer: Program | 각 역할 1개. 선택 configuration에서 규칙마다 1개. 적용 선언 |
| `urn:usl:rule-policy:evaluated_policy` | configuration: BindingConfiguration, target: BindingTarget, consumer: Program, result: Evaluation | 각 역할 1개. 설정별 여러 과거 결과 가능. 결과 출처 연결 |
| `urn:usl:rule-policy:realized_by` | task: Task → feature: Feature | 역할별 1개. 요청을 반영한 작업과 구현 기능 연결 |
| 기존 `implemented_by` | feature: Feature → artifact: Artifact | 역할별 1개, feature별 여러 구현 가능 |
| 기존 `tested_by` | feature: Feature → evidence: TestEvidence | 역할별 1개. 테스트 정의 연결이며 실행 성공이 아님 |
| 기존 `bounded_by` | feature: Feature → limitation: Limitation | 역할별 1개. 보장 범위 제한 |
| 기존 `informed_by` | task: Task → source: ExternalSource | 역할별 1개. 요청/표준 출처 |

모든 link는 `DECLARED`다. 역방향 탐색도 역할을 바꾸지 않는다. 새 관계는 로컬
profile에 등록하며 공유 KG에 게시하지 않는다. 전체 그래프의 비순환성을 요구하지
않는다. RDF의 `rp:Policy → rp:rule → rp:Rule`은 규칙 1..256개, 각 Rule의
version/requirement/severity/onViolation/weight/evaluator/evaluatorVersion은 각 1개다.
target/consumer/evaluator는 IRI 참조다. 현재 예제의 명시적 exporter이며 임의 RDF
입력의 무손실 변환기는 아니다.

2026-10-02 표준 확인과 적용 범위:

- [SHACL 2017 Recommendation](https://www.w3.org/TR/2017/REC-shacl-20170720/):
  독립 pySHACL 검사에 사용. severity 자체는 실행 정책을 정하지 않는다.
- [SHACL 1.2 Core 2026-09-18 Working Draft](https://www.w3.org/TR/2026/WD-shacl12-core-20260918/):
  `sh:conformanceDisallows`를 설계 참고로 사용. draft 구현은 주장하지 않는다.
- [RDF 1.2 Concepts](https://www.w3.org/TR/rdf12-concepts/): 확인 당시 Candidate
  Recommendation Snapshot. 버전 상태를 기록하며 RDF 1.2 전체 지원은 주장하지 않는다.
- 기존 JSON-LD/RDF exporter와 [PROV-O](https://www.w3.org/TR/prov-o/)로 출처·활동·
  주체를 연결한다. `urn:usl:rule-policy:`는 프로젝트 로컬 어휘다.

## 이동·인계와 검증

대상 locator는 기존 `bind-graph`로 변경한다. policy ID·버전·규칙·설정·scope와
역할은 보존된다. policy digest는 절대 경로를 포함하지 않는다. 대상 내용이 바뀌면
새 snapshot 관측이 필요하고, 규칙/가중치가 바뀌면 이전 policy 결과를 재사용할 수
없다. 새 소비자가 지원하지 않는 evaluator는 `UNSUPPORTED`다. 자동 파일 재발견이나
새 환경 접근 권한은 부여하지 않는다.

공학 그래프의 소스에도 [portable bindings](../research/rule-policy/bindings.json)와
저장소 상대 root를 사용하는 [host](../research/rule-policy/host.json)를 제공한다.

```sh
npm run usl -- bind-graph --config research/rule-policy/host.json \
  --graph research/rule-policy/graph.json --selections research/rule-policy/selections.json
npm run rule-policy:build
npm run rule-policy:check
node --import tsx --test test/rule-policy.test.ts
npm run rule-policy:standards
```

Python 의존성은 `scripts/requirements-standards.txt`에 고정돼 있다. builder는
JSON/RDF·schemas·예제 관측/결과를 재생성하며 `--check`는 현재 소스 digest와 산출물
일치를 확인한다. 과거 테스트 성공 증거를 만들지 않는다. 저장된 예제 시각은 고정
fixture clock이며 실행 시각이 아니다. 실행 예제는 현재 관측 시각을 쓴다.

TS 반례는 hard/soft 분리, 미평가/미지원, snapshot/버전 교체, 근거 누락, 충돌·중복,
바인딩 변조, 실제 폴더 이동과 캐시 없는 JSON 인계를 검사한다. 독립 SHACL 검사와
SPARQL 질의는 규칙의 강제성·가중치, 대상·소비자를 확인하고 잘못된 수치·action·
역할·타입을 거부한다. 전체 표준 준수·실제 서비스 효과·의미의 참·Lean 증명과는
구별한다.

기존 공학/CLI 소스 pin은 변경 뒤 실제 검사를 재실행해 새 영수증으로 갱신한다.
이전 기록은 [공학 history](../research/engineering/history/before-rule-policy.receipt.json),
[바인딩 history](../research/architecture/history/binding-delivery-before-rule-policy.receipt.json),
[CLI history](../research/architecture/history/core-cli-c01-before-rule-policy.receipt.json)에
원래 바이트 그대로 보존한다.
