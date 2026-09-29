# gj3447/CHU · HSWM · USL 생태계 연결

2026-09-29 사용자 지시: **HSWM과 USL과 CHU가 긴밀히 연결돼야 한다.** 이 문서는 그 연결을 기존 USL
바인딩으로 기록한다. [HSWM 연결](HSWM_CONNECTION.md)과 같은 형식·검증 방법을 쓴다.

| 저장소 | 정체성 (각 저장소 자체 정의) |
|---|---|
| [CHU](https://github.com/gj3447/CHU) | 계산가능 하이퍼우주 — 월드모델과 HSWM을 포함하는 가장 넓은 개념이자 **하이퍼그래프 OS** |
| [HSWM](https://github.com/gj3447/HSWM) | CHU 안의 **LLM 전용** 하이퍼그래프 AI |
| USL | 자원을 의미와 역할로 연결하는 바인딩 문법 (별도 DB 없음) |

CHU 쪽 관계 설명: [CHU `ECOSYSTEM.md`](https://github.com/gj3447/CHU/blob/main/ECOSYSTEM.md).

## USL과 CHU의 관계

USL 링크 하나는 `meaning + participants[{role, resource}]`, 곧 **역할 있는 n항 하이퍼엣지**다.
CHU OS는 저장소 밖 자원과 저장소 사이의 연결을 이 문법으로 표기한다(`SECONDARY_AI` 대응).
자원 ID를 유지하고 표현만 고르는 USL 원칙은 CHU의 "정체성은 ID, 경로는 뷰"와 같다.
이 대응은 USL을 CHU의 저장소나 DB로 바꾸지 않는다. 상태의 정본은 각 시스템이 갖는다.

## 바로 사용하기

USL 루트에서 실행한다. 기본 host는 CHU·HSWM·USL이 같은 부모 디렉터리에 있는 배치를 사용한다.

```sh
npm run example:chu
```

세 저장소의 14개 자원을 로컬 경로에 결속하고, 선택한 11개 파일의 content pin과 각 저장소의 Git HEAD·dirty 상태를
조회한다. 이어서 CHU 3대원칙에서 HSWM Lean 모델까지의 역할 문맥을 반환한다. 어떤 프로그램·Lean 증명도 실행하지 않는다.

## 연결한 자료

| USL 자원 ID | 저장소 | 내용 |
|---|---|---|
| `github:repo:1394029753` | CHU | 저장소·로컬 작업 트리 |
| `github:repo:1305437076` | HSWM | 저장소·로컬 작업 트리 ([HSWM 연결](HSWM_CONNECTION.md)과 같은 ID) |
| `github:repo:1369458368` | USL | 저장소·로컬 작업 트리 |
| `chu:ecosystem` | CHU | 세 저장소 관계와 연결 지점 |
| `chu:three-principles` | CHU | AI native 3대원칙 (사용자 원문 + 증명 상태) |
| `chu:why-hypergraph` | CHU | Wolfram · ZFC · Transformer · HSWM 근거 지도 |
| `chu:os-plan` | CHU | CHU OS 작업계획 하이퍼그래프 |
| `chu:rewrite-model` | CHU | Wolfram 재작성 동역학 Lean 모델 |
| `chu:kernel-prototype` | CHU | multiway 재작성 커널 프로토타입 |
| `hswm:chu-scope-canon` | HSWM | CHU ⊇ HSWM 범위 사용자 정전 |
| `hswm:three-philosophies` | HSWM | 세 철학 Lean 번역 |
| `hswm:semantic-software-model` | HSWM | 의미 그래프 = 프로그램 Lean 모델 |
| `usl:resource-graph-spec` | USL | 범용 자원 연결 문법 |
| `usl:workspace-linking` | USL | 작업환경 연결 계약 |

[그래프](../connections/chu/graph.json)의 링크 5개:

| 링크 | 의미 | 참여 역할 |
|---|---|---|
| `chu:scope-link` | CHU가 HSWM을 개념적으로 포함 (USER_PRIMARY 범위) | container · contained_llm_ai · user_source · restatement |
| `chu:principles-link` | 3대원칙과 그 Lean 번역 | principles · rationale · formal_translation · lean_model |
| `chu:link-layer-link` | USL = CHU의 n항 연결 문법 (SECONDARY_AI 대응) | hypergraph_os · link_grammar · grammar_spec · mapping |
| `chu:workspace-link` | 세 저장소가 공유하는 작업환경 연결 계약 | contract · chu/hswm/usl_repository |
| `chu:kernel-link` | CHU OS 계획·동역학 모델·커널 프로토타입 | repository · plan · dynamics_model · prototype |

`chu:*`·`hswm:*`·`usl:*` 파일 ID는 이 연결의 탐색 ID다. 기존 `connections/hswm/`의 `hswm:*` ID와 겹치지 않는다.
파일은 GitHub Contents API에서 고정 commit의 바이트를 받아 로컬 파일과 비교했고, SHA-256은
[bindings.json](../connections/chu/bindings.json)과 [조회 기록](../connections/chu/source-receipt.json)에 있다.
고정 commit: CHU `752d127`, HSWM `f5f252b`, USL `924cebd` (2026-09-29 재고정: CHU 계획 그래프에 Linux 연구 노드 T09·T15·T22·T34 추가를 검토함).

## 이동·변경 시

[HSWM 연결](HSWM_CONNECTION.md#작업-폴더가-이동했을-때)과 같다. 폴더가 옮겨지면
[host.json](../connections/chu/host.json)의 `workspaces.{chu,hswm,usl}`만 바꾼다. 내용이 바뀌면 예제가
`SELECTED_CONTENT_DRIFT`와 exit 2를 내며, 변경을 검토한 뒤 새 기준 snapshot·digest를 기록한다.
