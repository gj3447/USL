# USL 완료 계획의 실행 진행

[완료 계획](COMPLETION_PLAN.md)은 원래 PLANNED/NOT_RUN snapshot으로 유지하고 실제 실행 관측을 여기에 연결한다.

## CP01 · clean Git 계약과 export

상태: **CLEAN_EXPORT_LOCAL_SCOPE**. 독립 pin의 refs/HEAD와 도달 가능한 Git objects를 prerequisites 없는 bundle로 내보낸다. [계약과 사용법](PORTABLE_TRANSFER_GIT.md).

## CP02 · clean Git 복원과 선택 바인딩

상태: **CLEAN_RESTORE_REBIND_LOCAL_SCOPE**. 복사한 bundle에서 새 bare 객체 저장소와 branch/detached worktree들을 만든다. 원본과 backup 삭제 뒤 Git topology·전체 파일·메타데이터를 검사하고, owner가 선택한 binding과 graph locator만 갱신하는 로컬 제안을 반환한다. [계약과 사용법](PORTABLE_TRANSFER_GIT_IMPORT.md).

소스 `f6a684c396dacd4a43eedff6707bf69c64b66937`; 기록 2026-10-05T13:57:42.068588+00:00. Linux / v24.20.0 / git version 2.47.3에서 **30개 PASS**, 실패·건너뜀 0.

인수 범위는 raw regular clean trees다. checkout attributes·dirty/index/untracked 보존·submodule/LFS/alternates·원자 snapshot·프로세스 crash 복구·타 OS·실기기 이동은 이 결과로 완료 처리하지 않는다. 실제 registry에는 쓰지 않으며 권한을 부여하지 않는다.

다음은 **CP03: dirty/index/untracked 작업 상태 보존**이다. CP04의 고급 Git 의존성 폐쇄와 함께 전체 작업환경 범위를 확장한다.

| 인수 조건 | 실행한 검사 |
|---|---|
| CP01-1 · LOCAL_CASES_PASS | CP01-1: SHA-256 repositories export verifiable objects without the source<br>CP01-1: input pins are captured before awaits and manifest contradictions are rejected<br>CP01-1: uncompressed and duration budgets abort without publishing or editing the source<br>CP01-1: standalone CLI exports an explicitly pinned clean repository<br>CP01-1: exports a clean detached linked worktree as a native self-contained bundle without source paths<br>CP01-1: rejects independently pinned HEAD/ref/object-format disagreement before publishing<br>CP01-1: rejects shallow and alternates repositories rather than borrowing an original object store<br>CP01-1: refuses symlink roots, malformed refs, accessors, and tiny budgets without publication |
| CP01-2 · LOCAL_CASES_PASS | CP01-2: source changes after staging starts abort publication and preserve the source<br>CP01-2: ancestor symlinks, hidden dirty index flags, and promisor markers fail closed<br>CP01-2: an unconfigured LFS pointer anywhere in selected history rejects incomplete content<br>CP01-2: Git export CLI refuses invalid flags, special files, and spec destinations<br>CP01-2: rejects dirty index, worktree, and untracked states without changing the source<br>CP01-2: rejects unsupported repository closure forms without executing configured filters<br>CP01-2: rejects unborn and LFS/filter worktrees before publication or filter execution |
| CP02-1 · LOCAL_CASES_PASS | CP02-1: Git restore rebinds selected IDs and ordered roles after source and backup deletion<br>CP02-1: multiple worktrees retain separate explicit workspace roots and representation identities<br>CP02-1: standalone import CLI restores native Git data without source or original backup<br>CP02-1: restores independently from copied transport after original common store disappears<br>CP02-1: SHA-256 restores complete trees, executable bits and independent object storage |
| CP02-2 · LOCAL_CASES_PASS | CP02-2: forged, stale and mismatched Git restore handles cannot produce bindings<br>CP02-2: binding inputs are captured, unselected workspaces stay intact, and branch mode is explicit<br>CP02-2: restored binding uses the existing checkout guard and holds stale HEAD before an owner action<br>CP02-2: import CLI refuses spec-selected destinations, unsafe spec files and unknown flags<br>CP02-2: serializes a destination reservation and preserves an existing destination<br>CP02-2: rejects tampered receipt, collisions, traversal and duplicate native revision before destination publication<br>CP02-2: failed file pins and aggregate checkout budgets clean only newly reserved destinations<br>CP02-2: receipt metadata and a corrupted pack cannot inherit a valid-looking digest chain<br>CP02-2: unsupported transformations, case collisions and symlink transports are refused<br>CP02-2: captured inputs, branch collisions and ignored additions cannot bypass verification |

[실행 receipt](../research/clean-git-progress/receipt.json) · [TAP](../research/clean-git-progress/tests.tap) · [RDF](../research/clean-git-progress/trace.jsonld) · [SHACL](../schemas/clean-git-progress/progress.shacl.ttl).

```sh
python3 -B scripts/record-clean-git-progress.py --check
```
