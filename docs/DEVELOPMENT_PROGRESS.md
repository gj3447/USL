# USL 개발 진행

[원래 개발 계획](DEVELOPMENT_PLAN.md)은 당시의 PLANNED/NOT_RUN 스냅샷으로 보존한다. 이 문서는 별도 실행 기록으로 구현 진행을 나타낸다.

기록 2026-10-05T13:57:51.243311+00:00; 소스 `f6a684c396dacd4a43eedff6707bf69c64b66937`.

실제 로컬 검사 **83개 PASS**, 실패/건너뜀 0. 실행 환경: Linux / v24.20.0 / git version 2.47.3.

## DG01 · 선택형 checkout guard

상태: **IMPLEMENTED_LOCAL_SCOPE / LOCAL_CASES_PASS**. owner가 지정한 바인딩·checkout·HEAD·dirty 조건을 검사하고 prepare 이후 변경을 재검사한다. owner 코드가 guard를 명시적으로 호출한다.

[사용법과 한계](CHECKOUT_GUARD.md). 원자적 snapshot·모든 OS·실제 기기 간 이동의 검증은 아니다.

| 계획 완료 조건 | 확인 범위 | 실행한 검사 |
|---|---|---|
| criterion:DG01-C1 | LOCAL_CASES_PASS | DG01-C1: equal bytes with a different HEAD or owner checkout identity hold<br>DG01-C1: an explicit Git worktree move and owner remap retain the selected logical binding<br>DG01-C1: a selected content pin reports exact MATCH then MISMATCH |
| criterion:DG01-C2 | LOCAL_CASES_PASS | DG01-C2: dirty, detached, sparse, subdirectory and broken-gitfile states are held by policy<br>DG01-C2: an owner may explicitly allow a dirty checkout and an unborn checkout is distinguished<br>DG01-C2: a nested submodule is held unless a future profile closes its scope<br>DG01-C2: malformed sparse configuration and unborn index changes fail closed<br>DG01-C2: FIFO, untracked nested repository and symlink inputs fail closed without traversal<br>DG01-C2: configured Git clean filters hold before a selected-file observation can invoke them |
| criterion:DG01-C3 | LOCAL_CASES_PASS | DG01-C3: a prepared guard holds after HEAD, index or runner changes and a caller action stays at zero<br>DG01-C3: a prepared guard is process-local, an initial HOLD cannot become PASS, and a remap is stale<br>DG01-C3: policies and hosts are snapshotted, reject accessors, and bounded untracked capture fails closed |

## PT02 · 고정 파일 집합 내보내기

상태: **IMPLEMENTED_LOCAL_SCOPE / LOCAL_CASES_PASS**. 명시적으로 선택한 파일의 독립적인 해시·크기·의존성 pin을 확인하고 새 번들을 만든다. 원본 owner ID와 상대 복원 경로를 보존한다.

[사용법과 한계](PORTABLE_TRANSFER_EXPORT.md). CLI의 PINNED_BYTE_SET은 원자적 파일시스템 snapshot이 아니다. Git object/ref/index·submodule·LFS·alternates의 자동 수집과 실제 복원은 구현하지 않는다. Git 복구는 외부 의존성으로 남는다.

| 계획 완료 조건 | 확인 범위 | 실행한 검사 |
|---|---|---|
| criterion:PT02-C1 | LOCAL_CASES_PASS | PT02-C1: records independent SHA-256 and length for the bytes actually published<br>PT02-C1: unique staged publication never overwrites an existing export<br>PT02-C1: an owner snapshot mismatch before or after copying aborts and cleans up the bundle<br>PT02-C1: snapshots mutable request fields before awaiting the owner<br>PT02-C1: accessor-backed requests are refused before their values can vary across awaits<br>PT02-C1: duration budget expires before any complete bundle is published<br>PT02-C1: PINNED_BYTE_SET accepts an optional host assertion but never relabels itself as OWNER_FROZEN<br>PT02-C1: any staged-payload tamper or extra staged entry after the final owner assertion aborts publication<br>PT02-C1: time spent in the final owner assertion counts against the export duration |
| criterion:PT02-C2 | LOCAL_CASES_PASS | PT02-C2: required dependencies are self-contained only when represented by packaged payload<br>PT02-C2: a legacy caller-supplied verified flag cannot turn a dependency into a complete export<br>PT02-C2: dependency closure inputs are bounded and nested package evidence is captured before the owner await<br>PT02-C2: rejects path escapes, special files, duplicate IDs, case collisions, excess entries, and byte budgets<br>PT02-C2: restore paths preserve Unicode only when their NFC and case-folded forms are unambiguous<br>PT02-C2: a Git worktree restore profile is explicitly external without a Git closure adapter<br>PT02-C2: dependency class and required semantics cannot be forged with JSON lookalikes<br>PT02-C2: restore paths reject Windows-reserved, colon/control, and file-directory ambiguities |
| criterion:PT02-C3 | LOCAL_CASES_PASS | PT02-C3: unknown nested file fields cannot become inventory or restore metadata<br>PT02-C3: packages policy and dictionary pins without host registration or machine-local secret paths<br>PT02-C3: the standalone CLI accepts only a bounded PINNED_BYTE_SET spec and exposes help<br>PT02-C3: CLI refuses a FIFO spec promptly instead of reading an unbounded stream |
| criterion:PT02-C4 | LOCAL_CASES_PASS | PT02-C4: unsupported Git closure remains explicitly external and no arbitrary host program runs<br>PT02-C4: a PINNED_BYTE_SET Git-worktree closure digest is computed over exactly one normalized Git closure |

