# USL — Universal Semantic Link (유니버셜 시멘틱 링크) · runtime v0.3 / language v0.1

> **정전은 KG다:** `sym:Concept:usl` (USER_PRIMARY, 2026-09-07). 사용자 원문: "이건 롱기누스의 최소단위야" · "kg 와 kg 간의, url 과 kg 간의, git repo 와 kg 간의, 파일시스템과 kg 간의 … 싹다 연결할수 있는 마법의 접착제라고 보면됨 시멘틱한 의미를 담아서 연결을 담아서 HSWM 확장개념으로 모든게 HSWM 으로 치환될수있게하는 유니버셜 시멘틱 링크임".
>
> 이 구현의 레코드 형태·locator 문법은 **SECONDARY_AI 설계**다. KG 열린 질문 OQ-A/B/C/D를 닫거나 HSWM schema admission을 주장하지 않는다. 원문과 설계 배경: `SYMPOSIUM/THEORY/LONGINUS/USL_UNIVERSAL_SEMANTIC_LINK_2026-09-07.md`.

**USL은 KG·Git·URL·파일의 연결 선언, 선택 관측, 변경 비교와 AI 문맥 생성을 제공하는 라이브러리·도구다.** `.usl`은 선택 가능한 선언 문법으로, `resource`·`meaning`·`link`를 작성하거나 TypeScript 값으로 같은 plan을 만들 수 있다. DB 저장·질의는 기존 KG가 맡는다. [Cypher 대비 역할과 검증되지 않은 이점](docs/USL_AND_CYPHER.md)을 구분해 설명한다.

[차근차근 사용하기](docs/GETTING_STARTED.md) · [CLI 명령](docs/CLI.md) · [MCP 서버·클라이언트 설정](docs/MCP.md) · [USL 스킬](skills/usl/SKILL.md) · [자동 갱신과 API 구조](docs/PLATFORM.md)

`context`·`observe` 전에 수동 컴파일할 필요는 없다. 장기 실행 API/MCP에서는 고정 ID로 등록한 파일의 변경을 자동 검증하고 해당 파일의 plan을 교체한다. 변하지 않은 파일은 캐시를 재사용한다. 현재 파일 단위 갱신이며 함수 실행 코드 교체나 DB 동기화는 제공하지 않는다.

[함수형 코드에서 USL 쓰기](docs/CODE_INTEGRATION.md): `const usl = semantic.link(...)`로 연결을 값으로 만들고 `semantic.bind(fn, usl)`의 `{ run, usl }`로 원래 함수·Effect와 함께 보관한다. 역할 타입 검사, 불변 선언, plan 조합, `.usl` 원문 생성과 로컬 패키지 import를 지원한다. `npm run example:code`로 실제 대시 함수와 선택 관측을 실행한다.

[그래프 엔지니어링 통합](docs/GRAPH_ENGINEERING_INTEGRATION.md)은 프로젝트의 GEIP v0alpha1 GraphSpec 원문·버전·digest·구조적 간선 의미를 보존하고 명시한 노드·근거를 USL 자원에 연결한다. [HSWM 통합](docs/HSWM_INTEGRATION.md)은 기존 HSWM Python 어댑터가 소비하는 관측 입력을 준비한다. GEIP는 로컬 draft profile이며, 이 연결로 실행 적합성이나 HSWM admission을 자동 부여하지 않는다.

2026-09-08: [의미 버전 관측·변경 비교](docs/OBSERVATION_CONTRACTS.md)를 추가했다. 관측 v2는 원본 plan·의미 정의·원문 digest를 보존하며, 의미 설명만 반전해도 변경을 검출한다. `applies`/`check`로 적용 조건과 검사 근거를 연결하고, 선택 링크의 참여자·grounding만 허용 범위 안에서 읽는다. 주소·내용·의미 계약의 변경을 각각 비교한다. [게임 대시 기능 예제](docs/GAME_WORKFLOW.md)에서 탐색·조회 비용과 오래된 근거 검출을 재현할 수 있다.

[AI 맥락 전달량 절감](docs/COMPACT_CONTEXT.md): `context --compact`는 경로의 중복 정보를 줄이고, 같은 `contextDigest`의 맥락을 보유한 소비자에게는 `UNCHANGED`만 보낸다. 바이트 예산을 적용하며, API에서는 모델별 tokenizer를 주입해 토큰 예산도 지정할 수 있다. 원래 의미·적용 조건·전체 참여 역할은 보존한다.

