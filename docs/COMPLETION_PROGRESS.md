# USL 완료 계획의 실행 진행

[완료 계획](COMPLETION_PLAN.md)은 원래 PLANNED/NOT_RUN snapshot으로 유지하고 실행 관측을 여기에 연결한다.

## CP01 · clean Git 계약과 export

상태: **CLEAN_EXPORT_LOCAL_SCOPE**. 독립 pin으로 선택한 refs/HEAD의 Git objects를 export하고 비어 있는 저장소에서 prerequisites 없는 bundle을 검증한다.

소스 `d653789ef80a3c4cdf756b88532598f836bb5738`; 기록 2026-10-05T13:20:31.820299+00:00. Linux / v24.20.0 / git version 2.47.3에서 **15개 PASS**, 실패·건너뜀 0.

[사용법과 정확한 범위](PORTABLE_TRANSFER_GIT.md). dirty/index/untracked·submodule/LFS/alternates·원자 snapshot·타 OS·실기기 복구는 이 결과로 완료 처리하지 않는다.

다음은 **CP02: clean Git·여러 worktree 복원과 재바인딩**이다. Native Git로 source 없는 bundle을 검증하는 테스트는 USL importer나 링크 재바인딩 구현 완료가 아니다.

| 인수 조건 | 실행한 검사 |
|---|---|
| CP01-1 · LOCAL_EXPORT_CASES_PASS | CP01-1: SHA-256 repositories export verifiable objects without the source<br>CP01-1: input pins are captured before awaits and manifest contradictions are rejected<br>CP01-1: uncompressed and duration budgets abort without publishing or editing the source<br>CP01-1: standalone CLI exports an explicitly pinned clean repository<br>CP01-1: exports a clean detached linked worktree as a native self-contained bundle without source paths<br>CP01-1: rejects independently pinned HEAD/ref/object-format disagreement before publishing<br>CP01-1: rejects shallow and alternates repositories rather than borrowing an original object store<br>CP01-1: refuses symlink roots, malformed refs, accessors, and tiny budgets without publication |
| CP01-2 · LOCAL_EXPORT_CASES_PASS | CP01-2: source changes after staging starts abort publication and preserve the source<br>CP01-2: ancestor symlinks, hidden dirty index flags, and promisor markers fail closed<br>CP01-2: an unconfigured LFS pointer anywhere in selected history rejects incomplete content<br>CP01-2: Git export CLI refuses invalid flags, special files, and spec destinations<br>CP01-2: rejects dirty index, worktree, and untracked states without changing the source<br>CP01-2: rejects unsupported repository closure forms without executing configured filters<br>CP01-2: rejects unborn and LFS/filter worktrees before publication or filter execution |

[실행 receipt](../research/clean-git-progress/receipt.json) · [TAP](../research/clean-git-progress/tests.tap) · [RDF](../research/clean-git-progress/trace.jsonld) · [SHACL](../schemas/clean-git-progress/progress.shacl.ttl).

```sh
python3 -B scripts/record-clean-git-progress.py --check
```
