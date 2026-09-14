# Lean 4와 USL

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

`lean/Usl/Core.lean`에는 역할 이름을 가진 하이퍼그래프와 선택·탐색 모델이 있다.

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

```sh
npm run test:lean
```

Lean 모델의 100개 경로(순환, 고립 자원, 다자 관계, 0–3 홉)와 읽기 범위 선택을 실제 TS runtime에 대조한다. 실제 Lean 실행의 정상 정리, 간접 `sorry`, export 이후 오류, 중복 export도 검사한다.

10개 정리는 **Lean 모델에 대한 증명**이다. TypeScript의 parser·compiler·해시·전체 탐색 구현, 모든 예산 조합, 외부 resolver, 사용자 의미 대응을 형식 증명하지 않았다. TS와 모델의 연결은 현재 유한한 대조 테스트이며 전 프로그램 refinement proof로 표기하지 않는다.
