# Native profile SDK

이 선택적 SDK는 [native 개발 계획](NATIVE_DEVELOPMENT_PLAN.md)의 P01/P02/P03/P05/P06/P08/P09에 해당하는 기반 구현이다. 프로필의 리소스 정체성, 현재 환경의 위치, 관측한 내용, 실제 전달한 원문을 서로 구분한다. [진행 그래프](NATIVE_IMPLEMENTATION.md)는 이 구현과 검증 근거를 기존 작업 ID에 연결한다. 계획의 전체 수용 기준을 완료했다는 뜻은 아니다.

## 제공하는 모듈

| import 경로 | 실제 기능 |
|---|---|
| `usl/native-profile` | 엄격한 manifest/snapshot·read/evaluator/admission/effect 계약, 내용 digest 및 문맥 검사 |
| `usl/native-profile-store` | owner의 로컬 파일 저장소, generation·CAS·허가 발급/소비·철회·재시작 후 중복 차단 |
| `usl/native-observation` | 선택한 파일 및 등록된 Git checkout 관측, process-local prepare/recheck |
| `usl/native-profile-runtime` | 원본 그래프와 host mapping pin을 확인하고 위치만 재바인딩한 뒤 관측·재검사·CAS 전환 |
| `usl/native-http` | 정확한 URL allowlist, bounded GET/redirect, 내용 pin·조건부 캐시·재검사 |
| `usl/native-delivery` | owner loader를 통한 전체 원문 검증 및 호출 대상 전달, opaque delivery handle과 철회 |
| `usl/native-dispatch` | 현재 profile·필수 전달·등록 evaluator를 재검사하고 durable gate 안에서 owner CLI 한 번 실행 |

모듈 import·build·설치는 외부 연결이나 실행을 시작하지 않는다. SDK 호출 시 owner가 전달하는 등록과 callback만 사용한다. 리소스 링크, digest, 영수증은 권한이나 전자서명이 아니다.

## 환경 하나 바꾸기

Portable manifest에는 stable ID, alias, 상대 경로, 선택 representation, 원본 그래프·정책·자료의 pin을 넣는다. 실제 root와 HTTP allowlist, checkout 등록은 owner의 로컬 `NativeProfileEnvironment`에 둔다. 환경을 파싱한 결과의 digest가 snapshot의 `hostBindingDigest`와 일치해야 한다.

```ts
import { createNativeProfileSnapshot } from "usl/native-profile"
import { openNativeProfileStore } from "usl/native-profile-store"
import { nativeHostBindingDigest, switchNativeProfile } from "usl/native-profile-runtime"

// manifest, graphText, environmentA/B, privateStoreDirectory는 owner가 공급한다.
const initialSnapshot = createNativeProfileSnapshot(
  manifest, 1, nativeHostBindingDigest(environmentA),
)
const store = await openNativeProfileStore({
  directory: privateStoreDirectory,
  ownerNamespace: manifest.ownerNamespace,
  initialSnapshot,
})
const current = await store.read()
const result = await switchNativeProfile(store, {
  expectedStateDigest: current.digest,
  graph: graphText,
  manifest,
  environment: environmentB,
})
// COMMITTED, CONFLICT, HOLD, COMMIT_UNKNOWN을 분기한다. 자동 재시도하지 않는다.
```

전환은 graph ID/types/links/provenance와 원본 그래프 digest를 보존한다. `workspaces` alias 집합은 manifest와 정확히 같아야 한다. 파일이 없거나 binding/required-source pin이 다르면 전환을 완료하지 않는다. pin이 없는 가변 자료는 관측 당시의 내용만 기록하며 이전 환경과 내용이 같다는 보장이 없다. 파일을 복사하거나 Git dirty 상태를 옮기는 동작은 포함하지 않는다. 다른 컴퓨터에서는 먼저 내용을 복원하고 새 root 등록을 공급해야 한다.

저장소는 owner별 **현재 활성 프로필을 선택하는 커서**다. 같은 owner의 다른 profile ID도 다음 generation으로 선택할 수 있다. 활성 프로필 철회 후에도 generation과 소비 기록은 남으며, 되돌리기 역시 새 generation이다. old snapshot의 admission은 새 환경에서 사용할 수 없다. 동일 admission ID, invocation ID 또는 이미 소비한 attempt ID를 재사용할 수 없다.

상태는 최대 1 MiB, admission 기록은 최대 1,024개다. 기록을 자동 삭제하지 않으며 가득 차면 HOLD다. 저장소 파일을 예전 백업으로 덮어쓰면 단일 저장소의 재생 방지 보장도 되돌아간다. 여러 컴퓨터가 각자 복제된 writable registry를 쓰는 상황의 전역 중복 방지는 아직 제공하지 않는다.

