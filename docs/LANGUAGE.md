# USL 언어 핵심 설계 v0.1

현재 통합 기준은 [ARCHITECTURE.md](ARCHITECTURE.md)다. 이 문서는 선택 입력인 `.usl`의 문법과 사용자 발화 이력을 설명한다. 범용 응답과 Lean은 각각 [RESOURCE_GRAPH.md](RESOURCE_GRAPH.md), [LEAN4_INTEGRATION.md](LEAN4_INTEGRATION.md)를 따른다.

2026-09-07 · 작성: Codex · 구현: TypeScript + Effect · 공학 설계(T0).

후속 사용자 방향 “인터넷 공간속의 시멘틱 어댑터”와 다음 문법 제안은 [SEMANTIC_ADAPTER_DESIGN.md](SEMANTIC_ADAPTER_DESIGN.md)에 있다. 아래 v0.1은 현재 구현된 언어이고, 후속안의 `adapter/bind`는 아직 미구현이다.

2026-09-08: 문법 변경 없이 `agentContext`와 `usl context`를 추가했다. 모든 참여 역할에서 연결을 찾고, 원래 의미·다자 관계·경로·탐색 한계를 반환한다. [양방향 연결·에이전트 설계와 사용법](BIDIRECTIONAL_AGENT_DESIGN.md)을 참고한다. 의미 inverse와 자동 실행기는 후속 설계다.

## 사용자 정의와 설계의 출처

사용자 원문 U5:

> USL 일단 개념적으로 완성시켜야하는데 뭐인건지는 알고 개발햇냐 ㅇㅇ? 일단 파이썬 말고 ts effect 기반 함수형으로 개발해줘 ㅇㅇ; USL 이 뭔지는 아냐? 하나의 언어같은거야 ㅇㅇ; 그 kg 랑 그런거 연결하는건데 kg 에 시멘틱한 내용 첨가해서 각각 다른 데이터 포멧이나 경로들을 연결하는 ㅇㅇ

직후 정정 U6:

> 아니 kg 랑 그 gitrepo 나 url 이나 파일시스템= 경로나 이런 각각 다른것들을 연결하는 그런거라고 ㅇㅇ

U6에 따라 “서로 다른 것”은 KG·Git 저장소·URL·파일시스템 경로라는 자원 종류를 가리킨다. 앞선 AI의 JSON↔CSV 변환 중심 해석은 이번 설계의 근거에서 제외한다. 언어라는 성격과 TypeScript + Effect 함수형 구현은 사용자 지시다. 아래 구체적인 문법·타입·투영 방식은 그 지시에 따른 **SECONDARY_AI 설계**이며 사용자 원문이나 KG의 확정 정전으로 승격하지 않는다. 기존 정전: `sym:Concept:usl` 및 그 사용자 발화 이력.

## 정의

**`.usl`은 자원을 공통으로 지칭하고 그 사이의 역할·연결·의미를 기술하는 USL의 선택 선언 문법이다.** KG 표현은 선택 출력이다. 기존 시스템 응답과 Lean 선언은 `.usl` 파일 없이도 같은 연결 구조로 해석할 수 있다.

하나의 USL 문장은 “어떤 자원들이, 어떤 역할로 참여하여, 어떤 의미의 관계를 이루는가”를 기술한다. 예를 들어:

- 이 소스 경로는 이 KG 개념을 구현한다.
- 이 URL은 이 KG 개념의 근거 자료다.
- 이 디렉터리는 이 Git 저장소의 로컬 checkout이다.
- 이 KG 노드는 다른 KG의 노드와 특정 의미 관계를 가진다.

KG는 연결의 한쪽 끝이 될 수도 있고, 자원과 의미와 연결을 표현하는 그래프가 될 수도 있다. 두 역할을 구분한다. URL·저장소·경로 사이의 연결에도 의미를 부여하고 이를 KG에 투영할 수 있다.

## 세 가지 언어 구성요소

| 구성요소 | 의미 | KG 표현 |
|---|---|---|
| `resource` | 언어 안에서 자원을 가리키는 이름과 타입 있는 locator | locator·종류를 가진 자원 참조 레코드; KG 자원은 실제 UID와 연결 |
| `meaning` | 관계가 뜻하는 내용과 각 참여 역할의 자원 타입 | 의미 정의 레코드와 역할 계약; 선택적으로 기존 KG 의미 노드와 연결 |
| `link` | 선언한 의미에 자원들을 역할별로 배치한 문장 | 의미 정의 및 각 자원 참조에 연결된 관계 레코드 |

자원 종류는 `kg`, `git_repo`, `url`, `filesystem`이다. `any`는 의미 정의에서 이 네 종류를 받을 수 있는 역할 타입이다. 언어를 이 네 종류로 영구히 닫는다는 정전 판단은 하지 않는다.

