# Git 작업 상태 artifact profile

CP03의 RAW_REGULAR_GIT_STATE_V1은 clean commit bundle과 별도의 작업 상태
capture·verification profile이다. 이를 독립 Git bundle과 결합해 새 작업환경에
복원하고 선택 USL binding의 로컬 재연결 제안을 만들 수 있다. registry 등록과
복원한 코드 실행은 수행하지 않는다.

exportGitWorktreeState는 owner가 pin한 HEAD와 object format을 확인하고,
HEAD tree, index의 path/stage 0–3/mode/blob OID, index path별 working raw bytes
또는 ABSENT, 그리고 명시 allowlist의 untracked regular file bytes를 분리해
state artifact에 기록한다. index에 없는 HEAD-only path는 선택하지 않으면
working bytes로 수집하지 않는다. verifyGitWorktreeState는 receipt digest,
owner/repository/worktree/HEAD pin, state digest와 artifact byte 목록을 다시
확인한다.

index의 `blobDigest`와 working의 `blobDigest`는 다른 blob을 가리킬 수 있다.
각 blob은 SHA-256 digest, 길이, canonical base64를 갖고 index blob은 Git의
`blob <length>\0<bytes>` 방식으로 SHA-1 또는 SHA-256 OID까지 다시 계산한다.
HEAD tree는 원본에서 관측한 path/mode/OID 목록이다. 이 sidecar에는 commit/tree
객체와 이력이 없으므로 verifier만으로 HEAD의 객체 폐쇄까지 재증명하지 않는다.
복원 API는 [CP01/02의 독립 Git 객체 검증](PORTABLE_TRANSFER_GIT_IMPORT.md)과
같은 owner/repository/HEAD의 sidecar를 연결하고 실제 HEAD tree와 대조한다.

Git rename은 별도 저장 상태로 취급하지 않는다. HEAD의 이전 path와 index의 새
path를 각각 보존한다. stage-0와 stage-1/2/3의 혼합은 거부하고 충돌 stage 각각의
mode/OID/payload를 보존한다. 독립된 unmerged index는 지원하지만 MERGE_HEAD 등
진행 중인 merge의 재개 상태는 별도 계약이 필요하므로 HOLD다.

capture 전후 전체 state observation이 같아야 한다. 이것은 atomic filesystem
snapshot 주장이 아니다. symlink·special file·sparse checkout·attributes/filter·LFS
pointer·intent-to-add·skip-worktree·assume-unchanged·merge/rebase 같은 진행 상태는
HOLD로 거부한다. stash, reflog, ignored files, 미선택 untracked, config, hooks,
credentials, history는 포함하지 않는다.

검사 대상 regular 파일은 owner 실행 비트만 `100644`/`100755`로 보존한다.
소유권, ACL, 전체 permission, xattr는 이 profile의 보존 대상이 아니다. HEAD-only
path는 index에서 이미 제거됐기 때문에 현재 남아 있는 파일도 untracked 선택이
없으면 수집하지 않는다. `.env` 계열 및 알려진 private 설정/키 경로는 명시적으로
선택하더라도 거부한다. 이를 모든 secret 내용의 탐지기로 간주하지 않는다.
무시된 파일과 미선택 untracked는 디렉터리를 재귀 탐색하여 수집하지 않는다.
빈 디렉터리의 존재·권한도 수집·재구성하지 않는다. base 파일을 제거하는 과정에서
빈 디렉터리가 남을 수 있으며 복원 결과는 `emptyDirectories: NOT_RECONSTRUCTED`를
명시한다. 원본 파일시스템 전체의 디렉터리 구조 일치를 주장하지 않는다.

분리된 linked worktree와 detached HEAD에서도 실제 common/admin 디렉터리를
확인한다. index version 2/3/4의 stage/mode/OID를 읽지만 원본 index 파일 자체,
stat cache, resolve-undo, split-index, intent-to-add 등은 재생 가능한 상태로
포함하지 않는다. 지원하지 않는 index flags와 resolve-undo/split-index는 HOLD다.
`ls-files --debug`의 flag framing을 엄격하게 인식하며 다른 형식이면 중단한다.

## API

현재 저장소 내부의 `src/addons/portable-transfer-git-state.ts` API다. CLI와 npm
package export에는 아직 연결하지 않았다. 다음 예시의 실제 경로와 반환 경로는
로컬 값이며 공유 저장소에 커밋하지 않는다.

