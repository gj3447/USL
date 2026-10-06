# Git 작업 상태 artifact profile

CP03의 RAW_REGULAR_GIT_STATE_V1은 clean commit bundle과 별도의 작업 상태
capture·verification profile이다. 현재 범위는 artifact 생성과 검증이며 복원,
USL binding 재연결, registry 등록을 수행하지 않는다.

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
향후 복원은 [CP01/02의 독립 Git 객체 검증](PORTABLE_TRANSFER_GIT_IMPORT.md)과
같은 owner/repository/HEAD의 sidecar를 연결해야 한다.

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

따라서 CP03의 local capture case가 통과해도 full workspace restore나 portability
acceptance가 완료된 것은 아니다. 다음 단계에서 state restoration과 owner-selected
USL rebind를 별도 acceptance로 검증한다.

Git index와 path state의 원문 규칙은 [git-update-index](https://git-scm.com/docs/git-update-index),
[git-ls-files](https://git-scm.com/docs/git-ls-files), [gitformat-index](https://git-scm.com/docs/gitformat-index)를 따른다.

```sh
python3 -B scripts/record-clean-git-progress.py --check
```
