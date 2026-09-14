# USL 시멘틱 어댑터: 선행 기술 조사와 설계 적용안

이 문서는 제목의 날짜에 수행한 조사 기록이다. 최신 구현은 [현재 구조](ARCHITECTURE.md)를 따른다. 조사 제안 전체가 구현된 것으로 읽지 않는다.

2026-09-07 · Codex 및 독립 조사 에이전트 3개 · T0 일반 공학 · SECONDARY_AI

사용자 조사 요청: “검색좀 해줘봐 전체적으로 ㅇㅇ”. 대상은 KG·Git 저장소·URL·파일시스템을 의미로 연결하는 언어이며, 구현 방향은 TypeScript + Effect다. 사용자 원문과 앞선 제안은 [설계 문서](SEMANTIC_ADAPTER_DESIGN.md), 현재 지원 문법은 [LANGUAGE.md](LANGUAGE.md)에 있다.

공식 규격, 프로젝트 문서, 원저자 자료를 의미 모델·식별·프로토콜·언어 구현 축으로 조사했다. 아래 버전은 **검토한 판본**이며 모두의 최신판이라는 뜻은 아니다. `main`·프로젝트 문서는 조사일의 가변 자료다. 검색 결과 개수로 독창성이나 완전성을 판단하지 않았다. 소스의 기능 설명과 USL 적용 제안을 분리한다.

## 조사에서 얻은 판단

