# CP02 · clean Git 복원과 선택 바인딩

`importCleanGitTransfer`는 [CP01 bundle](PORTABLE_TRANSFER_GIT.md)을 검증해 **새 로컬 root**에 Git 객체 저장소와 여러 worktree를 만든다. `rebindCleanGitRestore`는 검증된 복원의 파일을 기존 USL resource/representation ID에 연결하는 로컬 제안을 반환한다. 원본 checkout, commonGitDir, 원래 backup 경로, 네트워크나 객체 cache에 의존하지 않는다.

현재 범위는 **raw regular clean trees**다. 선택한 branch와 detached HEAD를 그대로 재구성하며, 해당 tree의 모든 일반 파일을 복원한다. `files` 목록은 그중 바인딩에 사용할 파일의 독립적인 ID·revision·byte pin이다. 목록에 없는 추적 파일도 checkout의 일부로 복원한다.

## CLI

```sh
node --import tsx scripts/usl-git-import.ts --help
node --import tsx scripts/usl-git-import.ts --spec /absolute/private/import.json --destination-parent /absolute/existing/output --destination-name restored
```

입력 예시의 OID/digest는 실제 소유자가 확인한 값으로 바꾼다. `expectedReceiptDigest`는 export가 반환한 receipt 파일의 SHA-256을 독립적으로 전달받아 사용한다. 수신한 backup에서 기대 digest를 자동 생성해 신뢰하는 흐름은 아니다. 목적지는 반드시 호출자의 플래그로 지정하며 spec에 `destinationParent`나 `destinationName`이 있으면 거부한다.

```json
{
  "schema": "usl-clean-git-import/v1",
  "bundlePath": "/absolute/copied/backup",
  "expectedReceiptDigest": "sha256:<independently supplied receipt hash>",
  "allowedOwnerNamespace": "urn:example:owner",
  "expectedRepositoryId": "repo:example",
  "freshnessMode": "HISTORICAL_SNAPSHOT",
  "worktrees": [
    { "worktreeId": "main", "path": "main", "head": "<full commit OID>", "branch": "refs/heads/main" },
    { "worktreeId": "experiment", "path": "experiment", "head": "<another pinned commit OID>" }
  ],
  "files": [
    {
      "nativeId": "memory:example",
      "revisionId": "<main full commit OID>",
      "representationId": "memory:example:git",
      "worktreeId": "main",
      "path": "memory.md",
      "expectedByteDigest": "sha256:<raw Git blob bytes hash>",
      "expectedByteLength": 123
    }
  ],
  "maxBundleBytes": 67108864,
  "maxUncompressedBytes": 67108864,
  "maxCheckoutBytes": 67108864,
  "maxObjects": 100000,
  "maxDurationMs": 60000
}
```

API에서는 위 값에 `destinationParent`, `destinationName`을 넣는다. `worktrees`는 1–16개, `files`는 1–1024개이며 `head`는 bundle에 명시된 HEAD 또는 선택 ref의 commit이어야 한다. `branch`를 생략하면 detached HEAD로 만든다. 같은 branch를 여러 worktree에 중복 연결하지 않는다. `revisionId`는 해당 worktree의 전체 commit OID다. 동일 native ID의 다른 revision은 허용하지만, 같은 native ID·revision에 모순되는 파일 descriptor, 중복 representation ID, 같은 worktree의 중복 파일 선택은 거부한다.

세 byte 예산의 기본값은 각각 64 MiB, 최대값은 각각 512 MiB다. `maxCheckoutBytes`는 **모든 worktree의 전체 파일 크기 합**에 적용한다. 복원 파일 수는 전체 100,000개로 제한하며 객체·메타데이터·시간 한도도 적용한다. Git의 전체 RSS나 OS I/O 지연을 제한하는 sandbox는 아니다. 실행 환경은 현재 Linux / Node 24 / Git 2.47.3에서 검증했다.

결과 디렉터리는 다음 형태다. `repository.git`은 bare 저장소이며 논리적인 `main`도 linked worktree로 재구성한다.

```text
restored/
  repository.git/
  worktrees/
    main/
    experiment/
  restore.json
```

## 검증과 출판

receipt, manifest, bundle을 크기가 제한된 regular file로 캡처하고 raw/canonical digest, owner, repository, PACK 객체 수를 검사한다. 새 bare 저장소에서 bundle prerequisites·heads를 검증하고 실제 unbundle, fsck, 객체 집합·비압축 크기를 확인한다. source Git 설정이나 gitfile을 복사하지 않는다.