이름은 현재 문서 namespace 안의 참조 이름이다. 같은 주소·해시·이름으로 현실의 대상이 동일하다고 추론하지 않는다. `implements`, `evidence_for`, `checkout_of`의 문구와 역할 계약은 작성자가 명시한다. 문자열 이름이 비슷하다는 이유로 동일 의미를 추론하지 않는다.

같은 locator에 서로 다른 자원 이름을 붙이는 것은 허용한다. 이는 역할별 별칭일 수 있으며 서로 다른 현실 개체라는 주장도 아니다. CLI 투영은 작성 원문의 경로와 SHA-256을 함께 기록한다.

## 예제

```usl
usl "0.1";
namespace "usl.example";

resource concept = "kg://canonical-neo4j/sym:Concept:usl";
resource repo = "git://github.com/gj3447/symposium";
resource source = "file://dev-01/home/lagyeongjun/CD/USL/src/index.ts";
resource checkout = "file://dev-01/home/lagyeongjun/CD/SYMPOSIUM";
resource reference = "https://www.w3.org/TR/rdf11-concepts/";

meaning implements(from: filesystem, to: kg) = "소스가 대상 개념을 구현한다";
meaning checkout_of(local: filesystem, repository: git_repo) = "경로가 저장소의 로컬 checkout이다";
meaning informs(from: url, to: kg) = "외부 자료가 대상 개념의 설계에 참고된다";
meaning implements_with_tests(source: git_repo, concept: kg, specification: url) = "저장소가 명세의 개념을 구현한다"
  applies "해당 저장소의 고정 revision과 명시된 명세 버전에 한한다"
  check source_inspection(source, specification) = "고정 revision의 구현과 명세 요구사항을 대조한다"
  check concept_anchor(concept, specification) = "KG 개념 anchor가 명세의 대상 정의와 일치하는지 확인한다";

link implementation = implements(from: source, to: concept);
link local_repository = checkout_of(local: checkout, repository: repo);
link reference_material = informs(from: reference, to: concept);
```

문법을 보여주는 AI 작성 예제다. 선언된 의미 관계의 참을 검증하거나 사용자 정전으로 확정한 것은 아니다.

기존 KG 의미 노드를 명시하려면 의미 정의 뒤에 `grounded "kg://<source>/<uid>"`를 덧붙인다. 이 ground는 의미의 참조를 표현하며, KG가 선언된 역할 계약을 비준했다는 뜻은 아니다.

## 문법과 정적 의미

```ebnf
program  = 'usl' string ';' 'namespace' string ';' declaration* ;
declaration = resource | meaning | link ;
resource = 'resource' identifier '=' string ';' ;
meaning  = 'meaning' identifier '(' roles ')' '=' string meaning_clause* ';' ;
meaning_clause = 'grounded' string
              | 'applies' string
              | 'check' identifier '(' evidence_roles ')' '=' string ;
evidence_roles = identifier (',' identifier)* ;
roles    = role (',' role)+ ;
role     = identifier ':' ('kg' | 'git_repo' | 'url' | 'filesystem' | 'any') ;
link     = 'link' identifier '=' identifier '(' participants ')' ';' ;
participants = participant (',' participant)+ ;
participant = identifier ':' identifier ;
```

문자열은 JSON 문자열 문법, 이름은 ASCII 문자 또는 `_`로 시작해 문자·숫자·`_`를 잇는다. 문장 사이 공백·개행과 `//` 한 줄 주석을 허용한다. 선언 순서는 참조 해석 결과에 영향을 주지 않는다.

컴파일러는 다음을 검사한다.

1. 지원 언어 버전, 비어 있지 않은 namespace·의미 설명, 유일한 선언 이름.
2. 자원의 locator가 해석 가능한 문법이며 자원 종류를 결정할 수 있음.
3. 의미에는 최소 하나의 역할이 있고, 역할 이름은 서로 다르며 역할 타입이 유효함. 2026-09-14부터 단항 자원 설명도 지원한다. 기존 다자 연결의 해석은 유지한다.
4. 링크의 의미와 자원 이름이 실제 선언되어 있음.
5. 링크가 의미에 정의된 역할을 빠짐없이 정확히 한 번씩 제공하고, 자원 종류가 역할 타입과 맞음.
6. `grounded`는 KG locator임.
7. `applies`가 있으면 하나 이상의 `check`가 필요하다. `check`가 있으면 `applies`가 필요하다. `grounded`, `applies`, `check` 절은 의미 설명 뒤 어느 순서로든 쓸 수 있다.
8. 적용 범위와 검사 설명은 비어 있으면 안 된다. 검사 이름은 의미 안에서 유일하고, 각 검사는 하나 이상의 서로 다른 evidence 역할을 가져야 하며 그 역할은 해당 의미에 선언돼 있어야 한다.

