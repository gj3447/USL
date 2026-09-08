# USL: 인터넷 공간의 시멘틱 어댑터 — 다음 문법 설계안

2026-09-07 · 2026-09-08 보강 · Codex · T0 설계 조사 · SECONDARY_AI · **제안 문법, 현재 parser 미지원**.

[양방향 연결·에이전트 설계](BIDIRECTIONAL_AGENT_DESIGN.md)는 이후 보강 계약이다. 역할 기반 양방향 탐색과 `context` API/CLI는 구현했고, 의미 inverse·operation 계획/실행·보상은 후속 설계로 구분한다. 추가 자원 축은 [연결 대상 조사](RESEARCH_CONNECTION_GAPS_2026-09-08.md)에 있다.

## 사용자 방향과 현재 구현

사용자 원문 U7:

> 구체적인 문법 어케해야지 지금 ai 공학적으로 인터넷 공학적으로 pc 컴퓨터 공학적으로 모든걸 싹다 이어주는것이 가능할까 ㅇㅇ? 어답터임 시멘틱의 어답터 인터넷 공간속의 ㅇㅇ

USL의 지향은 인터넷 공간에서 이질적인 자원들을 의미를 통해 이어 주는 어댑터다. 앞선 U6의 KG·Git 저장소·URL·파일시스템 경로가 출발점이다. 데이터 포맷 변환을 중심 개념으로 삼지 않는다.

현재 runtime v0.3 / language v0.1은 `resource / meaning / link`, 순수 parse/compile, Effect 관측, 검토 대상 KG 번들 투영을 구현했다. 이 문서의 import, 모듈 타입, adapter, bind, 경로 합성, 검증기·권한 계약은 **아직 구현되지 않은 다음 설계**다. 현재 parser가 이 예제를 받아들이거나 모든 시스템에 접속한다는 뜻이 아니다.

## 목표를 실행 가능한 정의로 바꾸기

**어떤 자원이든 등록된 어댑터를 통해 공통의 자원 참조·의미·관측 계약을 제공하면 USL 연결망에 참여할 수 있게 한다.**

새 시스템이 등장했을 때 언어 코어를 매번 바꾸지 않는 것이 보편성의 기준이다. 새로운 인터넷 서비스·OS 자원·AI 도구마다 접속 구현과 의미 매핑은 필요하다. 자원 기술, 구조적 호환성, 의미 관계, 권한 있는 동작의 성공을 각각 평가한다. 닫힌 API, 접근할 수 없는 자원, 정의되지 않은 의미까지 문법만으로 자동 연결할 수는 없다.

## 코어가 알아야 할 것

| 요소 | 코어 계약 | 확장 위치 |
|---|---|---|
| 자원 참조 | 이름/ID, 자원 타입, 위치, 관측 버전 | driver의 식별·주소 스키마 |
| 의미 | 이름공간 있는 의미 ID, 역할, 설명, 제약 | 버전 있는 의미 모듈과 KG |
| 링크 | 의미와 역할별 참여자, 선언 출처 | 기존 `link` |
| 어댑터 | 역할 포트, 요구 기능, driver, 산출 주장·근거 | 새 `adapter` |
| 바인딩 | 어댑터 포트에 실제 자원 지정 | 새 `bind` |
| 관측 | 시각, 자원 revision/hash, driver 버전, 결과·범위 | Effect 런타임 |
| 활동·시도 | 실행 정의/version, 입력·출력, 시작·종료·실행 주체 | build/query/inference 등 driver profile |
| 범위·부분 | host/cluster/document/session, snapshot에 결합된 selector, 유효 기간 | 자원별 descriptor와 관측 계약 |
| 에이전트 context | 원래 의미·전체 역할·양방향 경로, 탐색 범위·한계 | 현재 `agentContext`와 후속 operation planner |

