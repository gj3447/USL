# 바인딩 조회와 실행 기록 사용법

USL은 자원 ID를 유지하면서 파일·작업공간·Git 주소·프로그램을 연결하는 바인딩 도구다. 이번 구현은 경로가 바뀌어도 같은 자원을 찾아 쓰고, 실행 여부가 불명확할 때 같은 작업을 중복 호출하지 않도록 돕는다.

## 1. 경로와 Git 상태 확인

[portable bindings](RESOURCE_BINDINGS.md)의 자원 ID와 표현 ID를 먼저 정한다. 폴더 이동은 host의 `workspaces`를, 저장소 안의 파일 이동은 표현의 `path`를 바꾼다. 여러 worktree·GitHub URL은 각각 별도 표현으로 등록한다.

```sh
usl inspect-binding --config host.json \
  --resource validator --representation validator-worktree
```

실행 기능 없이 조회만 쓸 때 host의 `actions`는 빈 배열이면 된다. SDK에서는 `inspectResourceBinding(bindings, selection, { workspaces })` 또는 `inspectCliBinding(hostFile, selection)`을 사용한다.

| 반환 정보 | 읽는 방법 |
|---|---|
| `resource`, `representation`, `locator` | 선택한 ID와 현재 해석된 주소 |
| `content.digest`, `content.bytes` | 로컬 일반 파일에서 읽은 SHA-256과 크기 |
| `content.pinStatus` | 선언한 digest와 `MATCH` / `MISMATCH`, pin이 없으면 `UNPINNED` |
| `git.root`, `git.worktree`, `git.commonGitDir` | 선택 경로가 속한 작업 트리와 공유 Git 디렉터리 |
| `git.head`, `git.dirty` | 로컬 HEAD와 변경 상태. 첫 commit 전 HEAD는 `null` |
| `git.origin` | 자격 증명·query·fragment 원문을 제거한 원격 주소 후보 |

디렉터리 내용 전체를 hash하지 않으며, 원격 locator는 접속하지 않고 `NOT_CHECKED`로 반환한다. 원격 주소 후보는 소유자가 설정한 값이다. GitHub repository ID, fork·mirror 동등성, 같은 commit이라는 원격 사실을 검증하지 않는다. `dirty`는 untracked 파일을 포함하지만 submodule 내부 변경은 제외한다. 결과는 여러 로컬 조회를 합친 `BEST_EFFORT_OBSERVATION`이다.

SDK 기본 파일 한도는 1 MiB, Git metadata 합산 한도는 64 KiB, Git 조회 시간은 15초다. 최대치는 각각 16 MiB·1 MiB·60초다. CLI는 host의 `maxSourceBytes`를 파일 한도로 사용한다. Git 조회 시간은 파일 I/O 전체의 deadline이 아니다. 로컬 조회에는 호스트 Git이 필요하다(POSIX `/usr/bin/git`). Git 실행 오류와 Git 저장소가 아닌 경로를 구분한다.

## 2. 같은 논리 작업의 중복 실행 차단

host에 선택적으로 다음 설정을 추가한다. `directory`는 host 파일 기준이며, workspace가 이동해도 이 저장소와 namespace를 유지해야 한다.

```json
{
  "operations": {
    "namespace": "my-project-validation",
    "directory": "./operation-reservations"
  }
}
```

이 설정이 있으면 `cli-run`에 작업 키가 필수다.

```sh
usl cli-plan --config host.json --action validate --input invocation.json --out plan.json
usl cli-run --config host.json --action validate --input invocation.json \
  --expected-plan 'sha256:<plan.json의 planDigest>' \
  --receipt-dir ./attempt-001 --operation-key validation-request-001
usl cli-inspect --receipt-dir ./attempt-001
```

작업 키는 호출자가 같은 논리 요청을 식별하기 위해 유지하는 값이다. 실행 시도마다 새 receipt directory는 필요하지만, 중복 요청에는 같은 작업 키를 전달한다.

