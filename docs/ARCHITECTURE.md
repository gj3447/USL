# USL 현재 구조

USL은 의미 연결 문법과 실행 라이브러리다. 저장소·질의 엔진·접근 정책은 연결되는 시스템이 소유한다. 그래프는 연결을 표현하는 자료구조이며, 이 구조를 다루기 위해 별도 그래프 DB를 설치하거나 데이터를 복제할 필요가 없다.

## 공통 모델

| 요소 | 식별과 의미 | 구현 |
|---|---|---|
| Resource | 소유자 고유 ID, 하나 이상의 도메인 타입 IRI, locator, 메타데이터 | `resource-graph/v1.resources` |
| Meaning | 의미 ID와 명시적인 설명 | `meanings` |
| Link | 의미를 참조하는 이름 있는 관계 인스턴스 | `links` |
| Participant | 역할 이름과 자원 ID | 관계별 중복 역할 금지, 다자 연결 |
| Provenance | 출처 자원, 활동·주체의 명시적 참조 | 선택 필드, 누락 시 추정하지 않음 |
| Observation | 선택한 주소의 해석·근거 가용성 | 기존 관측 v2 |
| Formal evidence | Lean 선언·명제·공리·실행 보고 | `lean4/v1` |

모든 참조는 주어진 응답 범위 안에서 검사한다. 중복 ID, 정의되지 않은 의미, 빠진 자원, 중복 역할은 오류다. 참여 역할 순서만 바뀌는 것은 동일한 연결이며, 역할과 자원의 바인딩이 바뀌면 다른 연결이다. 다자 연결을 이항 관계들로 분해해 원래 의미를 잃지 않는다.

도메인 타입과 metadata는 자원별 설명 링크와 연결의 의미 계약에 보존한다. 자원 설명 링크는 단항이므로 서로 무관한 자원을 연결하지 않는다. 탐색이 대상에서 멈추더라도 사용된 링크에는 각 참여 자원의 도메인 정보가 남는다. 설명 링크도 관측 링크 예산에 포함된다.

## 계층과 효과

1. **입력:** `.usl` 텍스트, TypeScript 값, 기존 property graph 응답, 범용 자원 응답, Lean export.
2. **순수 해석:** 검증 → 역할과 ID 매핑 → 메모리 `SemanticPlan`. 외부 IO 없음.
3. **소비:** 제한된 탐색·문맥, 선택 관측·비교, 교환 표현 생성.
4. **호스트 IO:** 기존 DB/API 조회, KG·Git·URL·파일 resolver, 명시적으로 설정한 Lean 실행.
5. **별도 소비자:** HSWM 정책 판정·실행, GEIP 구조 검증, RDF/SHACL 검사.

`context`는 연결 구조를 탐색한다. `observe`는 허용된 locator만 읽는다. Lean export를 생성하는 호스트 callback은 Lean 컴파일을 실행하므로 단순 파일 관측과 구분한다. MCP 파일 설정에서는 이미 생성된 응답 파일만 읽으며, 클라이언트가 명령·소스 경로·DB 질의를 지정할 수 없다.

주소·내용·의미 계약의 변경을 별도로 비교한다. 해시 일치는 그 표현의 동일성 판단이며 의미 동치나 접근 권한의 증거가 아니다. HSWM의 정책·pins·`allowed_reads`는 원래 소유자가 공급한다. 새 USL 구현으로 옛 source pin이 달라졌을 때 과거 영수증을 고치지 않는다.

## 표준 적용

| 기준 | 실제 적용 | 한계 |
|---|---|---|
| [RDF 1.1](https://www.w3.org/TR/rdf11-concepts/) | 연결 선언을 RDF 자원·술어·값으로 표현 | 저장 엔진과 추론기는 포함하지 않음 |
| [JSON-LD 1.1](https://www.w3.org/TR/json-ld11/) | `@id`, `@type`, 역할 참여자, JSON metadata의 교환 출력 | 임의 JSON-LD 입력의 역변환은 아직 미지원 |
| [PROV-O](https://www.w3.org/TR/prov-o/) | 원본 응답의 `prov:Entity`, `wasDerivedFrom`, 명시된 활동·주체 | 실제 발생 여부나 권한을 인증하지 않음 |
| [SHACL](https://www.w3.org/TR/shacl/) | 자원·의미·참여 역할 구조 및 중복 역할 검사 | 도메인 관계의 참이나 Lean 증명 검증을 대신하지 않음 |
| Property graph | 기존 노드·관계 ID, 방향·타입, 역할 보존 | `property-graph/v2`는 프로젝트 adapter 규약 |
| GEIP v0alpha1 | 기존 GraphSpec digest·구조·근거 보존 | 프로젝트의 로컬 draft, 국제 표준이 아님 |
| Lean 4 | 선택 선언의 보고, 형식 모델 증명, TS 대조 검사 | 전체 TS 구현의 refinement proof는 아님 |

`urn:usl:vocab:`와 JSON 입력 스키마는 USL의 로컬 어휘·교환 계약이다. RDF로 내보낸 `usl:Link`는 `DECLARED` 관계 레코드다. 예를 들어 `implements`라는 이름만으로 `<코드> implements <사양>`의 참을 단정하는 트리플을 자동 생성하지 않는다.

## 확장 범위

기능 설명과 정책은 [호스트 소유 catalog](CAPABILITY_CATALOG.md)에서 결속한다. `capability_discover`와 `capability_preflight`는 SDK·CLI·MCP가 같은 application 경로를 사용하며, executor를 받지 않는다. 공통 JSON 데이터 검증은 `json-data.ts`에 두어 계약 계층이 application에 역으로 의존하지 않게 했다.

2026-09-22부터 선택적 [공학 계약](ENGINEERING_CONTRACTS.md)을 추가했다. resource graph에 owner가 선택한 DomainProfile을 적용하면 역할의 domain type·필수 metadata를 실제 검사하고 profile digest를 의미 계약에 보존한다. 기본 v1 출력은 유지한다. capability 계층은 제한된 MCP/OpenAPI inventory 수입, 예산 있는 기능 발견, 입력/출력 schema·단위·scope·effect·snapshot 검사와 host Effect callback의 결과 영수증을 제공한다. 기존 CLI/MCP resource graph 입력에도 profile을 등록할 수 있다. 원격 protocol driver와 전체 domain 의미 검증은 이 계약과 구분한다.

`types`에 새 도메인 IRI를 쓰는 데 코어 수정은 필요 없다. [14종 fixture](../examples/fixtures/resource-graph.json)는 요구사항·코드 심볼·checkout·Lean 정리·빌드 실행·산출물·데이터셋·모델·도구·워크플로·문서 일부·에이전트·프로세스·측정값을 연결한다. 이것은 표현·탐색·교환 경로의 검증용 예제다.

실제 접근은 등록한 host callback과 resolver가 맡는다. 현재 기본 locator는 KG, Git, HTTP(S), 로컬 파일이다. 임의 `sql://`, `mcp://`, `lean://` 프로토콜이나 범용 명령 실행기를 도입하지 않는다. SQL 행이나 MCP 도구 등은 소유자가 제공하는 API 응답/파일 표현과 native ID로 바인딩한다. Lean 심볼은 Lean 환경에서 직접 가져오며, 현재 일반 Git `::symbol` resolver는 여전히 미지원이다.