기존 `kg | url | git_repo | filesystem` 닫힌 union은 **등록된 자원 종류와 버전 있는 descriptor schema**로 확장한다. 사용자 문법은 `git.Repository`, `fs.Directory`, `http.Document`, `kg.Node`, `mcp.Tool`처럼 읽고, 내부에서는 모듈이 지정한 전역 type ID로 해석한다. 단순한 `any`나 임의 문자열을 받아 검사를 우회시키지 않는다.

타입은 두 축이다. `git.Repository`는 접속·표현 방식이고, “USL의 구현”은 의미 역할이다. Git 저장소라는 구조 타입만으로 특정 KG 개념을 구현한다고 판단할 수 없다.

## 이름과 주소

자원 참조 ID, 접속 주소, 특정 시점의 버전을 분리한다. 경로 이전으로 선언의 참조 ID가 바뀌거나, 같은 URL이라는 이유만으로 다른 시점의 내용을 같은 것으로 취급하지 않는다. 참조 ID는 언어 안의 식별자이며 현실 대상의 동일성을 자동 증명하지 않는다. 제공자가 안정적인 object ID를 제공하면 driver의 identity evidence로 보존한다.

기존 주소 문법과 충돌을 줄이기 위해 native 위치와 driver 정보를 구조적으로 분리한다. 예를 들어 Git은 원격 URL + revision + path, 파일시스템은 host + absolute path, KG는 graph source + UID다. 기존 USL의 `git://...@commit:path`는 호환 입력으로 둘 수 있지만 일반 Git URL과 상호 운용되는 표준 주소라고 주장하지 않는다. 문자열 접두만으로 접근 방법·의미를 모두 결정하지 않는다.

## 제안 표면 문법

아래 모듈과 함수 이름은 설계를 설명하는 예시이며 배포된 패키지가 아니다. `use`는 등록된 manifest를 정적으로 가져오는 구문이고 일반 JavaScript 실행이 아니다. manifest와 driver는 lockfile에서 정확한 버전·digest로 고정한다.

```usl
usl "next";
namespace "https://example.org/usl/project/";

use git from "usl:git@1";
use fs  from "usl:filesystem@1";
use kg  from "usl:kg@1";

resource repo = git.repository(
  remote: "https://github.com/acme/engine"
);
resource workspace = fs.directory(
  host: "dev-01", path: "/work/engine"
);
resource concept = kg.node(
  graph: "canonical", uid: "sym:Concept:engine"
);

meaning checkout_of(local: fs.Directory, repository: git.Repository) {
  id: "https://example.org/meaning/checkout-of";
  text: "디렉터리가 지정된 저장소의 로컬 checkout이다";
}
meaning implements(source: git.Repository, concept: kg.Node) {
  id: "https://example.org/meaning/implements";
  text: "저장소가 대상 개념을 구현한다";
}

adapter checkout(local: fs.Directory, repository: git.Repository) {
  driver: git.inspectCheckout;
  requires: [fs.read, git.read];
  emits: checkout_of(local: local, repository: repository);
  evidence: [origin, revision, observed_at];
}

bind working_copy = checkout(local: workspace, repository: repo);
link implementation = implements(source: repo, concept: concept);
```

`working_copy`는 지정한 두 자원에 어댑터를 적용하는 선언이다. 실행 시 driver는 Git 루트·설정된 remote·HEAD 등을 관측하고 의미 주장의 근거를 돌려준다. driver가 실제로 무엇을 검사했는지는 버전 있는 계약에 명시한다. 로컬 remote 설정의 일치만 관측했다면 원격 저장소 전체와의 동일성까지 검증했다고 보고하지 않는다.

`implementation`은 작성자가 선언한 의미 관계다. checkout 관측 성공으로 이 관계까지 검증되지는 않는다. “이 저장소가 이 개념을 구현한다”를 검증하려면 해당 주장에 맞는 별도 검사와 근거가 필요하다.

`text`는 인간 설명, `id`는 공유 가능한 의미의 지칭, 역할 타입과 제약은 검사 가능한 계약이다. 같은 ID를 썼다고 서로 다른 참여자가 그 의미를 올바르게 구현한다는 보장은 없으며, 모듈 버전·제약·관측 근거를 함께 확인한다.