[언어 개념·문법·정적 의미](docs/LANGUAGE.md)와 [실행 가능한 USL 예제](examples/semantic-links.usl)를 먼저 읽는다. 언어·TypeScript + Effect 구현 요구와 상세 문법 설계의 provenance를 구분해 기록했다. 기존 v0.2 resolver·관측·감사 API는 언어 아래의 실행 계층으로 유지한다.

[시멘틱 어댑터 선행 기술 조사](docs/RESEARCH_SEMANTIC_ADAPTERS_2026-09-07.md)는 OSLC·WoT·LinkML, 자원 식별, AI/인터넷 프로토콜, 함수형 언어 설계의 공식 자료와 USL 적용 제안을 구분해 정리한다. 다음 문법을 확정하기 위한 조사이며 현재 지원 기능을 추가한 명세는 아니다.

[추가 연결 대상 조사](docs/RESEARCH_CONNECTION_GAPS_2026-09-08.md)는 실행 인스턴스·데이터/AI 계보·화면/문서의 부분·주체/권한·물리 측정·USL 연결 자체에서 빠뜨리기 쉬운 대상을 살펴보고, 공통 메타모델과 driver 확장의 경계를 제안한다.

[양방향 연결·에이전트 설계](docs/BIDIRECTIONAL_AGENT_DESIGN.md)를 보강하고, `agentContext` API와 `context` CLI를 구현했다. 어느 역할에서든 원래 의미·전체 참여자를 보존한 경로를 찾고, 에이전트에 탐색 범위와 한계가 명시된 JSON을 제공한다. 의미 inverse·자동 실행·동기화는 후속 설계다.

## TypeScript + Effect

순수 함수 `parseProgram → compileProgram → SemanticPlan`, `toSemanticBundle`과 Effect 프로그램 `observeProgram`을 분리했다. 관측에서는 `Resolvers` 서비스를 주입한다. 기존 `parseLocator`, `formatLocator`, `bxGetPut`, `bxPutGet`, `toBundle`도 유지한다. `Config`/`Layer`로 KG·HTTP·Git·파일 resolver를 주입한다. 엔드포인트는 읽기 전용이며 KG에는 고정 조회 `ontology_get`만 호출한다. 로컬 JSON 파일은 링크 스냅샷의 입출력 아티팩트다. DB의 공유 작업기억이나 KG 정전을 대신하지 않는다.

## USL 문장을 사용하기

```bash
npm run usl -- check --source examples/semantic-links.usl
npm run usl -- compile --source examples/semantic-links.usl --out plan.json
npm run usl -- context --source examples/agent-navigation.usl --focus concept --target checkout
npm run usl -- observe --source examples/semantic-links.usl
npm run usl -- observe --source game.usl --link dash_behavior --out baseline.json
npm run usl -- observe --source game.usl --link dash_behavior --baseline baseline.json --out current.json
npm run usl -- project --source examples/semantic-links.usl --out semantic-bundle.json \
  --bundle-uid bundle:usl:semantic-example:v1 --utterance-file user-request.txt
```

`check`와 `compile`은 자원에 접근하지 않는다. `observe`는 조회 가능 여부를 관측하며 관계의 참을 검증했다고 표시하지 않는다. 언어 투영은 의미·자원 참조·연결을 보존하는 검토 대상 KG 번들을 생성한다. `--anchors`는 언어 입력에서 `KG locator → 대상 그래프 UID` 매핑이고, 아래 레거시 records 입력에서는 `link_id → from/to anchor` 매핑이다.

`context`도 endpoint에 접근하지 않는다. 반대 방향은 `--focus checkout --target concept`으로 조회한다. `--via implements:concept:repository`처럼 역할 경로를 제한할 수 있고, `--max-hops`·`--max-resources`·`--max-links`·`--max-visits`로 예산을 정한다. 결과의 `FOUND`는 선언 그래프의 도달이며, `coverage.complete`와 `NOT_FOUND_WITHIN_LIMITS`로 불완전한 탐색을 구분한다. 원 관계의 참은 `NOT_EVALUATED`, 접근은 `NOT_OBSERVED`, 실행은 `NOT_PLANNED`로 남는다.

## 시작

Node.js 22 이상:

```bash
npm ci
npm test
npm run typecheck
npm run usl -- --help
```

