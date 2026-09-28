# gj3447/HSWM 연구 저장소 연결

[HSWM](https://github.com/gj3447/HSWM)의 로컬 checkout과 GitHub 자료를 기존 USL 바인딩으로 연결했다. 대상은 2026-09-28에 진행 중인 **의미 상태 선택·후속 실행·전체 Lean 연구 목표**다.

선정 시 GitHub API의 최근 push와 commit을 확인했다. 기준 commit은 [`59cff67777cac245b9b0929cb23a511d3e106a0f`](https://github.com/gj3447/HSWM/commit/59cff67777cac245b9b0929cb23a511d3e106a0f), 기록된 push 시각은 `2026-09-28T06:40:24Z`다. GitHub repository ID `1305437076`과 node ID를 [조회 기록](../connections/hswm/source-receipt.json)에 남겼다. 이름이나 SSH 주소 유사성만으로 저장소 identity를 추정하지 않았다.

## 바로 사용하기

USL 루트에서 실행한다. 기본 host는 USL과 HSWM이 같은 부모 디렉터리에 있는 배치를 사용한다.

```sh
npm run example:hswm
```

이 명령은 8개 자원을 로컬 경로에 결속하고, 선택한 7개 파일의 content pin과 Git HEAD·dirty 상태를 조회한다. 이어서 연구 계획에서 테스트까지의 역할 있는 문맥을 반환한다. HSWM 프로그램이나 모델·학습·Lean 검사를 실행하지 않는다.

`SELECTED_CONTENT_PINS_MATCH`는 선택한 파일 내용의 일치다. 저장소 전체의 깨끗함이나 연구 성공이 아니다. `localGit.dirty`와 `headMatchesRecordedSnapshot`은 별도로 표시한다. 연결 시 HSWM에는 다른 파일의 진행 중인 변경이 있었으며 이 연결 작업은 HSWM 파일을 수정하지 않았다.

## 연결한 자료

| USL 자원 ID | 내용 |
|---|---|
| `github:repo:1305437076` | HSWM 저장소·로컬 작업 트리 |
| `hswm:research-plan` | 전체 HSWM의 Lean 목표와 현재 연구 공백 |
| `hswm:execution-contract` | 의미 상태 선택과 다음 실행의 계약 |
| `hswm:execution-adapter` | lifecycle 선택 실행 adapter |
| `hswm:selected-state` | 선택된 canonical 의미 상태를 다시 여는 구현 |
| `hswm:selected-test` | 해당 selected-state integration 테스트 정의 |
| `hswm:abstraction-model` | 운영 추상화 Lean 모델 소스 |
| `hswm:proof-record` | 기존 Lean 검사 기록 |

`hswm:*`는 이 연결에서 부여한 탐색 ID이며 HSWM canonical atom UID를 새로 발급한 것이 아니다. [그래프](../connections/hswm/graph.json)는 repository → plan/contract, contract → adapter/implementation/test, plan → abstract model/historical record를 역할로 연결한다. 관계는 탐색을 위한 명시적 편집 판단이다.

선택한 파일은 GitHub Contents API에서 고정 commit의 바이트를 받아 로컬 파일과 비교했다. [bindings.json](../connections/hswm/bindings.json)의 SHA-256은 그 기준 내용이다. 기존 Lean 기록의 상태는 당시 작성자의 검증 결과이며 이 연결에서 재실행하거나 전체 HSWM의 효능 증명으로 승격하지 않는다.

## 로컬 경로와 GitHub 주소 선택

각 파일에 `*-local`, `*-snapshot`, `*-github` 표현이 있다. 자원 ID는 같고, 표현 ID로 어떤 주소를 사용할지 선택한다.

```sh
# 로컬 파일 내용과 Git 상태
npm run usl -- inspect-binding --config connections/hswm/host.json \
  --resource hswm:research-plan --representation research-plan-local

# 같은 자료의 고정 commit GitHub permalink
npm run usl -- locate --config connections/hswm/host.json \
  --resource hswm:research-plan --representation research-plan-github

# 저장소를 읽지 않고 역할·연결만 탐색
npm run usl -- adapt --format resource-graph \
  --graph connections/hswm/graph.json --namespace gj3447.hswm.research \
  --operation context --focus hswm:research-plan --target hswm:selected-test --compact
```

여러 표현에서 선택을 생략하면 모호성 오류가 난다. 로컬 실패를 원격 읽기로 자동 대체하지 않는다. `inspect-binding`으로 원격 표현을 선택하면 주소만 반환하고 내용을 가져오지 않는다.

## 작업 폴더가 이동했을 때

[host.json](../connections/hswm/host.json)의 `workspaces.hswm`만 새 root로 바꾼다. 현재 기본값 `../../../HSWM`은 host 파일 기준이다. 다른 worktree를 동시에 연결하려면 workspace와 표현을 각각 추가하고 명시적으로 선택한다.

개인용 host를 별도 위치에 둘 수도 있다. 이 경우 `bindings`도 그 host 위치 기준으로 지정한다.

```sh
npm run example:hswm -- --config /absolute/path/to/my-host.json
```

현재 로컬 주소를 적용한 그래프가 필요하면 다음 명령을 사용한다. 출력 파일은 새 경로여야 한다.

```sh
npm run usl -- bind-graph --config connections/hswm/host.json \
  --graph connections/hswm/graph.json \
  --selections connections/hswm/local-selections.json --out /tmp/hswm-bound.json
```

반환 envelope의 `graph`가 다시 결속한 그래프다. 자원 ID와 의미·역할은 유지한다. JSON-LD/RDF 교환은 기존 `adapt --operation jsonld`를 사용한다.

## 연구가 진행되어 내용이 바뀌었을 때

조회는 `MISMATCH`, 예제는 `SELECTED_CONTENT_DRIFT`와 exit 2로 알려준다. 이후 변경 자체를 오류나 연구 실패로 판정하지 않는다. 새 GitHub commit의 선택 파일과 변경 내용을 검토한 다음 새 기준 snapshot·digest를 기록한다. 자동 실행 시마다 pin을 새 값으로 덮어쓰지 않는다.

현재 host의 `actions`는 빈 배열이다. 이번 연결의 범위는 **연구 자료 찾기·정확한 경로 해석·내용 변화 확인**이다. HSWM의 기존 `hswm-workspace`나 특정 연구 검사 프로그램을 실행 기능으로 연결하려면 실제로 필요한 명령 하나와 입출력·소스 pin 계약을 추가한다.