worktree 전체 tree를 먼저 검사해 파일/byte 한도를 계산한다. `--no-checkout`으로 topology를 만든 뒤 blob bytes를 직접 써서 hook·filter·프로그램 실행 없이 파일과 실행 비트를 복원한다. index와 clean 상태를 확인한 후 새 worktree의 gitfile 및 역방향 `gitdir`을 최종 root 내부 경로로 설정한다. rename 뒤 native Git의 commonGitDir·HEAD·branch·backlink를 다시 확인하므로 사용자의 수동 `git repair`를 성공 전제로 삼지 않는다. Git의 [worktree 관리 디렉터리와 연결 구조](https://git-scm.com/docs/git-worktree/2.43.1#_details)를 따른다.

같은 목적지 이름은 고정 lock과 배타적 `mkdir`로 예약한다. 기존 파일/디렉터리/symlink가 있으면 덮어쓰지 않는다. 일반 실패 시 자신이 만든 staging과 목적지만 정리하고, 기존 workspace나 registry는 건드리지 않는다. 최종 검증 전까지 목적지에 빈 예약 디렉터리가 보일 수 있다. 프로세스 강제 종료나 전원 장애 뒤 남은 lock/예약의 자동 복구는 아직 제공하지 않으며, 기존 경로를 임의로 재사용하지 않는다. 같은 OS 계정이 경로를 적대적으로 교체하는 상황까지 원자적 filesystem snapshot으로 보장하지 않는다.

## USL 바인딩 연결

TypeScript API에서 import와 rebind를 같은 프로세스에서 호출한다. import 반환값은 `WeakMap`에 등록된 검증 핸들이므로 JSON으로 저장했다 읽은 객체나 임의 복제본을 rebind에 사용할 수 없다. CLI 출력은 로컬 결과 보고서이며 실행 권한이나 재사용 가능한 검증 핸들이 아니다.

```ts
import { importCleanGitTransfer } from "./src/addons/portable-transfer-git.js"
import { rebindCleanGitRestore } from "./src/addons/portable-transfer-git-bindings.js"

const restored = await importCleanGitTransfer(ownerImportRequest)
const proposal = await rebindCleanGitRestore(restored, {
  bindings: existingBindings,
  workspaceId: "restored",
  selections: [{
    resource: "memory:example",
    bindingRepresentation: "memory-local",
    nativeId: "memory:example",
    revisionId: mainCommitOid,
    representationId: "memory:example:git",
    worktreeId: "main"
  }],
  graph: existingGraphJson
})
```

`bindings`에는 선택할 workspace representation이 이미 있어야 한다. 기본 `HISTORICAL_SNAPSHOT`은 relation `snapshot`을 요구한다. 소유자가 `LOCAL_BRANCH`로 import한 경우에만 `working-copy`를 허용한다. 어느 경우도 현재 원본의 최신 HEAD라고 선언하지 않는다. 의미, ordered role, resource ID, representation ID, metadata, provenance를 보존하고 선택한 locator와 workspace 매핑만 바꾼다. workspace root는 각 Git worktree root와 일치한다. 한 worktree만 선택할 때는 `workspaceId`를 쓰고, 여러 worktree를 한 번에 연결할 때는 이를 생략하고 `workspaces: { main: "main-restored", experiment: "experiment-restored" }`처럼 worktree ID → workspace ID를 명시한다. 선택한 worktree를 빠짐없이, 서로 다른 workspace ID로 매핑해야 한다. 새 workspace ID가 미선택 representation까지 바꾸게 되면 거부한다.

`recheckCleanGitRestore`는 Git metadata, refs/HEAD, index, config, gitfiles, 모든 복원 파일과 디렉터리의 현재 bytes/mode를 다시 검사한다. 같은 파일 bytes에 다른 HEAD를 붙이거나 config·ignored 파일을 추가해도 핸들이 stale이 된다. 바인딩 제안 전후에 이 검사를 실행한다. 다른 프로그램 실행을 감싸는 실행 guard는 아니며, 제안 생성 후 실제 작업 시점에는 기존 checkout guard를 별도로 사용해야 한다.

결과는 `LOCAL_PROPOSAL_ONLY`, `NOT_GRANTED`, `NOT_REQUESTED`다. 기존 registry에 적용하거나 원격 공유하지 않는다. root 자체를 다시 이동하거나 새 프로세스에서 쓰려면 새 검증 절차가 필요하며, 이 핸들을 경로만 바꿔 재사용할 수 없다.

## 남은 범위

`.gitattributes`가 있는 checkout, symlink, submodule, portable path 충돌은 이 profile에서 거부한다. sparse/partial/shallow/alternates/LFS 등의 원본 상태는 CP01/CP04 경계에 따른다. dirty/index/untracked 보존, stash/reflog 및 진행 중 merge/rebase 보존은 CP03 후속 작업이다. raw blob bytes는 checkout 변환 후 원본 파일 bytes와 다를 수 있으므로 `expectedByteDigest`는 raw Git blob 기준이다. macOS·Windows·실기기 간 이동과 crash recovery 완료를 주장하지 않는다.

[실행·반례·그래프 검증 기록](COMPLETION_PROGRESS.md).