## 어댑터의 TypeScript + Effect 경계

다음은 구현 방향을 설명하는 타입 모양이다. 숨은 전역 환경 대신 필요한 서비스를 Effect의 요구사항으로 표현한다.

```ts
interface SemanticAdapter<Ports, Claim, E, R> {
  readonly id: string
  readonly version: string
  readonly run: (
    ports: Ports
  ) => Effect.Effect<{
    readonly claim: Claim
    readonly evidence: readonly Evidence[]
    readonly assessment: "Supported" | "Refuted" | "Unjudged"
  }, E, R>
}
```

실제 공통 ABI에는 포트 및 결과의 런타임 schema, 지원 자원 종류, driver digest, 필요한 capability, revision 선택 규칙을 더 둔다. `Evidence`는 출처 locator, 시각, 관측 버전, 원문/산출물 지문, 수행한 검사 ID를 담는다. `Supported`는 그 계약의 검사 범위에서 지지된다는 뜻이며 KG 정전의 `RATIFIED` 상태와 다르다. 임의 adapter가 붙인 상태 표식만으로 신뢰를 획득하지 않는다.

- 순수 코어: parse → name/type resolution → capability plan → semantic plan.
- Effect 서비스: driver registry, resource resolver, credential handle, clock, evidence sink.
- 쓰기 작업: 별도 capability 계약. `link`, `bind` 선언과 자동으로 결합하지 않는다.
- 네트워크에서 받은 driver 코드·의미 모듈은 선언만으로 자동 실행하지 않는다. 등록·버전 고정·검사된 driver를 사용한다.

## 연결의 합성

USL은 연결 결과를 다시 지칭할 수 있어야 한다. 경로 탐색은 원래 간선들을 유지한 trace를 반환한다. 예를 들어:

`디렉터리 —checkout_of→ 저장소 —implements→ KG 개념 —documented_by→ URL`

이 경로를 따라 관련 자원을 찾고 필요한 어댑터를 선택할 수 있다. `checkout_of ∘ implements`에서 새로운 단일 관계를 도출하려면 그 합성을 허용하는 규칙을 별도로 정의해야 한다. 그래프 경로 존재와 의미 함의는 다르다. 구현 초기에는 추론을 늘리기보다 경로와 근거를 보존하는 탐색을 우선한다.

현재 `agentContext`는 `resource → link instance → resource`를 어느 역할에서도 탐색한다. 원 link·전체 참여자·의미 설명과 입력 plan digest를 보존한다. 역방향 탐색, 명시된 의미 inverse view, 실행 보상은 각각 다른 계약이다. inverse 선언 없이 관계 이름을 뒤집거나 반대 동작을 발명하지 않는다. 에이전트에는 FOUND와 범위 내 미발견, 탐색 한도로 인한 미발견을 구분해 반환한다. 상세 계약과 현재 CLI는 [양방향 설계](BIDIRECTIONAL_AGENT_DESIGN.md)에 있다.

실행 어댑터끼리의 합성은 산출 자원/값의 타입, 버전 및 요구 capability가 다음 포트 계약에 맞을 때 허용한다. 두 어댑터의 구조적 입출력이 맞는다는 사실만으로 의미가 보존된다고 판정하지 않는다. 재귀 규칙·무제한 도구 호출을 기본 문법에 넣지 않고, 실행 단계 수와 시간을 계획에 기록한다.

## AI·인터넷·PC 영역에 붙이는 방식

| 영역 | 예시 driver가 노출할 것 | 의미와 연결 |
|---|---|---|
| 인터넷 | HTTP document, API endpoint, server object ID | 문서·근거·구현·서비스 관계 |
| Git | repository, commit, tree, symbol 참조 | 구현·변경·버전 관계 |
| PC/OS | host, directory, file, process/resource handle | checkout·실행·설정·소유 관계 |
| KG | graph source, node, relation, bounded query | 개념·정의·주장·다른 자원의 의미 |
| AI 도구 | MCP tool/resource, 모델·실행·산출물 참조 | 어떤 도구/모델이 어떤 자료로 어떤 결과를 냈는지 |