```bash
# 실제 호스트명과 일치해야 한다. 기본값은 os.hostname().
export USL_HOSTNAME=dev-01
export USL_GIT_REPOS='{"github.com/gj3447/symposium":"/home/lagyeongjun/CD/SYMPOSIUM"}'

npm run usl -- pierce \
  --link-id usl-doc --relation DOCUMENTED_IN \
  --from kg://canonical-neo4j/sym:Concept:usl \
  --to file://dev-01/home/lagyeongjun/CD/SYMPOSIUM/THEORY/LONGINUS/USL_UNIVERSAL_SEMANTIC_LINK_2026-09-07.md \
  --records records.json

npm run usl -- audit --records records.json --check
npm run usl -- audit --records records.json --write

# 변경된 양 끝을 새 기준으로 명시적으로 수용한다. 양쪽 해석 성공 시에만 저장한다.
npm run usl -- rebind --records records.json --link-id usl-doc
npm run usl -- validate --records records.json

npm run usl -- project --records records.json --out bundle.json \
  --bundle-uid bundle:usl-links:2026-09-07:v2 \
  --utterance-file user-request.txt --date 2026-09-07
```

`pierce`는 같은 `link_id`가 이미 있으면 거부한다. 관계·주소를 바꾸어 교체하려면 `pierce --replace`를 명시한다. `project`는 사용자 원문 파일이 필요하고 번들 생성까지만 수행한다. KG 반영은 별도 승인된 `SYMPOSIUM/scripts/kg_publish_bundle.py` 경로를 사용한다.

## Locator와 조회 설정

```text
kg://<source>/<uid>
https://...
git://<host>/<org>/<repo>[@<commit>[:<path>[::<symbol>][@L<a>-L<b>]]]
file://<host><absolute-path>[#L<a>-L<b>]
```

Git 저장소 전체를 지칭할 수 있다. 커밋을 생략하면 현재 HEAD를 관측하고, 커밋 해시를 지정하면 전체 SHA로 해석한다. 경로는 저장소 상대 경로이며 `.`/`..` 구간을 허용하지 않는다. 파일시스템 디렉터리는 바로 아래 항목의 이름·종류를 관측한다. 파일·Git 라인 범위는 1부터 시작하는 양 끝 포함 범위로, 존재하는 줄을 넘어가면 ORPHAN이다. 마지막 개행 뒤의 빈 문자열은 별도 줄로 세지 않는다. 파일 URI 경로의 공백·`#` 인코딩은 아직 지원하지 않는다.

| 설정 | 기본값 / 의미 |
|---|---|
| `USL_HOSTNAME` | 현재 호스트명; 원격 파일시스템은 지원하지 않음 |
| `USL_GIT_REPOS` | `{}`; 저장소 ID → 로컬 checkout 경로 |
| `USL_KG_MCP_URL` | `http://127.0.0.1:5501/mcp`; `canonical-neo4j` 호환 기본값 |
| `USL_KG_SOURCES` | `{}`; KG source → `ontology_get` MCP URL; 항목은 해당 source의 기본값을 덮어씀 |
| `USL_TIMEOUT_MS` | `15000`; 엔드포인트 해석당 제한, fetch/Git 취소 포함 |
| `USL_MAX_RESPONSE_BYTES` | `8388608`; URL·MCP 응답 본문 최대 바이트 |

등록하지 않은 KG source는 네트워크 요청 없이 IO/AMBIGUOUS가 된다. 예를 들어 `USL_KG_SOURCES='{"second-kg":"http://second-host:5501/mcp"}'`로 두 번째 KG를 연결한다. 그 서버도 동일한 `ontology_get` 응답 계약을 제공해야 한다. `canonical-neo4j`는 맵에 없어도 기존 `USL_KG_MCP_URL` 기본값을 사용한다.

Git의 `::symbol`은 파싱하지만 아직 심볼 해석기가 없다. 지정하면 **AMBIGUOUS**로 보고한다. 심볼 없는 locator는 지정된 범위에 따라 저장소 커밋, 파일 또는 라인 구간을 확인한다. 현재 실환경 resolver의 보장은 `trust_host`이며 Git 명령 실행을 sandbox로 표기하지 않는다.

## 레거시 링크 관측: 감사와 기준 갱신