## PT03 · 검증 후 file profile 복원

상태: **IMPLEMENTED_FILE_PROFILE_GIT_PENDING / LOCAL_CASES_PASS**. 새 root에서 pinned files와 bindings를 복원한다.

[사용법과 한계](PORTABLE_TRANSFER_IMPORT.md). PT03-C5는 REJECTION_ONLY_GIT_RESTORE_PENDING이다.

| 계획 완료 조건 | 확인 범위 | 실행한 검사 |
|---|---|---|
| criterion:PT03-C1 | LOCAL_CASES_PASS | PT03-C1: verified restore rebinds only selected locators and preserves graph identities and ordered roles without the original source<br>PT03-C1: rebinding rejects forged handles, changed restored bytes and mismatched explicit identities<br>PT03-C1: rebinding captures mutable selections and refuses implicit remapping of unselected workspaces<br>PT03-C1: verifies a real PT02 bundle before rebinding exact IDs at a different root |
| criterion:PT03-C2 | LOCAL_CASES_PASS | PT03-C2: rejects receipt-pinned metadata and payload attacks without publishing a workspace<br>PT03-C2: refuses extra entries, symlinks, FIFOs, and does not overwrite an incomplete reservation<br>PT03-C2: rechecks an existing same-digest result and only one concurrent reservation publishes<br>PT03-C2: authenticated malformed dependency and inventory metadata cannot change the restore closure<br>PT03-C2: authenticated policy/schema substitutions and duplicate representations are rejected semantically<br>PT03-C2: receipt-repinned case-folded restore paths cannot publish on a case-sensitive host<br>PT03-C2: authenticated non-exportable registration and credential paths cannot reserve a destination<br>PT03-C2: authenticated metadata outside the exporter bounds cannot reserve a destination |
| criterion:PT03-C3 | LOCAL_CASES_PASS | PT03-C3: historical snapshots cannot be implicitly rebound as working copies; explicit local branches retain their original revisions<br>PT03-C3: preserves unknown, diverged, and withdrawn history without automatic activation or merge<br>PT03-C3: owner-state duplicate keys are rejected and __proto__ remains an ordinary withdrawn native ID |
| criterion:PT03-C4 | LOCAL_CASES_PASS | PT03-C4: only an immutable in-process result can be rechecked; marker and workspace replacement are detected<br>PT03-C4: rejects unsupported Git closure and keeps operations as historical data<br>PT03-C4: CLI accepts help but rejects bad arguments and a FIFO spec promptly |
| criterion:PT03-C5 | REJECTION_ONLY_GIT_RESTORE_PENDING | PT03-C5: rejects conflicting owner registry definitions without truncating native IDs |

## PT04 · 로컬 transport 인수검사

상태: **LOCAL_ACCEPTANCE_AND_CI_MATRIX / LOCAL_CASES_PASS**. 별도 producer/consumer와 measurement CLI를 Linux에서 실행한다.

[사용법과 한계](PORTABLE_TRANSFER_IMPORT.md). macOS/Windows는 NOT_RUN이며 CI matrix는 실행 증거가 아니다.

| 계획 완료 조건 | 확인 범위 | 실행한 검사 |
|---|---|---|
| criterion:PT04-C1 | LINUX_LOCAL_ONLY | PT04-C1: a copied self-contained bundle restores without source, cache, or original bundle<br>PT04-C1: owned transport fixtures resolve temporary-directory aliases before strict filesystem checks |
| criterion:PT04-C2 | LOCAL_CASES_PASS | PT04-C2: missing required dependencies and a one-byte payload change never publish a restored workspace<br>PT04-C2: a budget-interrupted import leaves no completion marker and does not retry effects |
| criterion:PT04-C3 | LINUX_MEASURED_OTHER_PLATFORMS_NOT_RUN | PT04-C3: a separate producer and cache-free consumer report exact transport metrics |

## 실제 로컬 이동 관측

서로 다른 임시 root에서 producer → bundle 복사 → 원본 bundle 삭제 → consumer·재바인딩을 실행했다. producer가 원본 파일도 삭제한다. 별도 새 프로세스·목적지에서 import와 후속 해시를 측정했다. 작은 고정 fixture의 관측으로, 실제 두 기기나 OS 간 성능을 대표하지 않는다.

| 관측 | 값 |
|---|---|
| payload bytes / 파일 수 | 22 / 2 |
| import·재바인딩 시간 | 49.831 ms |
| 별도 import / 후속 해시 시간 | 37.139 / 0.480 ms |
| 별도 측정 프로세스 peak RSS | 80108 KiB |
| Linux / macOS / Windows | LOCAL_PASS / NOT_RUN / NOT_RUN |

[실제 consumer·측정 출력](../research/development-progress/acceptance.json). OS 전달 CI는 작성되었으며 이 기록에서 원격 실행하지 않았다.

다음 보완 대상은 **PT03-C5 Git 복원** 및 PT04의 macOS/Windows 실제 인수검사다. 실행·owner 권한은 이 기록으로 부여되지 않는다.

[실행 receipt](../research/development-progress/receipt.json) · [TAP 원문](../research/development-progress/tests.tap) · [typed RDF](../research/development-progress/trace.jsonld) · [SHACL](../schemas/development-progress/progress.shacl.ttl). 실행 당시 source pin과 현재 bytes를 함께 검사하므로 구현 변경 후에는 실제 검사를 다시 실행해야 한다.

```sh
python3 scripts/record-development-progress.py --record
python3 scripts/record-development-progress.py --check
```