```ts
const captured = await exportGitWorktreeState({
  schema: "usl-git-state-export/v1",
  sourceRoot, destinationParent, // 서로 포함하지 않는 기존 절대 디렉터리
  ownerNamespace: "urn:example:owner", repositoryId: "repo", worktreeId: "main",
  issuer: "urn:example:operator", observedAt: "2026-10-06T00:00:00Z",
  expectedHead, expectedObjectFormat: "sha1", // 소유자가 확인한 HEAD와 형식
  selectedUntracked: ["notes/draft.txt"],
})
const verifiedState = await verifyGitWorktreeState({
  schema: "usl-git-state-verify/v1",
  artifactPath: copiedArtifactPath,
  expectedReceiptDigest: captured.receiptDigest, // payload와 별도로 보관한 pin
  allowedOwnerNamespace: "urn:example:owner", expectedRepositoryId: "repo",
  expectedWorktreeId: "main", expectedHead,
})
```

반환 artifact 디렉터리에는 `state.json`, `receipt.json` 두 regular 파일만 있다.
receipt는 원본 state bytes와 sorted-key JSON digest를 모두 연결한다. 서명이나
접근 권한은 아니다. verifier는 독립 receipt pin, 정확한 파일 목록, blob bytes와
Git OID, index/working/선택 집합의 일관성을 검사한다. 반환 state는 동결된 데이터며
복원 handle이 아니다. 관측 후 파일 변경이나 재등록을 승인하지 않는다.

두 API 모두 `maxBytes`, `maxEntries`, `maxDurationMs`를 받을 수 있다. 고유 blob
총량의 기본 한도는 16 MiB, 최대는 64 MiB다. 각 HEAD/index/working/선택 목록은
최대 10,000개며 별도의 4 MiB Git metadata 한도가 있다. 시간은 기본 60초,
최대 300초다. base64와 JSON overhead에는 별도 encoded 크기 한도를 적용한다.
이 값은 프로세스 전체 RSS나 운영체제 I/O의 강제 sandbox가 아니다.

수집 동안 선택 source/destination을 변경하지 않는 것이 사용 조건이다. 전후
관측에서 드러난 변경은 게시를 중단하고 새 임시 산출물만 정리한다. 변경 후 원상
복구, 같은 계정의 적대적 경로 교체, crash 자동 복구까지 보장하지 않는다.

## 새 작업환경 복원과 선택 binding

`src/addons/portable-transfer-git-state-restore.ts`의 `importGitWorktreeState`는
새 목적지에 `repository.git`, `worktrees/<leaf>`, `restore.json`을 만든다.
먼저 prerequisites 없는 base bundle의 독립 receipt pin을 검증하고 객체를
unbundle/fsck한다. 각 state receipt도 별도로 고정하며 owner/repository/HEAD,
object format, branch 또는 detached 상태를 대조한다. sidecar의 HEAD tree
목록도 bundle의 실제 tree와 같아야 한다.

```ts
const revisionId = gitStateRevisionId(captured.receiptDigest)
const restored = await importGitWorktreeState({
  schema: "usl-git-state-import/v1",
  bundlePath: copiedCleanBundlePath,
  expectedReceiptDigest: cleanBundleReceiptDigest,
  destinationParent: restoreParent, destinationName: "restored-work",
  allowedOwnerNamespace: "urn:example:owner", expectedRepositoryId: "repo",
  worktrees: [{
    worktreeId: "main", path: "main", head: expectedHead, branch: "refs/heads/main",
    artifactPath: copiedArtifactPath,
    expectedStateReceiptDigest: captured.receiptDigest,
  }],
  files: [{
    nativeId: "memory", representationId: "memory-original", revisionId,
    worktreeId: "main", path: "notes/draft.txt",
    expectedByteDigest: workingByteDigest, expectedByteLength: workingByteLength,
  }],
  freshnessMode: "LOCAL_BRANCH",
})
await recheckGitStateRestore(restored)
const proposal = await rebindGitStateRestore(restored, {
  bindings, workspaceId: "moved",
  selections: [{ resource: "memory", bindingRepresentation: "memory-local",
    nativeId: "memory", representationId: "memory-original", revisionId,
    worktreeId: "main" }],
  graph: originalGraphJson,
})
```