부모 디렉터리는 이미 존재하는 실제 디렉터리여야 한다. 새 저장소/파일은 각각 0700/0600으로 만든다. owner는 기존 디렉터리의 권한과 파일시스템 무결성을 관리해야 한다. 남은 `writer.lock`은 자동 탈취하거나 삭제하지 않는다. 이전 writer의 종료와 commit 상태를 owner가 확인한 뒤 복구해야 한다. lock 정리가 실패하면 직전 COMMITTED 뒤에도 다음 쓰기는 HOLD일 수 있다. 불명 write는 `COMMIT_UNKNOWN`이며 효과를 재시도할 근거가 아니다. Linux 로컬 파일시스템에서 검증했으며 Windows/네트워크 파일시스템의 동일한 durability는 검증하지 않았다.

## Git 및 HTTP 관측

Git 관측은 owner가 등록한 checkout root와 정책을 요구한다. worktree, common Git directory, HEAD/ref, dirty 상태, SHA-1/SHA-256 object format을 기록하고 재검사한다. 엄격한 checkout guard가 지원하지 않는 상태는 HOLD다. Git 실행은 현재 Linux의 `/usr/bin/git` 경로를 사용한다. 전체 파일시스템이나 실행 효과를 원자적으로 묶는 기능은 아니다.

HTTP는 environment의 `httpPolicies`에 resource/representation, 정확한 `url`, `scopeDigest`, `allowedUrls`를 명시해야 전환에 사용한다. 각 리다이렉트 대상도 allowlist에 있어야 한다. 기본 body budget은 1 MiB, timeout은 15초이며 최대 16 MiB/60초다. 리다이렉트는 최대 5회다. credential URL과 임의 인증 헤더를 받지 않으며 v1의 사용자 헤더는 `Accept`만 지원한다.

캐시는 같은 process에서 준비한 opaque handle과 URL·allowlist·scope·Accept 문맥이 맞아야 사용한다. 조건부 304 응답은 실제 보낸 validator와 저장된 body pin을 확인한다. 원격 응답 status와 representation identity를 별도로 다루어 정상적인 200→304를 내용 변경으로 오인하지 않는다. cache header와 관측 시각은 서버의 현재 진실 또는 지속적인 가용성의 증명이 아니다. URL allowlist는 DNS/연결 peer의 IP를 고정하는 네트워크 경계가 아니며, 전송 접근 정책은 host가 관리해야 한다.

전환은 파일/HTTP를 읽고 다시 확인한 **뒤** owner registry CAS를 수행한다. 그 사이 외부 파일·서버가 바뀌는 일을 원자적으로 막지는 못한다. 반환값의 `READ_ONLY_OBSERVATIONS_THEN_OWNER_CAS`가 이 범위를 명시한다. 등록되지 않은 remote Git locator나 GitHub 서비스 API는 HOLD다.

## 필수 원문 전달

`deliverNativeRequiredSources(snapshot, invocationId, host)`는 등록된 `host.read`와 `host.deliver`를 호출한다. host는 loader/target ID와 실제 읽기 권한을 공급한다. loader 결과의 revision, 원문 SHA-256, byte 길이를 모두 확인한다. JSON Pointer는 해당 문서 안의 논리적 위치를 검사하되, 전달·digest·길이는 항상 **전체 backing document** 기준이다. 필수 항목이 예산을 넘으면 일부를 버리지 않고 HOLD한다.

전달 대상은 snapshot/invocation/source/loader/target과 전달 digest/길이가 일치하는 ack를 반환해야 한다. 성공한 원본 handle만 `checkNativeDelivery(handle, snapshot, invocationId, targetId)`를 통과한다. JSON 복사본, 다른 호출·환경·대상, 철회한 handle은 실패한다. `revokeNativeDelivery`는 context 손실, compaction, handoff 때 host가 호출해야 한다. callback timeout은 HOLD이며 취소는 협력적이다. 취소를 무시하는 owner callback을 강제 종료하는 sandbox는 아니다.

순수 `createNativeReadReceipt`는 문서 형식을 만들 뿐이며 실제 loader 호출의 증거가 아니다. 전달 handle도 모델의 이해나 준수를 증명하지 않는다. P09 dispatcher는 이 전달 handle을 실제 owner CLI 실행 허가에 사용한다. **P10 agent bridge는 아직 연결하지 않았다.** 현재 SDK 밖에서 실행되는 도구를 이 계약이 통제하지 않는다.

## 실제 CLI 실행 경계

`prepareNativeDispatch(host, input, deliveryHandle)`는 현재 활성 profile, 필수 원문 전달, 등록 evaluator의 PASS, 실제 CLI plan을 묶은 process-local handle을 만든다. `executeNativeDispatch(handle)`는 그 원본 handle을 한 번만 사용할 수 있다. 직렬화한 admission이나 복사한 handle로 실행할 수 없다. 준비 단계에서 CLI를 실행하거나 허가를 저장하지 않는다.

