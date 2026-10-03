# 선택형 checkout guard

`usl/checkout-guard`는 선택한 로컬 바인딩이 owner가 지정한 checkout·HEAD·dirty 조건에 맞는지 검사한다. 파일 bytes가 같아도 다른 HEAD나 다른 checkout을 골랐다면 `HOLD`로 남긴다. 기존 `inspectResourceBinding`과 기본 CLI의 의미는 유지한다.

이 기능은 [통합 개발 계획](DEVELOPMENT_PLAN.md)의 DG01이다. 실제 실행 근거와 후속 작업은 [개발 진행](DEVELOPMENT_PROGRESS.md)에서 기록한다.

## owner 입력과 로컬 위치

정책의 `resource`, `representation`, `checkoutId`, `expectedHead`는 owner가 독립적으로 지정한다. 현재 관측에서 기대값을 자동 생성하지 않는다. host는 `workspaces` 및 `checkouts` 등록을 별도 전달한다.

- resource ID와 representation ID는 기존 바인딩의 정체성이다.
- checkout ID는 owner가 관리하는 작업 사본 ID다. 경로·branch·commit·common Git directory를 이 ID로 취급하지 않는다.
- workspace/root는 현재 기기의 로컬 위치다. 이동 후에는 같은 checkout ID를 유지하면서 owner가 두 위치 등록을 명시적으로 바꾼다.
- Git root는 등록한 checkout root와 일치해야 한다. 저장소 하위 디렉터리를 checkout root로 오인한 등록은 통과하지 않는다.

host 등록이 해당 checkout에 속한다는 것은 owner의 주장이다. 복사된 ID만으로 물리적 사본의 진위나 접근 권한을 증명하지 않는다. 자동 탐색·복원·등록 공유는 하지 않는다.

## 사용 예

```ts
import { parseResourceBindings } from "usl/resource-bindings"
import { prepareCheckoutGuard, recheckCheckoutGuard } from "usl/checkout-guard"

const bindings = parseResourceBindings({
  schema: "usl-resource-bindings/v1",
  resources: [{
    id: "memory:project",
    representations: [{
      id: "local", relation: "working-copy", kind: "workspace",
      workspace: "project", path: "memory.json",
    }],
  }],
})
const selection = { resource: "memory:project", representation: "local" }
// This commit comes from the owner's independently selected revision.
const expectedCommit = "0123456789012345678901234567890123456789"
const host = {
  workspaces: { project: "/local/project" },
  checkouts: { projectWorker: { workspace: "project", root: "/local/project" } },
}
const prepared = await prepareCheckoutGuard(bindings, selection, {
  resource: "memory:project", representation: "local", checkoutId: "projectWorker",
  expectedHead: { kind: "COMMIT", value: expectedCommit }, dirtyPolicy: "REQUIRE_CLEAN",
}, host)
if (prepared.report.status !== "PASS") throw new Error(prepared.report.reasons.join(", "))

// Recheck immediately before the separately authorized owner operation.
const current = await recheckCheckoutGuard(prepared, host)
if (current.status !== "PASS") throw new Error(current.reasons.join(", "))
// The owner may now proceed through its existing permission and execution flow.
```

`inspectCheckoutGuard`는 같은 네 입력으로 한 번 관측한다. `parseCheckoutGuardPolicy`는 정책의 구조를 검사한다. `prepareCheckoutGuard`와 `recheckCheckoutGuard`는 같은 프로세스에서 쓰며, 재직렬화한 prepared 객체는 재사용하지 않는다. 이동·정책 변경 후에는 새로 준비한다.

`expectedHead: { kind: "UNBORN" }`은 아직 commit이 없는 저장소를 명시한다. `ALLOW_DIRTY`는 허용한 dirty 상태도 준비 시점 이후 바뀌지 않았는지 재검사한다. detached HEAD는 owner가 `allowDetached: true`로 명시한 경우에만 허용한다. unknown·불완전한 관측·지원하지 않는 checkout 상태는 `HOLD`다.

## 검사 범위와 한계

검사는 선택한 바인딩, owner checkout 등록, Git root·HEAD, index와 관측 가능한 tracked/untracked 상태를 대조한다. 선택한 파일의 content pin 불일치도 통과시키지 않는다. submodule이 있는 checkout, sparse checkout, assume-unchanged/skip-worktree flag, 활성 Git filter command와 비정규 파일은 v1에서 보류한다. `allowSparse`를 지정해도 이 구현의 sparse 제한을 해제하지 않는다. `.gitignore`에 의해 제외된 파일 전체의 백업이나 임의 실행 파일의 무결성을 보장하지 않는다. owner action의 runner/content pin은 기존 실행 전 검사를 계속 사용한다.

Git 명령은 shell 없이 고정 인자로 실행하고, hooks/fsmonitor/external diff와 외부 환경 변수 영향을 제한한다. 명령 실패·예산 초과를 빈 성공으로 취급하지 않는다. v1은 관측 전체의 Git 출력과 읽은 파일 bytes를 합쳐 1 MiB, Git 호출 하나의 출력을 256 KiB, 파일시스템 항목을 4,096개, untracked 파일을 256개로 제한한다. 15초 공유 deadline을 Git timeout 및 파일 읽기 사이에 검사한다. 지원하지 않는 파일 유형은 보류한다. 이 제한에 맞지 않는 큰 checkout은 전체 검사를 했다고 보고하지 않는다.

`PASS`는 이번 관측이 명시한 조건과 맞았다는 뜻이다. 검사는 원자적 snapshot이 아니며 재검사와 실제 사용 사이에도 변경이 일어날 수 있다. 원자성이 필요한 owner는 자기 lock/snapshot/조건부 update 경계 안에서 검사와 작업을 수행해야 한다. guard는 권한, 분산 exactly-once, 자동 backup/restore, 표준 그래프 전체의 상위호환을 제공하지 않는다.

공식 Git 문서의 [index/skip-worktree/assume-unchanged 표시](https://git-scm.com/docs/git-ls-files), [diff와 외부 변환 옵션](https://git-scm.com/docs/git-diff), [revision 검증](https://git-scm.com/docs/git-rev-parse)을 사용해 관측 범위를 구분한다. 이 문서는 해당 기능의 Git 규범 전체 적합성 인증이 아니다.

## 검증

```sh
node --import tsx --test test/checkout-guard.test.ts
npm run typecheck
npm run build
```

실제 Git 임시 저장소에서 같은 bytes/다른 HEAD, 같은 HEAD/다른 checkout, 명시적 move/remap, dirty·detached·unborn·sparse·깨진 gitfile, 준비 이후 변경과 입력 변조를 검증한다. 과거 worktree 감사에서 확인한 기본 inspect의 한계는 역사적 기록으로 남기며, 이 선택형 guard가 그 기본 결과를 소급 변경하지 않는다.