AI는 schema에 맞는 프로그램을 작성하거나 연결 후보를 제안할 수 있다. 컴파일러는 이름·타입·필수 포트 등을 검사하고, runtime은 접근·검사 결과를 기록한다. schema 통과를 의미적 진실로, 모델 생성물을 자동으로 사용자 정전으로 바꾸지 않는다. 도구를 발견할 수 있어도 실제 사용 권한·세션·구현이 없으면 실행 결과는 미해석/거부로 남는다.

## 표준에서 재사용할 부분

아래는 USL 자체의 정전이 아니라 설계에 참고한 1차 기술 소스다.

- [RFC 8288 Web Linking §2](https://www.rfc-editor.org/info/rfc8288/): 문맥·관계 종류·대상·속성으로 링크를 기술한다. USL의 관계 기술이 기존 웹 링크와 매핑될 수 있는 출발점이다.
- [JSON-LD 1.1 §3.1](https://www.w3.org/TR/json-ld11/#the-context): 지역 용어를 IRI에 대응시킨다. USL 의미 모듈의 공유 이름과 그래프 내보내기에 참고한다. JSON-LD만으로 실행 어댑터나 의미적 동등성이 구현되지는 않는다.
- [W3C WoT Thing Description 1.1 §1.1](https://www.w3.org/TR/wot-thing-description11/#thing-description): 자원 설명, 상호작용, schema, 접속·보안 정보, 링크 및 의미 주석을 함께 다룬다. 이질적인 시스템을 공통 설명과 실제 protocol binding으로 잇는 선례이며, USL 전체가 WoT 규격이라는 주장은 아니다.
- [SHACL](https://www.w3.org/TR/shacl/): RDF 그래프에 대한 제약 검증을 정의한다. 향후 RDF 투영에서 역할·cardinality 등 그래프 제약을 검사할 수 있다. 현재 Neo4j에 SHACL을 직접 적용한다고 주장하지 않는다.
- [MCP Tools, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools): 도구의 이름·설명·입출력 schema를 제공한다. 이 버전의 계약을 AI 도구용 driver 설계 참고로 사용한다. 실제 서버의 협상 버전과 지원 기능은 런타임에서 확인한다.
- [Effect 서비스](https://effect.website/docs/v3/requirements-management/services): 서비스 요구사항과 구현 제공을 분리한다. USL의 IO driver를 `Context`/`Layer`로 공급하는 구현과 연결된다.

실행 표현의 기준은 버전 있는 USL AST/IR로 잡고, 사람이 쓰는 `.usl`과 AI가 생성하는 JSON AST를 동일한 검증 경로로 통과시킨다. JSON-LD는 별도 그래프 교환 투영으로 둔다. 드라이버 능력이나 credential을 JSON-LD 의미 관계와 혼합하지 않는다.

## 다음 구현 순서

역할 기반 양방향 탐색과 에이전트 선언 context를 먼저 구현했다. 이후 순서는 다음 제안이다.

1. snapshot·시점·scope를 가진 관측 결합과 의미 inverse view를 정의·구현한다.
2. 자원 descriptor·kind·driver/operation registry를 열고 기존 네 resolver를 그 계약의 구현으로 이식한다.
3. `use / adapter / bind`와 버전·역할·capability 정적 검사, 목표별 후보·계획 계약을 추가한다.
4. `checkout_of` 어댑터 하나를 파일시스템↔Git 저장소에서 실측하고 제한된 Effect 실행·평가 루프로 검증한다.
5. 근거 있는 바인딩·선언·관측을 각각 보존해 투영하고 HTTP·KG·MCP driver와 명시적 합성 규칙으로 확장한다.

이 순서는 구현 제안이다. U7 자체가 모든 세부 문법·표준 채택·새 쓰기 권한을 비준한 것으로 취급하지 않는다.
