# 함수형 코드에서 USL 쓰기

USL 선언을 TypeScript 값으로 만들고, 함수·Effect와 함께 보관할 수 있다. `usl`은 예약어나 특별한 변수명이 아니다. 아래처럼 원하는 변수 이름으로 쓰고, 명시적으로 지정한 namespace와 link 이름으로 연결을 식별한다.

```ts
import { Either, pipe } from "effect"
import { usl as semantic } from "usl/code"

const specification = semantic.resource("dash_spec", "file://dev-01/game/dash-spec.md")
const implementation = semantic.resource("dash_code", "file://dev-01/game/dash.ts")
const evidence = semantic.resource("dash_test", "file://dev-01/game/dash.test.ts")

const implementsDash = semantic.meaning("implements_dash", {
  roles: { specification: "filesystem", implementation: "filesystem", evidence: "filesystem" },
  description: "구현은 지상 상태에서만 대시를 허용한다",
  contract: {
    scope: "대시 입력의 지상 상태 판정",
    checks: [{ name: "grounded_test", evidenceRoles: ["evidence"],
      description: "공중에서는 거부하고 지상에서는 허용하는 테스트를 확인한다" }],
  },
})

const usl = semantic.link("dash_behavior", implementsDash, {
  specification, implementation, evidence,
})
const dash = semantic.bind((grounded: boolean) => grounded, usl)
const canDash = pipe(true, dash.run)
const plan = Either.getOrThrow(semantic.compile("game.dash", [dash.usl]))
```

이 문서의 `/game/` 주소는 사용 프로젝트의 실제 경로로 바꾼다. [실행 예제](../examples/code-embedded.ts)는 저장소에 있는 대시 함수를 직접 import하고 실제 로컬 fixture를 관측한다.

```sh
npm run example:code
npm run example:engineering
```

`bind`는 `{ run, usl }`를 반환한다. `run`은 원래 함수 또는 값 그 자체이며, 선언을 붙일 때 실행하지 않는다. 제네릭 함수·Effect 값도 그대로 보존한다. 함수에 속성을 쓰거나 `toString()`으로 코드를 식별하지 않는다. 함수와 코드 resource의 대응은 작성자가 선언한 관계이며, 자동 소스 분석으로 입증한 결과가 아니다.

## 선언·오류·조합

- `resource`는 locator 종류를 추론한다. `meaning`의 역할에 다른 종류의 resource를 대입하거나 필수 역할을 빠뜨리면 TypeScript 오류가 난다.
- 선언 생성자는 잘못된 선언에 `LanguageError`를 던진다. 동적 외부 입력에서는 `Effect.try` 등으로 다룬다. `compile`, `compose`, `source`는 `Either`를 반환한다.
- 선언은 즉시 복사·동결된다. `compile`은 link가 참조한 의미·자원을 수집하고 기존 USL compiler로 다시 검사한다.
- 같은 이름의 같은 선언은 공유한다. 같은 이름에 다른 주소·의미가 들어오면 충돌 오류가 난다. `compose(namespace, [planA, planB])`도 같은 규칙이다. 서로 다른 모듈을 합칠 때 이름 공간을 명시적으로 설계한다.

공유 `resource` 선언의 주소를 수정한 뒤 소비 모듈을 다시 평가·컴파일하면 그 값을 참조하는 링크에 반영된다. 이미 만들어진 plan·관측 보고서는 당시 버전을 유지한다. 소스 import 경로, 실행 코드, 외부 시스템의 참조까지 USL이 자동 수정하는 것은 아니다.

## 관측과 AI 맥락

기존 `observeProgram(plan, options)`, `agentContext(plan, query)`, `compactAgentContext(plan, query, budget)`를 그대로 사용한다. 함수의 `.usl`을 모아 만든 plan에도 선택 링크·허용 locator·조회 예산을 적용한다.

`semantic.source(plan)`은 같은 plan으로 재컴파일되는 **생성된 `.usl` 원문**을 돌려준다. 관측할 때 이를 `sourceText`로 전달하면 source digest가 기록된다. 이 digest는 TypeScript 파일의 digest가 아니다. 실제 TS 파일은 implementation resource로 선언해 별도로 관측한다.

USL v2의 plan digest는 JSON 필드 순서도 포함한다. SDK의 `compile`과 `compose`는 parser의 필드 순서에 맞춰 plan을 만든다. 외부에서 조립한 plan의 순서가 다르면 `source`는 조용히 다른 digest를 내보내지 않고 오류를 돌려준다. 이 경우 새 기준을 만들기 전에 `compose(plan.namespace, [plan])`로 정규화한다. 기존 보고서의 plan이나 digest를 덮어쓰지 않는다.

AI에게는 필요한 연결만 선택하고 압축 context를 전달한다. 이전 FULL context를 실제로 보유한 소비자만 `knownContextDigest`로 재전송을 생략한다. 토큰 예산은 사용하는 tokenizer를 `compactAgentContext`에 주입한다. 바이트 감소를 실제 청구 토큰 감소로 해석하지 않는다.

## GraphSpec과 HSWM

1. [GraphSpec adapter](GRAPH_ENGINEERING_INTEGRATION.md)로 노드·근거와 실제 locator를 매핑한다. 반환값의 `.usl`은 일반 `SemanticPlan`이다.
2. `semantic.compose(namespace, [codePlan, graphPlan.usl])`로 코드 선언과 합친다. 원 GraphSpec 원문·version·digest와 binding 자료도 함께 보관한다.
3. 필요한 링크를 관측하고 [HSWM adapter](HSWM_INTEGRATION.md)에 plan·관측·독립적인 caller policy·allowed reads를 전달한다.

`example:engineering`은 검증된 GEIP 예제 원문을 가져와 USL 코드 파일에 예시 바인딩하고, 코드 선언과 합쳐 4개 로컬 자원만 관측한 뒤 HSWM 입력을 준비한다. KG 개념도 탐색 경로에 포함하지만 이 예제의 관측 대상으로 선택하지 않는다. 바인딩은 상호운용 예제이며 해당 파일들이 원 GraphSpec 전체를 실행한다는 주장이 아니다. 연결한 영수증도 문서 검증 기록이며 원 GraphSpec의 실행 영수증으로 취급하지 않는다.

실제 HSWM Python 소비자까지 확인하려면 `npx tsx audit/engineering-integration-smoke.ts /실제/HSWM/경로`를 실행한다. 새로운 `observations/engineering-<시각>/`에 원문·plan·GraphSpec 바인딩·관측·HSWM 입력/결과·소비자 digest를 보관한다. 정상 읽기, 잘못된 pin, 만료, 허용되지 않은 읽기를 함께 확인하며 기존 기록은 보존한다.

개발 검증 진입점은 `npm run typecheck`, `npm test`, `npm run build`다. GEIP의 구조 검증과 HSWM의 읽기 판정은 각 소비자의 계약을 유지한다. 그래프에서 경로를 찾았다는 이유로 검증 명령이나 함수 실행을 자동 시작하지 않는다.

## 다른 로컬 TypeScript 프로젝트에서 가져오기

USL 저장소에서 먼저 `npm run build`를 실행한 뒤, 소비 프로젝트에서 `npm install /실제/USL/경로`로 연결한다. 패키지는 현재 private 로컬 패키지이며 원격 레지스트리에 게시하지 않았다. Node.js 22 이상을 사용한다.

공개 import 경로는 `usl`, `usl/code`, `usl/graph-engineering`, `usl/hswm`이다. 빌드는 ESM JavaScript와 타입 선언을 생성한다. TypeScript 소스 변경 후에는 USL을 다시 빌드한다.