`pierce()`가 만든 `content_hash_*`, `resolved_locator_*`, `resolved_at_*`가 기준 스냅샷이다. `audit()`와 `audit --write`는 이 필드를 바꾸지 않는다. `audited_at`에 감사 시각을 기록하고, 보고서 `observations`에는 이번 관측값을 담는다. `drift_detected_at`은 첫 이상 감지 시각을 유지한다. 명시적 `rebind()`가 새 기준과 provenance를 만들고 이 감지 시각을 초기화한다.

| 관측 | status / drift_type |
|---|---|
| 양 끝이 기준 해시·주소와 일치 | `RESOLVES / NONE` |
| 본문 해시 변경 | `DRIFT / SigMismatch` |
| 본문은 같지만 해석 주소 변경 | `DRIFT / LabelRot` |
| 파일·범위·커밋 경로 또는 조회 가능한 KG 레코드 없음 | `ORPHAN_FROM` 또는 `ORPHAN_TO / Orphan` |
| 통신·권한·설정·시간초과·UID 충돌·미지원 심볼 | `AMBIGUOUS / Ambiguous` |
| 이제 조회되지만 최초 기준이 불완전함 | `AMBIGUOUS / Unbaselined` |

HTTP `404`/`410`만 URL 부재로 분류한다. `401`/`403`/`429`/`5xx`는 IO다. KG의 빈 결과는 **조회 표면에서 보이지 않음**을 뜻하며 물리적 삭제를 증명하지 않는다. 한쪽 오류가 상태 판정에서 우선하더라도 양 끝의 오류·변경 내역은 `issues`, `changed_ends`, `relocated_ends`에 남는다.

`confidence`는 감사 중 보수적으로 낮출 수 있으며 자동으로 높이지 않는다. `GetPut`은 기준과의 읽기 안정성, `PutGet`은 해석 주소의 문법 왕복을 검사한다. 이 진단은 정식 양방향 갱신 lens 법칙의 증명이 아니다. `drift_score`는 변경된 끝의 비율(0/0.5/1), 미해석 상태는 1로 표시하는 진단값이며 GED나 확률이 아니다.

## 저장과 KG 투영

- `audit`, `rebind`, `validate`, `project`는 없는 입력 파일을 오류로 처리한다. 잘못된 레코드·중복 ID·알 수 없는 필드는 저장 전에 거부한다.
- 파일 저장은 같은 디렉터리의 임시 파일에 쓰고 동기화한 뒤 rename한다. 협력적 writer용 `.lock`과 입력 내용 비교로 같은 스냅샷을 덮어쓰는 충돌을 거부한다. lock을 무시하는 외부 편집기와의 완전한 동시성 보장은 없다.
- 프로세스 강제 종료로 `.lock`이 남으면 자동 탈취하지 않는다. 해당 파일을 쓰는 프로세스가 끝났는지 확인한 뒤 잔여 lock을 제거하고 재시도한다. 출력 symlink는 거부한다.
- KG 번들은 읽어 둔 입력 스냅샷의 투영이다. `--out`으로 원본 records 파일을 덮어쓸 수 없다. 정규화된 record UID가 충돌하면 실패한다.
- 레코드 노드는 등록된 `[Longinus, ReferenceSite]` 라벨을 사용한다. `INSTANCE_OF → sym:Concept:usl`, KG 끝은 `LONGINUS_BINDS`, 선택적 비-KG anchor는 `MATERIALIZES_AS_FILE` / `BOUND_TO_EXTERNAL_CITATION` / `HAS_SOURCE_REPOSITORY`를 사용한다.
- 대상 KG source는 기본 `canonical-neo4j`이며 `--target-kg-source`로 바꿀 수 있다. 다른 KG의 같은 UID를 대상 KG 노드로 혼동하지 않도록 `--anchors`의 `{ "link-id": { "from": "target-graph-uid" } }`로 명시적인 현지 anchor를 요구한다. 같은 source의 KG UID는 다른 UID로 재매핑할 수 없다.

## 검증과 남은 범위

2026-09-08 CLI·MCP·스킬·자동 갱신: 전체 **163개 테스트**, 타입 검사와 ESM/타입 선언 빌드 통과. 실제 stdio 클라이언트에서 9개 도구, 등록 ID 조회, 변경 시 갱신, 잘못된 편집 거부, 동일 문맥 `UNCHANGED`, 패키지 bin symlink 시작을 확인했다. 새 JSON API는 prototype·getter에 둔 옵션이 사라져 조회 범위가 넓어지는 입력을 거부한다. [검증 manifest](audit/platform-verification-2026-09-08.json)와 [CLI/MCP 실행 기록](audit/platform-smoke-2026-09-08.json)을 남겼다. 문맥 바이트 절감은 확인했지만 Cypher 대비 성능·실제 모델 토큰 우위는 측정하지 않았다.

