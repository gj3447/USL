# Lean 4와 USL

2026-09-28 재검증과 새 CLI/resource binding의 미증명 범위는 [Lean 범위 감사](../audit/LEAN_SCOPE_2026-09-28.md)에 정리했다. 실행 상태 모델을 우선하는 후속 계획은 [현재 상태와 다음 작업](CURRENT_STATE_AND_NEXT_STEPS.md)을 참고한다.

Lean 선언·증명과 외부 자원을 연결하는 경로, USL 자체 모델의 형식 검증을 모두 제공한다. 런타임은 TypeScript + Effect이며 Lean은 기존 증명 환경과 형식 검증을 담당한다. 새 DB는 만들지 않는다.

## Lean에서 연결할 선언 내보내기

`lean/Usl/Export.lean`의 `#usl_export`는 Lean 환경에 실제 존재하는 선언의 전체 이름, 종류, pretty-printed 타입, 전이적 공리 의존성, unsafe/partial 여부를 출력한다.

```lean
import Usl

namespace Demo
def canDash (grounded : Bool) := grounded
theorem grounded (g : Bool) : canDash g = true → g = true := by
  intro h
  exact h
end Demo

#usl_export [Demo.canDash, Demo.grounded]
```

저장소 예제:

```sh
lake --dir lean build
npm run example:lean
```

외부 Lake 프로젝트에서는 이 저장소의 `lean` 디렉터리를 로컬 Lake 의존성으로 등록한 뒤 `import Usl`을 사용한다. 프로젝트의 Lean 버전과 맞게 빌드해야 한다. 이 저장소에서 검증한 toolchain은 `lean/lean-toolchain`의 **4.33.1**이다. 기존 4.29/4.32 프로젝트까지 테스트했다고 주장하지 않는다.

## TypeScript와 연결

```ts
import { connectUsl } from "usl/adapters"
import { adaptLean4Export, readLean4Export } from "usl/lean4"

const connection = connectUsl({
  read: () => readLean4Export({ cwd: "/project", file: "Proofs/Export.lean" }),
  adapt: raw => adaptLean4Export(raw, {
    namespace: "project.proofs",
    source: { id: "project:proofs", locator: "file://my-host/project/Proofs/Export.lean" },
    bindings: [{
      declaration: "Demo.grounded", description: "이 정리는 대시의 지상 조건을 형식화한다.",
      resource: { id: "game:dash", types: ["urn:game:Requirement"], locator: "kg://canonical-neo4j/game:dash" },
    }],
  }),
})
```

`readLean4Export`는 호스트가 지정한 `lake env lean --json FILE`을 실행한다. 쉘 문자열은 사용하지 않는다. 성공 종료, 정확히 한 개의 export, 입력 크기·출력 크기·시간 한도를 검사하고, 실행 전후 export 파일 내용이 같아야 결과를 반환한다. 같은 파일 안에서 export 이후 오류가 발생해도 결과를 거부한다. `check.sourceDigest`는 export 파일의 원문을 pin한다.

`adaptLean4Export` 자체는 순수 함수다. 이미 만들어진 export JSON을 읽을 수도 있다. 이 경우 실행 기록이 없는 보고를 검증된 실행으로 표시하지 않는다. 선언은 `leanDeclarationId(sourceId, fullName)`로 식별하고 원래 명제와 공리 목록을 metadata로 보존한다. locator는 export 소스의 증거 위치이지 일반 파일 resolver가 Lean 심볼을 해석한다는 주장이 아니다.

`lean4ResourceGraph`로 공통 자원 문법을 얻어 JSON-LD나 기존 MCP 파일 연결에 넘길 수 있다. 호스트가 명시적으로 구성한 MCP callback에서는 `connection.snapshot(undefined)`를 호출해 새 Lean 응답을 연결할 수 있다. 일반 MCP 클라이언트에는 실행 명령을 노출하지 않는다.

## 증명 결과의 해석

