# Lean 범위 감사 — 2026-09-28

## 실행 확인

2026-09-28에 현재 작업 트리에서 `npm run test:lean`을 실행했다. `lake build`는 7개 작업으로 성공했고, `test/lean4.integration.ts`의 4개 테스트가 모두 통과했다.

| 검사 | 결과 |
| --- | --- |
| Lean toolchain | `leanprover/lean4:v4.33.1` |
| 공개 모델 정리 audit | 37 / 37 통과 |
| TypeScript 대조 | 383건: 경로 100, 역할 route 80, 읽기 예산 192, 구조 11 |
| 추가 Lean 경계 예시 | 3건: 홉 한도, 방향성, 도달성과 읽기 권한 분리 |
| 전체 `test:lean` 시간 | 14.13초 |

`lean/Examples/ProofAudit.lean`은 아래 37개 이름을 명시적으로 export한다. 통합 테스트는 `Core.lean`, `Verification.lean`, `Contracts.lean`의 `theorem` 선언 수도 37개인지 확인하고, 각 export가 theorem이며 `unsafe`/`partial`이 아니고 전이 공리 의존성이 허용 목록 안에 있는지 검사한다.

| Lean 소스 | 정리 수 | 증명 대상 |
| --- | ---: | --- |
| `lean/Usl/Core.lean` | 10 | 하이퍼그래프 인접성·도달성, 링크 선택, 허용 읽기, 유한 홉 탐색의 soundness |
| `lean/Usl/Verification.lean` | 20 | `reachableWithin`과 `PathWithin` 동치, 예산 단조성·합성·완전성, 선택/읽기 admission의 성질 |
| `lean/Usl/Contracts.lean` | 7 | graph 구조 검사, 선택 후 구조 보존, 한 단계 역할 route 정책 |

정리 목록은 `adjacent_symmetric`, `reachable_transitive`, `reachable_symmetric`, `selected_link_original`, `selection_preserves_wellformed`, `selected_read_allowed`, `deny_all`, `narrower_reads`, `reachableWithin_reflexive`, `reachableWithin_sound`, `reachableWithin_correct`, `PathWithin.mono`, `PathWithin.trans`, `PathWithin.symm`, `reachableWithin_monotone`, `reachableWithin_symmetric`, `reachableWithin_composition`, `reachableWithin_complete`, `reachable_iff_exists_budget`, `reachableWithin_false_iff`, `reachableWithin_stays_in_graph`, `selected_link_iff`, `selectLinks_idempotent`, `selectLinks_commute`, `selectReads_exact`, `selectReads_idempotent`, `selectReads_commute`, `admitted_read_exact`, `admitted_reads_budget`, `oversized_reads_rejected`, `validateGraph_correct`, `validGraph_wellformed`, `selection_preserves_validGraph`, `selection_preserves_validation`, `routedStep_correct`, `routedStep_original`, `no_routes_no_step`다.

## 공리와 `sorry` 감사

현재 Lean 모델 소스(`Core.lean`, `Verification.lean`, `Contracts.lean`)와 `ProofAudit.lean`에는 `sorry`, `admit`, 사용자 정의 `axiom` 선언이 없다. export는 `Lean.collectAxioms`로 전이 의존성을 얻는다. 37개 공개 정리에 허용한 기반 의존성은 `propext`, `Classical.choice`, `Quot.sound`뿐이다.

통합 테스트는 `sorryAx`와 위 목록 밖의 사용자 정의 공리를 실패로 처리한다. 별도 음성 테스트도 직접 또는 간접 `sorryAx`, export 뒤 컴파일 오류, 중복 export를 성공 결과로 만들 수 없음을 확인한다.

이는 Lean kernel이 이 세 기반 공리를 전제로 37개 **Lean 모델 정리**를 받아들였다는 뜻이다. 외부 요구사항, 코드, KG 자원 또는 CLI 실행 효과의 참을 증명하는 결과는 아니다.

## 검증 등급의 남은 층