| 조건 | 결과 |
|---|---|
| 처음 보는 키 | intent 저장 → 키 예약 → pin 재검사 → 한 번 실행 |
| 같은 키·같은 의미 digest | `OPERATION_ALREADY_RESERVED`, 실행 0회 |
| 같은 키·다른 의미 digest | `OPERATION_KEY_CONFLICT`, 실행 0회 |
| 불완전하거나 손상된 예약 | `OPERATION_RESERVATION_UNKNOWN`, 실행 0회 |

의미 digest는 action·descriptor·입력·그래프·자원/표현 ID·등록 argv·실행 파일 내용·환경·선언한 source 내용을 결속한다. 해석된 workspace 절대 경로는 제외하므로 폴더 이동만으로 키를 다시 사용할 수 없다. 등록 argv의 문자열이나 환경 변수에 절대 경로를 직접 넣었다면 그 값의 변경은 의미 digest도 바꾼다. `planDigest`에는 실제 실행 환경이 포함되므로 이동 뒤 새 계획을 만들어야 한다.

예약은 프로세스 시작 전에 기록하며 자동 해제하지 않는다. 예약 직후 중단되면 효과가 없어도 같은 키를 차단할 수 있다. `NOT_APPLIED` 대조 결과도 예약을 자동 해제하지 않는다. 새 작업 키는 소유자가 별개 작업으로 판단한 경우에 사용한다. 저장소 삭제·분리·다른 머신의 독립 저장소에는 중복 방지가 이어지지 않는다. 이 기능의 범위는 같은 로컬 예약 저장소의 호출 차단이며 외부 시스템의 exactly-once 보장은 아니다.

## 3. 중단 뒤 과거 기록 조회

`cli-inspect` / `inspectCliAttempt(receiptDirectory)`는 현재 host 설정 없이 당시 파일을 읽는다. intent·계획·결과의 digest와 상호 참조, process/status/lifecycle 일관성을 검사한다. 읽기 합산 기본/최대 한도는 4 MiB다.

- 결과가 있으면 `RECORDED`와 `recordedStatus`를 반환한다.
- intent만 있으면 `UNKNOWN`이다. 시작 전 중단과 효과 발생 후 중단을 구분했다고 추정하지 않는다.
- `externalEffect`는 계속 `UNKNOWN`이다. 정상 종료 기록과 외부 효과 확인은 다르다.
- 손상·교차 연결·한도 초과는 오류다. digest는 서명이 아니므로 파일 전체를 고쳐 hash도 다시 쓴 작성자의 신원을 인증하지 않는다.

실행 상태 계약은 `PLANNED → INTENT_DURABLE → AUTHORIZED → SUCCEEDED | INDETERMINATE | REJECTED`다. intent 이후 시작 전 거부도 가능하다. `AUTHORIZED`는 dispatch 허용이며 OS 프로세스가 시작했다는 관측이 아니다. 종료 상태에서 자동 재시도로 이어지는 전이는 없다. 파일·디렉터리 동기화는 호스트 OS에 의존하며 Windows에서는 디렉터리 fsync를 수행하지 않는다.

## 4. 등록된 소유자 조회로 대조

SDK `connectCliReconciler`에 호스트가 직접 상태 조회 함수를 등록한다. 아래 `owner`와 `trustedRegistration`은 해당 서비스용 호스트 코드가 제공해야 한다.

```ts
import { inspectCliAttempt, connectCliReconciler } from "usl/cli-recovery"

const reconciler = connectCliReconciler({
  id: trustedRegistration.id,
  action: trustedRegistration.action,
  hostDigest: trustedRegistration.hostDigest,
  bindingsDigest: trustedRegistration.bindingsDigest,
  timeoutMs: 5_000,
  maxEvidenceBytes: 64 * 1024,
  query: (context, signal) => owner.readOperationStatus(context, signal),
})
const inspection = await inspectCliAttempt(receiptDirectory)
await reconciler.reconcile(receiptDirectory, {
  expectedInspectionDigest: inspection.inspectionDigest,
})
```