`#usl_export`는 `Lean.collectAxioms`를 사용한다. `sorryAx`가 직접·간접 의존성에 있으면 `USES_SORRY`로 보존한다. 사용자 정의 공리도 지우지 않는다. Lean 공식 문서의 [공리 의존성](https://lean-lang.org/doc/reference/latest/Axioms/)과 [증명 검증 범위](https://lean-lang.org/doc/reference/latest/ValidatingProofs/)를 따른다.

정리와 KG 개념·코드 사이의 `formalizes` 연결은 작성자의 대응 주장이다. Lean이 명제를 받아들였다는 사실과 실제 코드가 그 명제에 대응한다는 사실은 다르다. `observe`의 `semanticTruth`는 계속 `NOT_EVALUATED`다.

이 실행은 신뢰한 호스트의 Lean/Lake 코드이며 sandbox가 아니다. import한 모듈과 `.olean`, 플러그인·toolchain을 포함한 전체 의존성 pin은 프로젝트 소유자가 관리한다. export 파일 digest 하나로 전체 증명 환경의 재현성·무결성을 인증하지 않는다. pretty-printed 타입 문자열의 digest는 Lean의 definitional equality 판정이 아니다.

## 형식 검증 범위

역할 이름을 가진 하이퍼그래프를 형식화하고 **37개 정리**를 Lean 4.33.1로 검증한다. [Core.lean](../lean/Usl/Core.lean)은 기본 모델과 10개 정리, [Verification.lean](../lean/Usl/Verification.lean)은 경로·선택·읽기 예산에 관한 20개 정리, [Contracts.lean](../lean/Usl/Contracts.lean)은 구조 검사와 역할 방향에 관한 7개 정리를 담는다.

| 정리 | 보장 |
|---|---|
| `adjacent_symmetric` | 같은 링크의 참여자 사이를 역방향으로 탐색 가능 |
| `reachable_transitive` | 경로 합성 |
| `reachable_symmetric` | 역할 경로 제한이 없는 구조적 경로의 역방향 |
| `selected_link_original` | 선택한 링크는 원래 링크 그대로이며 참여자·역할을 보존 |
| `selection_preserves_wellformed` | 유효한 그래프의 링크를 선택해도 참조 무결성 유지 |
| `selected_read_allowed` | 선택한 읽기는 독립 허용 범위 안에 있음 |
| `deny_all` | 빈 허용 범위에서는 읽기 없음 |
| `narrower_reads` | 허용 범위 축소가 읽기를 확대하지 않음 |
| `reachableWithin_reflexive` | 시작 자원 자신은 홉 수와 무관하게 도달 |
| `reachableWithin_sound` | 실행 가능한 유한 홉 탐색의 성공에는 실제 경로 증거가 있음 |
| `reachableWithin_correct` | 탐색 성공 **↔ 해당 홉 예산 안에 경로 존재**, 모든 그래프·자원·자연수 예산에 대해 성립 |
| `reachableWithin_complete`, `reachable_iff_exists_budget` | 유한 경로가 있으면 충분한 홉 예산에서 반드시 찾음 |
| `PathWithin.mono/trans/symm`, `reachableWithin_monotone/symmetric/composition` | 예산 증가 시 도달성 유지, 경로 합성 시 예산 합산, 무방향 경로의 같은 예산 역방향 탐색 |
| `reachableWithin_false_iff` | 실패는 해당 홉 예산 안에 경로가 없다는 뜻이며 더 긴 경로를 배제하지 않음 |
| `reachableWithin_stays_in_graph` | 참조가 유효한 그래프의 선언된 자원에서 출발하면 도착 자원도 선언되어 있음 |
| `selected_link_iff`, `selectLinks_idempotent/commute` | 링크 ID 선택의 정확성, 반복 선택의 안정성, 선택 순서 독립성 |
| `selectReads_exact/idempotent/commute` | 읽기는 요청과 허용 범위의 교집합이며 반복·순서에 대해 안정적 |
| `admitted_read_exact`, `admitted_reads_budget`, `oversized_reads_rejected` | 중복 제거한 요청 수를 먼저 검사하고, 승인 결과는 요청·권한 안에 있으며 예산 이하; 초과 요청은 거부 |
| `validateGraph_correct` | 실행 가능한 구조 검사 성공 ↔ 모델의 구조 조건 만족 |
| `validGraph_wellformed`, `selection_preserves_validGraph/validation` | 구조 검사는 참조 무결성을 함의하며 링크 선택 후에도 유효성 유지 |
| `routedStep_correct`, `routedStep_original`, `no_routes_no_step` | 지정한 의미·진입 역할·이탈 역할에 맞는 원래 참여자 사이에서만 한 단계 이동; 빈 역할 정책은 이동을 허용하지 않음 |

핵심 명제는 다음처럼 **실행 함수와 경로 명세의 동치**로 작성되어 있다. 유한한 예시만 열거한 정리가 아니다.

```lean
theorem reachableWithin_correct {graph : Graph} {start target : String} {hops : Nat} :
    reachableWithin graph start target hops = true ↔ PathWithin graph hops start target
```

`GraphValid`는 비어 있지 않은 자원 목록, 고유 자원·링크 ID, 비어 있지 않은 참여자 목록, 링크 내 고유 역할, 선언된 자원 참조를 검사한다. 문자열 문법, 의미 선언 목록, locator 파싱, metadata, 출처 참조와 descriptor ID 충돌은 이 모델 밖이다. `RoutedAdjacent`는 원래 링크와 참여자 및 일치하는 정책의 존재 증거를 요구한다. 방향을 지정한 역할 탐색에는 무방향 경로의 대칭성 정리를 적용하지 않는다.

```sh
npm run test:lean
```

위 명령은 라이브러리를 빌드하고 [ProofAudit.lean](../lean/Examples/ProofAudit.lean)의 전체 37개 정리를 export한다. 각 선언이 정리이고 unsafe/partial이 아니며 전이적 공리 의존성이 `propext`, `Classical.choice`, `Quot.sound` 안에만 있는지 검사한다. `sorryAx` 및 사용자 정의 공리 의존성은 실패 처리한다. 선언 목록 누락도 검사한다. 일반 export 기능 자체는 외부 선언의 사용자 공리를 지우지 않는다.

[Conformance.lean](../lean/Examples/Conformance.lean)의 실행 결과를 실제 TS 구현과 다음 **383건** 대조하고 별도로 읽기 허용 목록의 기본 예시를 검사한다.

- 100개 경로: 순환, 고립 자원, 다자 관계, 0–3 홉.
- 80개 역할 이동: 서로 다른 출발·도착 자원 20쌍 × 빈 정책·정방향·역방향·양방향 정책. 발견된 TS 경로의 의미와 진입·이탈 역할도 검사한다.
- 192개 읽기 예산: 허용 목록 32조합 × 예산 0–5. 초과 요청은 resolver 호출 전에 실패하고, 승인 시 실제 호출 자원이 모델과 일치한다.
- 11개 구조 검사: 정상·빈 자원 목록·중복 ID·빈 참여자·중복 역할·미선언 자원·링크 선택·단항 링크·여러 역할에 같은 자원·빈 링크 목록.

실제 Lean 실행의 간접 `sorry`, export 이후 오류, 중복 export, 실행 제한도 검사한다. 홉 예산 초과와 전역 비도달성의 차이, 역할 탐색의 비대칭성, 도달성이 읽기 권한을 부여하지 않는다는 세 경계 예시도 Lean에서 검사한다. [검증 기록](../audit/LEAN_PROOFS_2026-09-14.md)을 참고한다.

37개 정리는 **Lean 모델에 대한 증명**이다. TypeScript의 parser·compiler·해시·BFS 전체 구현, locator 정규화, 외부 resolver, 사용자 의미 대응은 형식 증명하지 않았다. 모델의 일반 탐색은 홉 예산만 다루며 TS의 자원·링크·방문 예산과 최대 32홉 제한까지 완전성을 주장하지 않는다. 역할 정책의 증명은 한 단계 이동에 관한 것이다. TS와 모델의 연결은 현재 유한한 대조 테스트이며 전 프로그램 refinement proof로 표기하지 않는다.