`rebindGitStateRestore`는 `src/addons/portable-transfer-git-state-bindings.ts`에
있다. `files`는 재연결할 working regular 파일의 명시적인 독립 pin이며 빈 배열도
허용한다. index에만 존재하거나 working에서 삭제된 파일에는 working binding을
만들 수 없다. 반환 파일의 `parentHead`는 base commit, `revisionId`는
`urn:usl:git-state:<state-receipt-sha256>`이다. 수정된 bytes를 HEAD의 commit
내용으로 표시하지 않는다. 같은 native ID도 각 state revision으로 구분한다.

1. 임시 경로에서 clean base를 검증하고 새 worktree들을 생성한다.
2. 각 worktree의 private index를 비운 뒤 raw blob을 넣고 stage 0/1/2/3와
   mode/OID/path를 재구성한다. 그 뒤 실제 `ls-files --stage -z`와 대조한다.
3. HEAD 파일을 새로 만든 경로에서 제거하고 state의 working bytes를 별도로
   생성한다. ABSENT, 삭제/rename, 실행 비트와 선택 untracked를 검사한다.
4. 최종 경로의 gitfile/backlink를 생성하고 전체 파일·index·Git 설정·HEAD를
   fingerprint로 고정한 뒤 목적지를 게시한다. 이미 있는 목적지는 재사용하지 않는다.

최대 16개 worktree를 한 번에 복원할 수 있으며 branch 중복은 거부한다.
state와 다른 branch로 바꾸거나 detached 상태를 임의로 attach하지 않는다.
각 worktree를 별도 workspace ID에 연결하려면 `workspaceId` 대신
`workspaces: { main: "main-restored", other: "other-restored" }`를 지정한다.
선택하지 않은 표현, 기존 자원 ID, 의미, 참여 역할 순서와 provenance는 유지한다.
`HISTORICAL_SNAPSHOT`(기본값)은 `snapshot`, `LOCAL_BRANCH`는 `working-copy`
관계를 명시한 표현에만 연결한다. 기존 digest가 복원 bytes와 다르면 중단한다.

반환 객체 자체가 현재 프로세스의 검증 handle이다. JSON 저장 후 재입력하거나
clean restore API에 교차 사용하면 거부한다. 재연결 전후 `recheckGitStateRestore`
검사로 전체 restore의 bytes/mode/메타데이터 변경을 확인한다. Git 명령이 index
stat cache를 갱신한 것만으로도 stale이 될 수 있으므로 재연결은 작업 재개 전에
수행한다. 결과의 `PINNED_STATE_SNAPSHOT`은 현재 upstream의 최신성 주장이 아니다.
후속 실행은 owner의 checkout guard와 `ALLOW_DIRTY` 등 명시 정책이 담당한다.

복원 입력의 `maxStateBytes`는 모든 sidecar blob bytes 합계(기본 16 MiB, 최대
64 MiB), `maxStateEntries`는 모든 HEAD/index/working entry 합계(기본·최대
10,000개)를 제한한다. `maxCheckoutBytes`는 base checkout과 실제 state working
bytes 각각의 합계에 적용하며 기본 64 MiB, 최대 512 MiB다. base bundle의 기존
`maxBundleBytes`, `maxUncompressedBytes`, `maxObjects`도 적용한다. 시간 예산은
sidecar 검증부터 게시까지 공유한다. 복원과 재연결 과정에서 hook/filter/외부 코드를
실행하거나 네트워크로 부족한 객체를 가져오지 않는다.

이 importer에는 같은 HEAD/branch roots를 가진 **이미 확보한 clean bundle**이
필요하다. dirty 상태 하나에서 base bundle과 sidecar를 함께 만드는 통합 exporter와
CP03 CLI는 아직 남아 있다. artifact의 `scope.restore/bindings: NOT_IMPLEMENTED`는
v1 capture producer 자체의 범위를 보존한 값이며 consumer 복원 결과에는 별도의
`RAW_REGULAR_SELECTED_STATE_ONLY` 범위를 기록한다. symlink·sparse·진행 중 merge,
stash/reflog 등 제외 항목은 이 consumer가 되살리지 않는다. 이 결과를 전체 작업환경,
원자 snapshot, crash 자동 복구, 타 OS나 실기기 간 인수 검증 완료로 해석하지 않는다.

Git index와 path state의 원문 규칙은 [git-update-index](https://git-scm.com/docs/git-update-index),
[git-ls-files](https://git-scm.com/docs/git-ls-files), [gitformat-index](https://git-scm.com/docs/gitformat-index)를 따른다.

```sh
python3 -B scripts/record-clean-git-progress.py --check
```
