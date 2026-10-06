# USL 완료 계획의 실행 진행

[완료 계획](COMPLETION_PLAN.md)은 원래 PLANNED/NOT_RUN snapshot으로 유지하고 실제 실행 관측을 여기에 연결한다.

## CP01 · clean Git 계약과 export

상태: **CLEAN_EXPORT_LOCAL_SCOPE**. 독립 pin의 refs/HEAD와 도달 가능한 Git objects를 prerequisites 없는 bundle로 내보낸다. [계약과 사용법](PORTABLE_TRANSFER_GIT.md).

## CP02 · clean Git 복원과 선택 바인딩

상태: **CLEAN_RESTORE_REBIND_LOCAL_SCOPE**. 복사한 bundle에서 새 bare 객체 저장소와 branch/detached worktree들을 만든다. 원본과 backup 삭제 뒤 Git topology·전체 파일·메타데이터를 검사하고, owner가 선택한 binding과 graph locator만 갱신하는 로컬 제안을 반환한다. [계약과 사용법](PORTABLE_TRANSFER_GIT_IMPORT.md).

## CP03 · index/working/untracked raw state capture

상태: **STATE_CAPTURE_VERIFY_LOCAL_SCOPE**. HEAD tree, index stage 0–3 mode/OID, working raw bytes 또는 ABSENT, 선택 untracked bytes를 분리한 sidecar로 검증한다. 이 profile의 복원·USL rebind는 아직 구현하지 않는다. [계약과 사용법](PORTABLE_TRANSFER_GIT_STATE.md).

소스 `e0caa66b8ed5211ccebafdc0d6bdde44372cf67e`; 기록 2026-10-06T16:03:59.534883+00:00. Linux / v24.20.0 / git version 2.47.3에서 **42개 PASS**, 실패·건너뜀 0.

CP01/02 인수 범위는 raw regular clean trees다. CP03는 수정된 작업 상태의 수집·검증까지 포함하며 실제 복원은 대기다. submodule/LFS/alternates·원자 snapshot·프로세스 crash 복구·타 OS·실기기 이동은 이 결과로 완료 처리하지 않는다. 실제 registry에는 쓰지 않으며 권한을 부여하지 않는다.

CP03에서 symlink/special file, sparse, attributes/filter/LFS, intent-to-add, skip/assume flags, 진행 중 merge/rebase는 HOLD다. stash/reflog, ignored·미선택 untracked, config/hooks/history는 수집 범위 밖이다. 이 결과는 전체 workspace 복원 성공이 아니다.

다음은 **CP03의 검증된 작업 상태 복원과 선택 binding 재연결**이다. CP04의 고급 Git 의존성 폐쇄도 남아 있다.

| 인수 조건 | 실행한 검사 |
|---|---|
| CP01-1 · LOCAL_CASES_PASS | CP01-1: SHA-256 repositories export verifiable objects without the source<br>CP01-1: input pins are captured before awaits and manifest contradictions are rejected<br>CP01-1: uncompressed and duration budgets abort without publishing or editing the source<br>CP01-1: standalone CLI exports an explicitly pinned clean repository<br>CP01-1: exports a clean detached linked worktree as a native self-contained bundle without source paths<br>CP01-1: rejects independently pinned HEAD/ref/object-format disagreement before publishing<br>CP01-1: rejects shallow and alternates repositories rather than borrowing an original object store<br>CP01-1: refuses symlink roots, malformed refs, accessors, and tiny budgets without publication |
| CP01-2 · LOCAL_CASES_PASS | CP01-2: source changes after staging starts abort publication and preserve the source<br>CP01-2: ancestor symlinks, hidden dirty index flags, and promisor markers fail closed<br>CP01-2: an unconfigured LFS pointer anywhere in selected history rejects incomplete content<br>CP01-2: Git export CLI refuses invalid flags, special files, and spec destinations<br>CP01-2: rejects dirty index, worktree, and untracked states without changing the source<br>CP01-2: rejects unsupported repository closure forms without executing configured filters<br>CP01-2: rejects unborn and LFS/filter worktrees before publication or filter execution |
| CP02-1 · LOCAL_CASES_PASS | CP02-1: Git restore rebinds selected IDs and ordered roles after source and backup deletion<br>CP02-1: multiple worktrees retain separate explicit workspace roots and representation identities<br>CP02-1: standalone import CLI restores native Git data without source or original backup<br>CP02-1: restores independently from copied transport after original common store disappears<br>CP02-1: SHA-256 restores complete trees, executable bits and independent object storage |
| CP02-2 · LOCAL_CASES_PASS | CP02-2: forged, stale and mismatched Git restore handles cannot produce bindings<br>CP02-2: binding inputs are captured, unselected workspaces stay intact, and branch mode is explicit<br>CP02-2: restored binding uses the existing checkout guard and holds stale HEAD before an owner action<br>CP02-2: import CLI refuses spec-selected destinations, unsafe spec files and unknown flags<br>CP02-2: serializes a destination reservation and preserves an existing destination<br>CP02-2: rejects tampered receipt, collisions, traversal and duplicate native revision before destination publication<br>CP02-2: failed file pins and aggregate checkout budgets clean only newly reserved destinations<br>CP02-2: receipt metadata and a corrupted pack cannot inherit a valid-looking digest chain<br>CP02-2: unsupported transformations, case collisions and symlink transports are refused<br>CP02-2: captured inputs, branch collisions and ignored additions cannot bypass verification |
| CP03-1 · LOCAL_CAPTURE_CASES_PASS_RESTORE_PENDING | CP03-1: working deletion, executable mode divergence, detached worktree and index v4 stay distinct<br>CP03-1: binary state above four MiB verifies within an explicit budget without disclosing unselected bytes<br>CP03-1: captures staged A/worktree B, deletion, rename, executable mode, and selected binary/empty untracked bytes<br>CP03-1: copied artifact verifies after source and original backup are deleted, with no restore authority<br>CP03-1: captures SHA-256 object IDs and native conflict stages which round-trip into an isolated Git index |
| CP03-2 · LOCAL_CAPTURE_CASES_PASS_RESTORE_PENDING | CP03-2: intent-to-add, assume flags, attributes, LFS and special selections HOLD without publication<br>CP03-2: state changes during capture and exhausted budgets leave no artifact or source edits<br>CP03-2: rehashed receipts cannot validate missing blobs, incorrect native OIDs, mixed stages or broader scope<br>CP03-2: path collisions, stale independent pins and input mutation cannot broaden selected capture<br>CP03-2: rejects unsafe Git states, selected paths, unsupported index flags, and incomplete operations<br>CP03-2: edited state bytes cannot inherit the original receipt pin<br>CP03-2: verifier rejects wrong identity/head and an altered receipt |

[실행 receipt](../research/clean-git-progress/receipt.json) · [TAP](../research/clean-git-progress/tests.tap) · [RDF](../research/clean-git-progress/trace.jsonld) · [SHACL](../schemas/clean-git-progress/progress.shacl.ttl).

```sh
python3 -B scripts/record-clean-git-progress.py --check
```