현재 커널은 역할 있는 다자 관계를 담을 수 있다. 보통의 2항 연결은 두 역할을 가진 경우다. 이것은 사용자 열거의 8쌍을 자연스럽게 표현하는 구현 선택이며 “USL의 정전 arity가 N이다”라는 결론은 아니다.

## 프로그램, 관측, KG의 구분

`parseProgram` → AST → `compileProgram` → `SemanticPlan`은 순수 함수다. 같은 원문은 같은 계획을 만든다. 역할·타입 오류는 네트워크나 파일 접근 전에 보고한다.

`observeProgram`은 `Effect`와 기존 `Resolvers` 서비스로 참조 자원 및 선택적 KG 의미 anchor의 도달성을 확인한다. 결과는 프로그램 선언과 분리된 관측이다. 모든 자원이 조회되어도 `implements` 같은 의미 관계가 사실이라는 증명이 되지는 않는다. 잘못된 의미 관계는 모든 엔드포인트가 살아 있는 상태에서도 존재할 수 있다.

`applies`와 `check`는 의미 설명을 개발에 사용할 수 있게 하는 선언 계약이다. `applies`는 그 의미가 성립한다고 주장하는 범위를, 각 `check`는 어떤 역할의 근거를 읽어 어떤 절차로 점검할지를 적는다. 현재 커널은 이 검사를 실행하거나 의미 관계의 참을 판정하지 않는다. 관측 v2는 원본 plan과 의미 정의의 digest를 함께 기록하며 `compareObservations`가 주소·내용 변경과 의미 계약 변경을 구별한다. 선택 링크 조회·허용 목록·baseline CLI의 상세 계약은 [의미 버전 관측 문서](OBSERVATION_CONTRACTS.md)에 있다.

`toSemanticBundle`은 계획을 KG 번들로 투영한다. 자원 참조, 의미 정의, 링크 레코드를 각각 보존한다. 의미 계약이 있으면 적용 범위와 전체 검사 구조를 JSON 속성으로 보존한다. 역할 이름은 관계의 속성으로 두어 새 Neo4j 관계유형을 자동 발명하지 않는다. 작성한 의미와 링크는 `SECONDARY_AI / PENDING_OR_PRELIMINARY / review_required` 설계 선언으로 투영하며 자동 ratification하지 않는다. 기존 KG 노드를 수정하거나 직접 Cypher를 실행하지 않는다.

기존 `pierce/audit/rebind`는 엔드포인트 관측과 기준 감사용 API로 유지한다. 기존 flat `UslRecord`는 실행 아티팩트이며 언어 전체를 정의하지 않는다.

## 주소와 자원 범위

- KG: `kg://source/uid`. source는 실제 조회 서비스를 구분한다.
- Git 저장소: `git://host/org/repo`. 관측 시 현재 HEAD를 기록한다.
- Git의 고정 버전: `git://host/org/repo@commit`.
- Git의 파일: `git://host/org/repo@commit:path` 및 기존 라인/심볼 문법.
- URL: `http(s)://...`.
- 파일시스템: `file://host/absolute-path`. 파일과 디렉터리 모두 자원이다.

저장소 HEAD와 디렉터리 목록의 관측은 그 자원의 특정 시점 표현이다. 디렉터리는 바로 아래 항목의 이름·종류만 관측하며 하위 파일 내용 전체를 재귀적으로 해시하지 않는다. 원격 파일 접근, Git 심볼 해석 등은 각 resolver의 현재 지원 범위에 따른다.

## 설계상 보존할 구분과 확장점

주소의 연결, 의미 관계의 선언, 현실에서 그 관계의 참, 승인된 KG 정전은 서로 다른 판단이다. 자원끼리 연결됐다고 파일을 이동하거나 동기화하거나 데이터 포맷을 변환하지 않는다. 구현 언어는 TypeScript이고 USL은 그 위에서 해석되는 선언 언어다. IO·오류·취소·의존성 주입은 Effect가 담당한다.

역할 기반 양방향 질의와 원 link를 보존한 경로 탐색은 `agentContext`로 지원한다. 자동 추론, 의미 관계 합성, 관계별 사실 검증기, 편집기 지원, 새 자원 adapter, HSWM의 구체적 편입 방식은 확장점이다. 현재 정의를 완성하기 위해 이들에 대한 정전을 발명하지 않는다. 특히 HSWM과 롱기누스의 기존 열린 질문은 사용자 결정과 별도로 유지한다.