2026-09-08 코드 내장·GEIP·HSWM 통합: 전체 **146개 테스트**, 타입 검사, ESM/타입 선언 빌드와 패키지 import를 통과했다. GEIP 원본 fixture는 기존 Python 검증기의 문서 구조 검사를 통과했고, 코드→GraphSpec→4개 로컬 자원 관측→실제 HSWM 소비자 흐름도 확인했다. [검증 manifest](audit/code-geip-hswm-verification-2026-09-08.json)와 [관측·HSWM 실행 기록](observations/engineering-2026-09-08T05-42-29-113Z/receipt.json)에 구현·원문·plan·보고서·소비자 digest를 남겼다. HSWM의 `READY`는 고정된 참조의 가용성이고 의미의 참이나 admission 판정이 아니다. 현재 HSWM 소비자가 받지 못하는 URL 별칭 조합은 handoff에서 명시적으로 거부한다.

2026-09-08: 전체 테스트 **129개**와 `tsc --noEmit` 통과. 의미 설명 반전, 관측 중 plan·원문 옵션 변경, 주소·내용·의미 계약 분리, 선택 조회·허용 목록·리다이렉트·심볼릭 링크, CLI 관측 기준 저장/비교를 검증했다. 관측 JSON은 필드 타입과 검사 상태·조회 범위·통계의 내부 일관성도 검사한다. 압축 맥락의 경로 복원·캐시 무효화·바이트/토큰 예산 경계도 검증한다. 게임 예제의 [실행 결과](examples/game-workflow-result.json)는 격리 fixture에서 측정한 값이다. [적대적 검증 후속 수정](docs/ADVERSARIAL_FIXES_2026-09-08.md)은 명시적 null 옵션 거부, resolver 객체 분리, 투영 출처 일치, 확정 레코드 완전성, 입력 파일 보호, KG 결과 identity 검사를 포함한다. [2차 후속 수정](docs/ADVERSARIAL_FIXES_ROUND2_2026-09-08.md)은 클래스 옵션 보존, URL 중복 조회·통계 통일, 레거시 KG 동일성, 검증 사본 투영, resolver 실패 검증을 추가했다.

2026-09-07: 테스트 **56개**와 `tsc --noEmit` 통과. 테스트는 임시 Git·파일과 HTTP/MCP fixture를 사용하며 특정 호스트 checkout이나 실서비스에 의존하지 않는다. 사용자가 열거한 8쌍의 정상→변경→반복 감사→기준 갱신, 미완성 기준 복구, Git 커밋 고정, 주소 이동, KG source·UID·SSE, HTTP·timeout·본문 제한, CLI 전체 흐름과 저장 충돌을 포함한다. 실제 canonical KG의 `sym:Concept:usl` 읽기와 v0.1 예제 14건·2건 입력 호환성도 확인했다.

v0.1 JSON 스키마는 유지한다. 다만 양 끝의 근거가 없거나 상태가 모순된 `RESOLVES` 레코드는 읽기·저장·투영에서 거부한다. 미확정 상태의 불완전한 기준은 계속 읽어 재검사·rebind할 수 있다. 감사 출력은 상세 보고서 JSONL로 확장됐다. 종료 코드는 `0` 성공, `1` 실행/검증 실패, `2`는 `audit --check`에서 이상 발견, `64`는 CLI 사용 오류다.

언어 핵심 검증에는 역할 타입·이름·참여자 검사, 의미를 보존하는 KG 투영, 도달성과 의미 사실성 분리, `.usl` CLI 전체 흐름을 추가했다.

미구현: Git 심볼/SCIP adapter, 원격 파일 해석, GED, L3/L6 결합, HSWM owner/permit·schema admission. 레거시 관측 레코드는 2항이고, 언어의 링크는 의미 정의의 역할 수에 따른다. URL은 전체 응답 본문을 해시하므로 동적 페이지 변경도 감지하며, fragment가 지정한 부분의 의미를 해석하지 않는다. KG 해시는 v0.1과 같은 공개 metadata·`target_version` 지문이며 전체 그래프를 비교하지 않는다.