[Lean 공식 검증 지침](https://lean-lang.org/doc/reference/latest/ValidatingProofs/)은 `lake build`와 공리 출력 다음 단계로, 생성된 `.olean`을 kernel로 재생하는 `lean4checker --fresh`를 CI에서 실행할 것을 권장한다. 더 높은 위험 모델에서는 trusted challenge와 sandbox를 사용하는 `lake comparator` 및 외부 checker를 추가 단계로 둔다.

이번 감사에서 실행한 것은 `lake build`, 37개 export의 전이 공리 audit, TypeScript conformance뿐이다. `lean4checker --fresh`, `lake comparator`, 외부 checker는 모두 **NOT_RUN**이다. 따라서 현재 상태는 37개 정리에 대한 audited kernel-scope 결과이며, 독립 checker 또는 malicious-proof 방어 등급을 주장하지 않는다.

## TypeScript 연결의 실제 범위

`test/lean4.integration.ts`는 `Examples/Conformance.lean`이 출력한 유한 fixture를 TypeScript 구현과 비교한다. 비교 대상은 `src/integrations/resource-graph.ts`, `src/language/navigation.ts`, `src/language/runtime.ts`의 일부 관찰 가능한 결과다. 383개 케이스는 모델과 해당 fixture에서의 동작 일치를 확인한다.

이 연결은 refinement proof가 아니다. 특히 TypeScript parser/compiler, JSON hash, locator 정규화와 외부 resolver의 전체 구현, TypeScript BFS의 resource/link/visit 예산과 최대 32홉, GraphSpec lifecycle/effect/entry-node gate, HSWM authority, capability catalog policy/source pin, MCP transport는 형식적으로 연결되어 있지 않다.

`src/integrations/lean4.ts`는 호스트가 지정한 Lean export를 읽고 공리 목록을 보존하는 adapter다. Lean export 파일 전후의 내용 일치와 subprocess 성공은 검사하지만, import된 `.olean`, Lake plugin, toolchain 전체를 pin하거나 sandbox하지 않는다.

## 이번 CLI/resource binding 추가분

현재 `lean/`과 `test/lean4.integration.ts`에는 `src/resource-bindings.ts`, `src/cli-host.ts`, `src/cli-host-command.ts`, `src/cli-process.ts`를 모델링하거나 대조하는 참조가 없다. workspace realpath/symlink 경계, representation 선택, source/executable digest pin, fsync intent/result receipt, no-start 취소, timeout·SIGTERM/SIGKILL, stdout/stderr 합산 한도도 Lean 증명 범위 밖이다.

따라서 이 기능의 테스트 통과나 Lean 37개 정리 통과를 CLI activation, 실행 효과의 exactly-once, 영수증 내구성, process-tree 종료의 형식 증명으로 해석하면 안 된다. 이 런타임은 현재 TypeScript 경계 테스트와 trusted-host 운영 가정으로만 검증된다. `DECLARED_FILES_ONLY` 보장도 동적 import와 host TOCTOU를 포괄하지 않는 선언 범위다.

## 다음 형식화 우선순위

1. **Attempt 상태 기계**: `PLANNED → INTENT_DURABLE → STARTED → SUCCEEDED | INDETERMINATE`와 `CANCELLED_BEFORE_START`를 모델링한다. intent digest/result linkage와 자동 재시도 금지를 명제로 둔다.
2. **Pin 검사 순서**: host config, bindings, GraphSpec, declared source, executable hash를 준비·intent 저장·재준비·spawn 전 검사하는 순서를 모델링한다. 일치하지 않으면 `started = false`와 `attempts = 0`임을 증명한다.
3. **GraphSpec entry 제약**: entry-node membership, edge endpoint 유효성, incoming edge 거부를 현재 전체 workflow `NOT_EXECUTED` 표기와 연결한다. lifecycle/effect runtime의 완전한 증명은 별도 범위로 둔다.
4. **프로세스 결과 추상화**: timeout, output-limit, abort, nonzero, invalid UTF-8을 `INDETERMINATE`로 분류하고 성공에는 exit 0·유효 JSON·output schema가 필요함을 모델링한다. OS process-group kill의 실제 보장은 Lean 모델 밖의 host 가정으로 명시한다.
5. **TypeScript refinement 범위 확대**: 위 작은 상태 모델에 대한 generated trace를 만들어 CLI host 테스트와 대조한다. 전체 Node filesystem/process 의미론의 증명이나 악의적 same-host TOCTOU 제거를 먼저 주장하지 않는다.

이 순서는 현재 구현의 신뢰 경계를 먼저 명확히 하며, 기존 graph 탐색 정리를 runtime 실행 보장으로 과도하게 확장하지 않는다.