소유자 함수는 `{ outcome: "APPLIED" | "NOT_APPLIED" | "UNKNOWN", evidence: [{ locator, digest }], observedAt }`를 반환한다. 등록 action·host·bindings pin과 당시 기록이 일치해야 하며, intent-only 또는 `INDETERMINATE`만 대조할 수 있다. 입력 JSON으로 임의 함수를 등록하거나 외부 효과의 증명으로 제출하는 CLI는 제공하지 않는다. 반환값의 정확성은 등록된 소유자 구현의 책임이다.

콜백 전에 영구 `reconciliation.lock`을 만든다. timeout·조회 실패·취소는 `UNKNOWN`을 유지하며, lock이 남아 추가 호출을 차단한다. `recoveryLock`으로 이를 확인하고 소유자가 조사한다. 성공한 관측은 별도 `reconciliation.json`에 기록하며 기존 intent/result를 바꾸지 않는다. 원래 프로그램을 재실행하거나 operation 예약을 해제하지 않는다. 콜백이 취소 신호를 무시하면 소유자 쪽 조회가 계속될 수 있다.

## 검증 범위와 다음 작업

[구현 진행 그래프](../research/engineering/binding-progress.graph.json)와 [JSON-LD](../research/engineering/binding-progress.graph.jsonld)는 구현 파일·테스트 정의·순수 Lean 모델·한계를 역할로 연결한다. 기존 resource graph/profile, PROV 출처, SHACL 구조 검사를 사용하며 테스트 정의의 존재를 실행 성공으로 표시하지 않는다. 이전 검토 그래프와 실행 기록은 해당 시점의 자료로 보존한다.

그래프의 파일 주소는 공학 영수증에 기록된 호스트 root를 사용한다. 다른 머신이나 이동한 checkout에서 읽을 때는 같은 resource ID를 유지해 `bind-graph`로 새 workspace에 결속한다.

```sh
npm run binding-progress:build
npm run binding-progress:check
npm run binding-progress:standards
```

`build`는 소스 digest와 그래프를 갱신하고 `check`는 일치 여부를 확인한다. `standards`는 `scripts/requirements-standards.txt`의 Python 의존성이 필요하다. 실제 테스트 실행은 아래 명령과 `npm test`, `npm run test:lean`으로 분리한다.

`npm run example:cli`는 실제 USL 검증 프로그램에 대해 pin 조회 → 계획 → 실행 → 과거 영수증 조회 → 중복 키 거부를 수행한다. `--out-dir`로 산출물을 보존할 수 있다. 예제 키는 `example-check-1`이며 같은 키로 다시 실행하면 거부한다.

Lean 모델은 54개 정리와 TS 대조 444건으로 확장했다. 선택의 유일성·재바인딩 ID 보존·시도 상태 전이가 포함된다. [정확한 증명 범위](LEAN4_INTEGRATION.md#형식-검증-범위)는 순수 모델이며 전체 TS·Git·OS·원격 효과의 증명이 아니다. [이전 계획 T1/T2/T3](CURRENT_STATE_AND_NEXT_STEPS.md)의 구현을 진전시켰지만 모든 저장 경계의 전원 장애 검사와 실제 서비스별 owner 조회는 남아 있다.

다음 실사용 작업은 **연결할 프로그램 하나의 host/bindings와 실제 owner 조회를 등록하고 경로 이동·중단 뒤 대조까지 완주**하는 것이다. 원격 Git identity가 필요한 프로그램에는 해당 호스트의 repository ID 조회를 추가한다. 다단계 workflow runtime은 실제 바인딩 사용 사례에서 필요성이 확인될 때 범위를 정한다.
