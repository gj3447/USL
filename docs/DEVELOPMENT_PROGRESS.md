# USL 개발 진행

[원래 개발 계획](DEVELOPMENT_PLAN.md)은 당시의 PLANNED/NOT_RUN 스냅샷으로 보존한다. 이 문서는 별도 실행 기록으로 구현 진행을 나타낸다.

## DG01 · 선택형 checkout guard

상태: **IMPLEMENTED_LOCAL_SCOPE / LOCAL_CASES_PASS**. 기록 2026-10-04T00:01:16.254194+00:00; 소스 `4d9a175b994f847624f19ddb2cbc764f856130e1`.

[사용법과 한계](CHECKOUT_GUARD.md). owner가 지정한 바인딩·checkout·HEAD·dirty 조건을 검사하고 prepare 이후 변경을 재검사한다. 기본 inspect와 CLI 실행은 기존 동작을 유지하며 owner 코드가 guard를 명시적으로 호출한다.

실제 로컬 검사 **36개 PASS**, 실패/건너뜀 0. 실행 환경: Linux / v24.20.0 / git version 2.47.3.

| 계획 완료 조건 | 실행한 검사 |
|---|---|
| criterion:DG01-C1 | DG01-C1: equal bytes with a different HEAD or owner checkout identity hold<br>DG01-C1: an explicit Git worktree move and owner remap retain the selected logical binding<br>DG01-C1: a selected content pin reports exact MATCH then MISMATCH |
| criterion:DG01-C2 | DG01-C2: dirty, detached, sparse, subdirectory and broken-gitfile states are held by policy<br>DG01-C2: an owner may explicitly allow a dirty checkout and an unborn checkout is distinguished<br>DG01-C2: a nested submodule is held unless a future profile closes its scope<br>DG01-C2: malformed sparse configuration and unborn index changes fail closed<br>DG01-C2: FIFO, untracked nested repository and symlink inputs fail closed without traversal<br>DG01-C2: configured Git clean filters hold before a selected-file observation can invoke them |
| criterion:DG01-C3 | DG01-C3: a prepared guard holds after HEAD, index or runner changes and a caller action stays at zero<br>DG01-C3: a prepared guard is process-local, an initial HOLD cannot become PASS, and a remap is stale<br>DG01-C3: policies and hosts are snapshotted, reject accessors, and bounded untracked capture fails closed |

이 기록은 선택한 로컬 fixture의 검증이다. 원자적 snapshot·모든 OS·실제 기기 간 이동·backup/restore 완료를 주장하지 않는다. 다음 순차 구현 대상은 **PT02: 실제 snapshot/export**다.

[실행 receipt](../research/development-progress/receipt.json) · [TAP 원문](../research/development-progress/tests.tap) · [typed RDF](../research/development-progress/trace.jsonld) · [SHACL](../schemas/development-progress/progress.shacl.ttl). 실행 당시 source pin과 현재 bytes를 함께 검사하므로 구현 변경 후에는 실제 검사를 다시 실행해야 한다.

```sh
python3 scripts/record-development-progress.py --record
python3 scripts/record-development-progress.py --check
```