USL을 설계할 선례는 충분하다. 조사한 자료 중 **공학 산출물의 연합 연결에는 OSLC**, **상호작용의 추상 설명과 프로토콜 바인딩에는 WoT Thing Description**, **의미를 가진 타입 모델과 여러 형식으로의 투영에는 LinkML**이 특히 가깝다. 이는 세 기술의 목적을 비교한 AI의 설계 판단이다. 각각의 표준·프로젝트를 USL과 동치로 보거나 단순히 합치면 범용 언어가 완성된다고 주장하지 않는다. [OSLC Core](https://docs.oasis-open-projects.org/oslc-op/core/v3.0/os/oslc-core.html), [WoT TD 1.1](https://www.w3.org/TR/wot-thing-description11/), [LinkML Schemas](https://linkml.io/linkml/schemas/index.html).

USL의 공통 코어는 자원 참조, 의미 관계, 어댑터 계약, 실행 관측을 연결하는 쪽으로 좁히는 것이 좋다. 네트워크·Git·OS·AI별 실제 접근은 기존 프로토콜과 드라이버가 맡는다. **새 자원 종류가 추가되어도 언어 코어를 고치지 않는 확장성**을 보편성의 기준으로 제안한다. 모든 자원에 자동으로 접근하거나 모든 의미를 자동 판정한다는 보장은 아니다.

## 1. 가장 가까운 선행 체계

| 자료 / 검토 상태 | 자료가 제공하는 것 | USL에 적용할 부분과 경계 — AI 제안 |
|---|---|---|
| [OSLC Core 3.0](https://docs.oasis-open-projects.org/oslc-op/core/v3.0/os/oslc-core.html) · OASIS Standard, 2021 | HTTP·RDF 기반으로 여러 공학·수명주기 도구의 자원을 연합 연결. 발견, 자원 형태, 질의 등 공통 계약 | 각 도구가 자기 자원을 소유하면서 의미 있는 참조를 노출하는 모델. 로컬 파일·Git·Effect 어댑터까지 이 규격이 이미 구현한다고 해석하지 않는다. |
| [WoT Thing Description 1.1](https://www.w3.org/TR/wot-thing-description11/) · W3C Recommendation, 2023 | Thing 메타데이터, property/action/event, 데이터 스키마, 보안 정의, forms를 통한 실제 접근 설명 및 의미 주석 | 추상 기능과 프로토콜 바인딩 분리. USL의 adapter manifest에 참고. 모든 자원 관계의 참을 검사하는 체계는 아니다. |
| [LinkML](https://linkml.io/linkml/schemas/index.html) · 프로젝트 모델링 언어 | classes·slots·types, URI·매핑, 여러 스키마·코드 생성 대상. 문서에 JSON Schema·JSON-LD·RDF·SHACL·TypeScript 생성기 포함 | 하나의 의미 모델을 여러 소비자에게 투영하는 구조. 생성기별 표현력 차이를 검사해야 한다. USL 런타임을 Python으로 바꿀 이유가 되지 않는다. |
| [Linked Data Platform 1.0](https://www.w3.org/TR/ldp/) · W3C Recommendation, 2015 | HTTP를 통한 RDF/비RDF 자원 접근과 컨테이너 관리 | 웹 자원 collection과 native HTTP 동작의 선례. USL의 전역 의미 모델이나 모든 로컬 시스템 실행 계약까지 제공하지 않는다. |
| [SAWSDL](https://www.w3.org/TR/sawsdl/) · W3C Recommendation, 2007 | WSDL·XML Schema 요소에 의미 모델 참조와 lifting/lowering schema mapping 연결 | 의미 정의와 구체 서비스 표현을 연결하는 오래된 선례. 형식 변환은 가능한 어댑터 기능 하나이며 USL 전체의 중심으로 삼지 않는다. |
| [OWL-S](https://www.w3.org/Submission/OWL-S/) · W3C Member Submission, 2004 | 서비스 profile·process·grounding을 통한 의미 기반 서비스 기술 | 의미와 실행 grounding을 나누는 역사적 설계 참고. W3C Recommendation으로 표기하지 않는다. |
| [SSWAP 원논문](https://pmc.ncbi.nlm.nih.gov/articles/PMC2761904/) · 연구 프로젝트, 2009 | 의미를 명시한 데이터·서비스의 기술·발견·상호작용 프로토콜 | 시멘틱 서비스 어댑터 계열의 선행 연구. 생명정보학 적용과 당시 기술 선택을 현대 범용 런타임의 보장으로 일반화하지 않는다. |

## 2. 의미, 관계, 근거를 표현하는 표준

| 자료 / 검토 상태 | 자료가 제공하는 것 | USL에 적용할 부분과 경계 — AI 제안 |
|---|---|---|
| [RDF 1.1 Concepts](https://www.w3.org/TR/2014/REC-rdf11-concepts-20140225/) · W3C Recommendation | IRI 기반 노드·트리플·그래프·데이터셋의 공통 모델 | 외부 의미 교환 기반. Neo4j 저장소를 교체해야 한다는 뜻이 아니며, 단순 그래프 존재가 그 주장의 외부 세계적 참을 보장하지 않는다. |
| [JSON-LD 1.1](https://www.w3.org/TR/2020/REC-json-ld11-20200716/) · W3C Recommendation | JSON의 로컬 용어를 IRI와 연결하는 context 및 Linked Data 직렬화 | IR의 그래프 교환 형식 후보. JSON-LD context 자체가 실행·권한·승인 정책을 정의하지 않는다. |
| [SHACL](https://www.w3.org/TR/shacl/) · W3C Recommendation, 2017 | RDF 데이터 그래프를 shape 제약에 대해 검증 | 관계 참여자·필수 필드·타입·개수 검증에 참고. SHACL conformant와 실제 의미 관계가 참이라는 판정은 별개. Neo4j 적용에는 투영 또는 별도 구현이 필요하다. |
| [PROV-O](https://www.w3.org/TR/2013/REC-prov-o-20130430/) · W3C Recommendation | Entity·Activity·Agent 및 생성·사용·파생·책임 관계 | 어댑터 실행, 입력 snapshot, 산출 주장, 실행 주체의 provenance. 근거의 계보를 남기지만 그 근거가 충분한지는 별도 규칙이 판단한다. |
| [Web Annotation Data Model](https://www.w3.org/TR/2017/REC-annotation-model-20170223/) · W3C Recommendation | body·target, SpecificResource, selector와 state | 문서 전체와 특정 버전·부분을 분리해서 연결. 파일 줄 번호, 문서 인용 구간 등의 선택자 설계 참고. |
| [SKOS Reference §10](https://www.w3.org/TR/skos-reference/#mapping) · W3C Recommendation, 2009 | exactMatch·closeMatch·broadMatch·narrowMatch·relatedMatch 등 개념 매핑 관계 | 관계를 전부 `sameAs`로 압축하지 않는다. `closeMatch` 두 개를 이어도 동일 관계의 추이적 결론이 보장되지 않는다. SKOS 개념 매핑과 파일·저장소의 물리적 동일성도 구분한다. |
| [SSSOM 1.0 모델](https://mapping-commons.github.io/sssom/1.0/spec-model/) · 커뮤니티 명세 | Mapping·MappingSet, 연결 대상·predicate·mapping justification, 출처·버전 등 매핑 정보 | 관계와 그 근거를 함께 교환하는 직접적인 선례. 모든 USL n-ary 관계나 실행 프로그램이 SSSOM 이항 매핑으로 손실 없이 표현된다고 가정하지 않는다. |
| [RFC 8288: Web Linking](https://www.rfc-editor.org/rfc/rfc8288.html) · Standards Track, 2017 | context·relation type·target·속성으로 웹 링크 모델링 | URL과 링크 의미를 분리하는 최소 모델. 링크 관계 이름만으로 검증·실행·추론 방법이 정해지지는 않는다. |

**권고:** `meaning`에는 버전 있는 의미 ID, 역할별 타입, 설명, 적용 범위를 둔다. `claim`은 참여자와 주장 주체를 가진 별도 객체로 유지한다. 상충하는 주장 두 개를 보존할 수 있어야 하며, confidence 숫자를 자동 진실 판정으로 사용하지 않는다. 이 정책은 USL 제안이며 위 규격의 공통 강제사항은 아니다.

## 3. 파일·Git·패키지·코드 심볼의 식별

| 자료 / 검토 상태 | 자료가 제공하는 것 | USL에 적용할 부분과 경계 — AI 제안 |
|---|---|---|
| [RFC 8089: file URI](https://www.rfc-editor.org/rfc/rfc8089.html) · Standards Track, 2017 | 파일시스템 위치를 표현하는 file URI | host와 경로를 보존하고 정규 인코딩을 지원한다. 파일 위치는 영구 object ID나 접근 권한이 아니다. |
| [Git revisions](https://git-scm.com/docs/gitrevisions) · 공식 도구 문서 | revision 표현과 tree/blob의 `REV:path` 선택 | branch/HEAD와 해석된 commit을 분리한다. 같은 Git 객체와 같은 논리적 저장소는 다른 동일성 문제다. |
| [SWHID 1.1](https://www.swhid.org/swhid-specification/v1.1/0.Introduction/) · 소프트웨어 식별 명세 | content·directory·revision·release·snapshot 식별, 문맥과 부분을 위한 qualifier | 고정된 소프트웨어 산출물 참조에 사용 가능. ID가 있다고 archive에 실제 수록·접근 가능하다는 뜻은 아니다. |
| [Package URL / ECMA-427](https://ecma-international.org/publications-and-standards/standards/ecma-427/) · Ecma 표준 | 패키지 종류·이름공간·이름·버전·qualifier·subpath 표현 | 패키지 자원용 native identifier. 일반 Git 저장소, 프로세스, 모든 심볼 식별을 대체하지 않는다. |
| [SCIP](https://github.com/scip-code/scip/blob/main/docs/scip.md) · 프로젝트 프로토콜 | 코드 인덱스의 심볼, 정의·참조 occurrence, 문서 정보 | `::symbol`을 실제 언어별 인덱서에 연결할 후보. 심볼 이름 문자열만으로 변경 이력을 가로지르는 영구 동일성을 보장하지 않는다. |
| [LSP 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) · 버전 명세 | 문서 URI·위치·범위와 편집기/언어 서버 상호작용 | 현재 작업 문서의 심볼 탐색 및 편집기 연계. 줄·열 좌표는 편집으로 이동하므로 snapshot에 결합한다. |
| [CID](https://specs.ipfs.tech/cid/) · IPFS 명세 | codec·multihash 등을 포함하는 콘텐츠 식별자 | 내용 주소를 저장·검증하는 근거. 같은 의미인 다른 표현, 변하는 논리적 대상, 네트워크 가용성을 자동 식별하지 않는다. |
| [RO-Crate 1.1](https://www.researchobject.org/ro-crate/specification/1.1/introduction.html) · 커뮤니티 명세 | 연구 산출물과 관련 개체를 JSON-LD 메타데이터로 묶는 패키지 모델 | USL claim·evidence의 내보내기 묶음에 참고. 실시간 자원 resolver나 범용 실행 언어는 아니다. |

**권고하는 구분:** 언어 내부의 `resourceId`는 선언 참조를 식별한다. 외부 시스템이 제공하는 object ID는 출처와 함께 선택적으로 보존한다. `locator`는 접근 위치, `snapshot`은 관측한 revision·digest·시각, `selector`는 그 표현의 부분을 가리킨다. 같은 해시·URL·이름이라는 이유로 자원이나 의미를 자동 병합하지 않는다. 실제 동일성·별칭은 명시적 관계와 근거로 다룬다.

## 4. AI·인터넷·실행 시스템과 연결할 계약

| 자료 / 검토 상태 | 자료가 제공하는 것 | USL에 적용할 부분과 경계 — AI 제안 |
|---|---|---|
| [MCP Resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources) · 2025-11-25 명세 | URI로 지칭하는 자원의 발견·읽기·template·변경 통지 | AI가 읽는 자원을 USL driver로 노출. 자원 URI의 발견과 도메인 의미의 동일성은 다르다. |
| [MCP Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) · 같은 판본 | 도구 호출, 입력·출력 JSON Schema, annotation | 호출 가능한 기능의 native 계약. 도구 설명과 annotation을 검증된 의미·권한으로 자동 승격하지 않는다. |
| [MCP Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) · 같은 판본 | OAuth 기반 HTTP 인가 및 자원 서버 발견 계약 | 실제 인증·인가를 protocol driver가 준수한다. USL의 `requires` 선언만으로 권한이 생기지는 않는다. |
| [A2A Specification](https://github.com/a2aproject/A2A/blob/main/docs/specification.md) · 가변 프로젝트 명세 | AgentCard, skills/capabilities, task·message·artifact 상호작용 | agent·task·artifact를 자원 종류로 연결. 기술된 skill과 공유 온톨로지의 의미 일치는 별도로 매핑한다. |
| [OpenAPI](https://spec.openapis.org/oas/latest.html) · 공식 가변 명세 | HTTP 경로·operation·입출력·보안·링크 기술 | spec 버전/주소와 operation 식별자를 가진 HTTP adapter를 생성할 후보. 도메인 의미 어휘는 따로 결합한다. |
| [AsyncAPI 3.0.0](https://www.asyncapi.com/docs/reference/specification/v3.0.0) · 고정 판본 | 서버·채널·메시지·operation 및 protocol binding | 사건 기반 자원과 subscription 계약. 확장 필드를 넣는 것만으로 다른 도구가 USL 의미를 이해하지는 않는다. |
| [CloudEvents Primer](https://github.com/cloudevents/spec/blob/main/cloudevents/primer.md) · 공식 프로젝트 문서 | 여러 시스템이 공유할 사건 envelope와 context 속성 | 관측·변경 통지의 교환 형식. 사건 종류 이름만으로 도메인 의미와 후속 실행을 결정하지 않는다. |
| [WIT](https://github.com/WebAssembly/component-model/blob/main/design/mvp/WIT.md) · Component Model 설계 문서 | interface·world·import/export·typed resource 등 컴포넌트 계약 | adapter ABI와 명시적 요구 기능의 선례. WIT resource handle과 USL의 지속적 자원 ID는 구분한다. |
| [Apache Camel Endpoints](https://camel.apache.org/manual/endpoint.html) · 프로젝트 문서 | component가 제공하는 endpoint URI와 route 연결 모델 | 다수 접근 드라이버를 공통 실행 표면에 연결한 실용적 선례. route 합성이 의미 관계의 논리적 합성을 대신하지 않는다. |

## 5. 언어와 TypeScript + Effect 구현에 참고할 것

| 자료 | 자료가 제공하는 것 | USL에 적용할 부분과 경계 — AI 제안 |
|---|---|---|
| [Langium Features](https://langium.org/docs/features/) · TypeScript 언어 도구 | 문법·AST·참조 연결·검증·LSP 등 DSL 구현 기반 | import·타입·cross-reference가 커질 때 파서/편집기 후보. 문법 도구가 USL의 의미론을 대신 정의하지 않는다. |
| [Effect v3 Services](https://effect.website/docs/v3/requirements-management/services) · 공식 문서 | 서비스 요구사항과 의존성 제공을 Effect 환경으로 표현 | 순수 parse/compile과 Git·HTTP·FS·KG I/O 분리. 타입 환경 자체를 OS sandbox나 실제 권한 검사로 부르지 않는다. |
| [CUE Configuration](https://cuelang.org/docs/concept/configuration-use-case/) · 프로젝트 문서 | 값과 제약의 통합, 여러 제약의 선언적 결합 | 타입·shape·정책 제약을 합칠 때 충돌을 드러내는 방식 참고. CUE를 USL 런타임으로 채택하자는 제안은 아니다. |
| [Dhall Safety Guarantees](https://docs.dhall-lang.org/discussions/Safety-guarantees.html) · 프로젝트 문서 | 제한된 효과, total configuration, import의 정규형 기반 integrity hash | 재현 가능한 모듈 해석과 선언 코어 설계 참고. 여기의 semantic hash는 표현식 정규형에 관한 것으로 KG 개념의 동의성 검사가 아니다. |
| [Unison: The Big Idea](https://www.unison-lang.org/docs/the-big-idea/) · 프로젝트 문서 | 이름과 분리된 내용 기반 코드 식별 및 분산 코드 전달 | adapter 구현의 이름·버전·내용 식별 분리 참고. 외부 자원의 일반적 동일성이나 모든 프로그램의 행동 동치까지 판정하지 않는다. |
| [Categorical Query Language](https://categoricaldata.net/CQL/) · 프로젝트/연구 구현 | functorial data migration과 관련 구성의 참조 구현 | 명시적 mapping과 합성 법칙의 이론적 참고. 모든 연결을 범주론 엔진으로 구현할 필요는 없으며 보장은 모델링한 이론과 조건 안에서 해석한다. |

## 6. 연구를 반영한 최소 의미 모델 — AI 제안

아래는 개념 계약이다. 새로운 문법 명세나 현재 실행 가능한 코드가 아니다.

| 개념 | 필요한 내용 | 답하는 질문 |
|---|---|---|
| Resource reference | 내부 ID, 버전 있는 자원 타입, 선택적 외부 식별 근거 | 무엇을 지칭하는가? |
| Locator | native 주소, authority/host, 접근 driver | 어디서 어떻게 접근하는가? |
| Snapshot | 관측된 revision/digest, 표현 형식, 관측 시각·범위 | 어느 상태를 봤는가? |
| Selector | 기준 snapshot/representation, 선택자 종류·값 | 그중 어느 부분인가? |
| Meaning | 이름공간 있는 ID, 버전, 역할별 타입·제약, 설명 | 어떤 관계를 뜻하는가? |
| Claim | meaning 참조, 역할별 참여자, 주장 주체·출처·적용 범위 | 누가 어떤 연결을 주장하는가? |
| Adapter contract | 입력/출력 계약, 구현 참조·버전, 요구 기능, 실패·관측 계약 | native 자원/기능을 공통 모델에 어떻게 연결하는가? |
| Observation | 입력 snapshot, driver·검사 규칙 버전, 결과·근거·시각 | 실행해서 실제로 무엇을 확인했는가? |
| Composition rule | 전제 관계·타입, 허용 결론, 근거 전달·효과 결합 규칙 | 여러 연결을 어떤 조건에서 이어 쓸 수 있는가? |

USL 내부 ID는 어떤 선언을 참조할지 정한다. 현실 대상의 전역 동일성은 외부 ID와 별칭 근거를 통해 별도로 다룬다. selector는 자원 타입마다 다른 문법을 가질 수 있다. 코드 줄 범위, AST 심볼, JSON Pointer, 문서 인용 구간을 같은 문자열 규칙으로 강제하지 않는다.

adapter의 작업은 세 프로파일로 구분할 수 있다. **접근**은 native 자원을 읽고 공통 참조와 snapshot을 제공한다. **매핑·검사**는 자원 간 의미 주장을 생성하거나 명시된 규칙으로 평가한다. **동작**은 외부 기능을 실행하고 결과 자원·사건을 돌려준다. 모든 어댑터가 세 기능을 가져야 하는 것은 아니다. `read`, `verify`, `invoke`의 차이가 계약과 실행 계획에 드러나야 한다.

`meaning`의 역할은 입력·출력 방향과도 구분한다. `implements(source, concept)` 같은 이항 관계뿐 아니라 `deployment(artifact, environment, service)` 같은 다항 관계를 허용한다. 관계 참여자들을 연결했다는 것만으로 실행 순서나 데이터 흐름이 생기지는 않는다.

## 7. 한 사례로 확인하는 의미 경계 — AI 제안

```text
로컬 디렉터리 ── checkout_of ──▶ Git 저장소
Git 저장소    ── implements  ──▶ KG 개념
URL 문서      ── documents   ──▶ KG 개념
MCP 도구      ── operates_on ──▶ 로컬 디렉터리
```

네 자원을 같은 객체로 합치는 예제가 아니다. 서로 다른 관계로 연결해서 “이 개념의 구현 저장소, 현재 checkout, 설명 문서, 사용할 도구”를 함께 찾는 예제다. 이 관계 이름과 구체 해석은 설명용 제안이다.

| 관측 가능한 것 | 그 관측으로 곧바로 결론낼 수 없는 것 |
|---|---|
| 디렉터리의 Git 메타데이터에 특정 remote와 commit이 기록됨 | 해당 checkout이 신뢰한 원본과 완전히 같거나 작업 트리가 깨끗함. `checkout_of` 검사 범위를 따로 정의해야 한다. |
| KG UID를 조회했고 Git 저장소에 접근함 | 저장소가 해당 KG 개념을 정확히 구현함. `implements`에는 도메인별 검사·증거 또는 명시적 사람의 주장이 필요하다. |
| URL이 응답하고 문서 내용을 읽음 | 문서가 개념을 정확하게 설명함. 도달 가능성과 `documents`의 의미 판정은 별개다. |
| MCP 도구가 입력 schema를 받음 | 그 도구가 이 디렉터리에서 실행될 권한을 갖거나 원하는 동작을 올바르게 수행함. |

따라서 상태를 하나의 `verified` boolean으로 만들지 않는다. 다음 축을 독립적으로 보존하는 안이 적절하다.

- **접근 결과:** resolved / unavailable / unsupported / ambiguous. 외부 자원 미관측을 바로 부재나 거짓으로 취급하지 않는다.
- **주장의 생성 방식:** 사용자 선언 / 어댑터 관측에서 생성 / 규칙으로 유도 / AI 제안.
- **평가:** unjudged / supported / refuted. supported에는 적용한 검사와 범위를 붙인다.
- **시점:** 관측 당시 snapshot과 현재 유효성·stale 여부.
- **권위:** 누가 주장했고 어떤 정책에서 승인되었는가. 평가 성공과 정전 승인은 별도다.

경로 탐색은 위 연결을 따라 관련 자원을 찾을 수 있다. 하지만 `checkout_of(A,B)`와 `implements(B,C)`만으로 `implements(A,C)`를 자동 생성하려면 별도의 합성 규칙과 범위 조건이 필요하다. LLM은 그런 매핑의 후보를 제안할 수 있지만 provenance와 평가 상태를 생략할 수 없다.

## 8. 기존 제안에서 보완할 것과 구현 순서 — AI 제안

[현재 언어](LANGUAGE.md)의 `resource / meaning / link`는 작은 선언 코어로 유지할 수 있다. [앞선 설계안](SEMANTIC_ADAPTER_DESIGN.md)의 `use / adapter / bind`를 확정하기 전에 아래 의미론을 먼저 문서화하는 순서를 권고한다.

1. **자원 메타모델과 registry:** `kg | git_repo | url | filesystem`의 닫힌 목록에서 버전 있는 자원 kind/descriptor 계약으로 확장한다. native 위치와 snapshot/selector를 분리한다. 기존 사용자 입력은 명시적인 호환 해석기로 읽는다.
2. **의미·주장 모델:** 의미 ID와 버전, 역할 타입·개수, 이름 해석, 상충 주장, 출처·평가·시점 축을 정의한다. `sameAs`, 개념 대응, 구현 관계를 섞지 않는다.
3. **순수 IR과 adapter 계약:** `.usl`과 구조화 JSON 입력이 같은 AST/IR 검증을 통과하게 한다. 컴파일 단계에서 접속·호출하지 않고 실행 계획을 만든다. Effect 서비스로 driver와 의존성을 제공하고 실제 host에서 허용 기능을 집행한다.
4. **최소 실제 연결:** Git checkout ↔ 파일 경로, KG 참조 ↔ 저장소, URL 문서 ↔ KG의 사례를 각각 구현한다. `checkout_of`의 검사 범위를 먼저 정하고 `implements`는 선언과 검증을 구분한다. 일치·불일치·권한 없음·변경·미지원 선택자의 결과가 의미적으로 구분되어야 한다.
5. **교환과 추가 driver:** JSON-LD/PROV 투영, 필요한 이항 개념 매핑의 SSSOM 교환, MCP/OpenAPI driver를 순차 적용한다. 기본 런타임은 TypeScript + Effect를 유지한다.
6. **언어 도구와 합성:** 모듈·cross-reference가 커지면 Langium을 검토한다. 합성은 명시적 typed rule부터 시작하고, 필요한 범위에서만 CUE/Dhall/CQL의 제약·모듈·합성 아이디어를 가져온다.

“개념적으로 완성했다”는 판단에는 적어도 이름/타입 해석, 동일성, snapshot/selector, 주장/근거, adapter 효과, 합성, 버전 호환, 오류 결과의 의미가 정의되어야 한다. 모든 드라이버가 구현될 필요는 없지만, 새 드라이버가 이 계약에 어떻게 참여하는지는 설명 가능해야 한다.

이번 조사는 실행 성능·상호운용 적합성 시험이나 전체 생태계의 완전 조사까지 수행한 것은 아니다. 프로젝트 문서에 있는 기능과 USL 적용 가능성을 검토했다. 새 문법·런타임 변경·KG 정전 승인은 수행하지 않았다.