owner는 `NativeDispatchHost`에 private store, `readContext` callback, evaluator callback, registration을 공급한다. registration은 논리 action ID와 loader/target ID, profile policy, CLI config 파일·그 원문 SHA-256·descriptor digest·CLI policy digest, 기존 실제 receipt 디렉터리를 고정한다. manifest capability의 `scopeDigest`는 이 **CLI policy 전체의 digest**와 같아야 한다. CLI가 선언한 모든 source와 cwd는 같은 profile의 선택된 resource/representation/path에 속해야 한다. CLI source마다 manifest binding 또는 required-source의 내용 pin이 필수다. 실행 파일과 고정 argv·환경·GraphSpec pin은 기존 CLI host 검사가 담당한다. registration은 owner가 공급하는 신뢰 경계다.

```ts
import { prepareNativeDispatch, executeNativeDispatch } from "usl/native-dispatch"

// host는 owner가 등록하고 delivery는 이번 invocation에 실제 전달한 원본 handle이다.
const prepared = await prepareNativeDispatch(host, {
  invocationId, admissionId, attemptId, request: capabilityInvocation,
}, delivery)
if (prepared.report.status === "READY") {
  const execution = await executeNativeDispatch(prepared)
  // SUCCEEDED / HOLD / UNKNOWN. UNKNOWN은 성공이나 재시도 허가가 아니다.
}
```

실행 전 evaluator를 다시 호출하고 PASS뿐 아니라 evidence digest도 일치해야 한다. 원문 handle의 철회·profile/환경/내용 변경·만료·evaluator FAIL/UNKNOWN/timeout은 실행을 막는다. evaluator 전체 대기와 `readContext` 대기는 기본 5초, 최대 60초다. admission TTL은 기본 60초, 최대 15분이며 등록 clock은 저장소와 일관되어야 한다. callback 취소는 협력적이다. 필수 evaluator callback은 평가만 수행해야 하며 자체적인 외부 효과를 dispatcher가 되돌리지는 않는다.

CLI host의 durable operation store는 필수다. 순서는 **CLI intent 저장 → invocation 기반 operation 예약 → 허가 소비와 execution gate 저장 → 프로세스 실행 → 결과 저장**이다. gate가 있는 동안 profile 활성화/철회와 다른 허가 발급·소비를 막는다. 알려진 결과가 저장되면 gate를 해제하되 소비 기록은 남는다. timeout, 실행 여부를 알 수 없는 예외, 결과 저장 실패, 실행 후 문맥 변경은 `UNKNOWN`으로 남기고 gate를 유지한다. CLI 자체 결과가 성공이어도 native 후속 검사나 저장 실패가 있으면 dispatcher는 성공으로 보고하지 않는다.

복구는 owner가 프로세스 종료와 실제 효과를 확인한 뒤 `reconcileEffect(expectedStateDigest, attemptId, ownerReportedReceipt)`로 명시적으로 기록한다. 이 함수는 재실행하지 않으며 이전 불명 결과 digest와 복구 영수증을 남긴다. 살아 있는 실행의 gate를 owner가 잘못 해제하면 보호가 깨진다. 자동 lock 탈취·자동 재시도·자동 성공 추정은 없다.

이 순서는 여러 파일과 외부 효과를 하나의 원자적 transaction으로 만드는 것이 아니다. crash는 intent/operation/gate를 남겨 이후 진행을 차단할 수 있다. 관측과 실제 실행 사이의 파일·HTTP 상태를 원자적으로 고정하지 않으며 선언된 source만 검사한다. 명령이 관측 대상 자체를 바꾸면 실행 후 검사에서 UNKNOWN이 될 수 있다. receipt/operation/store와 명령 출력은 관측 대상 입력 디렉터리와 분리해야 한다. 여러 컴퓨터에서 복제한 writable registry의 전역 exactly-once, 임의 agent 도구의 전면 통제, HSWM 실행 연결은 이번 범위가 아니다.

## 검증과 남은 연결

실행 가능한 예시는 [환경 전환 테스트](../test/native-profile-runtime.test.ts)와 [필수 전달 테스트](../test/native-delivery.test.ts), [실행 테스트](../test/native-dispatch.test.ts)에 있다. 테스트는 임시 로컬 Git 저장소·파일과 loopback HTTP 서버를 사용한다. 외부 서비스에 쓰거나 실제 HSWM 작업을 실행하지 않는다.

```sh
TSX_DISABLE_CACHE=1 TMPDIR=/dev/shm node --import tsx --test \
  test/native-profile.test.ts test/native-profile-store.test.ts \
  test/native-observation.test.ts test/native-profile-runtime.test.ts \
  test/native-http.test.ts test/native-delivery.test.ts \
  test/native-dispatch.test.ts test/native-dispatch-fault.test.ts test/cli-host.test.ts
npm run typecheck
npm run build
```

다음 연결은 P04의 dirty 복원→전환 orchestration, P07 GitHub 서비스 adapter, P10 agent bridge, P11 조합 확률/W review, P12 입운구 종단 pilot이다. 기존 portable-transfer/CLI/HSWM 기능은 재사용 기반이며 이 신규 프로필과의 종단 연결 완료를 뜻하지 않는다. 필수 규칙과 권한을 W나 샘플링 확률로 완화하지 않는다.
