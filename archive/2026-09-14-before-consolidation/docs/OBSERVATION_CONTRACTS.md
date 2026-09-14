# 의미 버전을 식별하는 관측과 변경 비교

2026-09-08 · HSWM 피드백을 반영한 USL 구현 설계. 기존 언어 문법은 유지하며 `applies`/`check`를 선택적으로 추가한다. 관측 출력은 `usl-program-observation/v2`다.

## 어떤 의미를 관측했는가

보고서에는 다음 식별자를 보존한다.

| 필드 | 해시 대상 |
| --- | --- |
| `planDigest` | 선택 범위로 잘라내기 전 원본 `SemanticPlan` 전체 |
| `meaningsDigest` | 원본 plan의 의미 정의 배열 전체 |
| `meanings[].digest`, `links[].meaningDigest` | 해당 의미 정의 전체: 설명, 역할 타입, 적용 범위, 검사 절차, KG grounding 주소 |
| `links[].contractDigest` | 의미 이름, 설명, 역할 타입, 적용 범위, 검사 절차. grounding 주소·참여 자원 바인딩은 주소 비교에서 다룬다. |
| `sourceDigest` | 원본 `.usl`의 정확한 UTF-8 내용. API에서 `sourceText`를 생략하면 `null`; CLI는 항상 제공한다. |
| `observationDigest` | 이 필드 자체를 제외한 관측 보고서 전체 |

plan·의미·보고서 해시는 `JSON.stringify` 출력의 UTF-8 SHA-256이며 `sha256:<hex>`로 표시한다. 정렬이나 의미 동치 추론을 하지 않으므로 선언 순서도 plan identity에 반영된다. 원문 공백·주석만 바뀌면 source digest만 바뀔 수 있다. `sourceText`를 제공하면 실제로 주어진 plan으로 컴파일되는지 IO 전에 확인한다. 관측 시작 시 plan을 복제하고 `sourceText` 값을 고정하여 호출자가 IO 도중 plan이나 옵션을 수정해도 보고서가 다른 버전을 섞지 않는다. `agentContext`와 관측은 같은 plan digest 함수를 쓴다.

선택된 의미의 전체 `definition`도 보고서에 넣는다. 엔드포인트 해시가 모두 같더라도 설명을 반대로 바꾸면 원본 plan·의미 digest가 달라지고 비교의 `semanticContractChanged`가 참이 된다. digest는 식별·손상 검출 수단이며 작성자 서명이나 사실성 증명이 아니다.

## 적용 조건과 검사 근거

```usl
meaning implements(spec: filesystem, code: filesystem, evidence: filesystem)
  = "구현이 지상 대시와 0.35초 쿨다운 명세를 따른다"
  applies "싱글플레이어의 플레이어 대시 기능"
  check dash_test(evidence) = "공중 대시 거부와 쿨다운 경계값 검사를 확인한다";
```

`check` 괄호는 그 의미에 선언된 역할 이름이다. 링크의 참여자를 통해 실제 근거 자원에 연결된다. `applies`와 하나 이상의 `check`를 함께 적어야 한다. 관측의 `verification`은 검사 설명·범위·역할/자원 연결·`evidenceAvailable`을 제공한다. `status: NOT_EXECUTED`와 `semanticTruth: NOT_EVALUATED`는 유지한다. 근거 파일을 읽을 수 있다는 관측을 검사 통과로 해석하지 않는다.

## 조회 범위와 허용 목록

```ts
observeProgram(plan, {
  links: ["dash_behavior"],
  allowedLocators: [/* 명시적으로 허용한 정확한 locator */],
  maxResources: 16,
  sourceText,
})
```

선택한 링크의 모든 참여자와 그 의미의 KG grounding만 조회한다. 검사 근거는 참여 역할이므로 같은 범위에 포함된다. 선언되어 있지만 사용하지 않는 자원·의미는 읽지 않는다. 허용 정책과 같은 `locatorKey`를 기준으로 조회를 중복 제거한다. 따라서 `https://host`와 `https://host/`처럼 같은 URL의 표기 차이는 조회·예산을 한 번만 차지한다. 서로 다른 경로는 별개로 유지한다.

- `links` 생략: 모든 선언 링크. `[]`: 조회 없음.
- `allowedLocators` 생략: 선택된 참여자·grounding의 정확한 주소를 이번 호출의 허용 범위로 삼는다. `[]`: 전부 `DENIED`, resolver 호출 없음.
- `maxResources` 기본값은 256이며 중복 제거한 locator 수에 적용한다. 초과·잘못된 링크 이름·잘못된 정책은 IO 전에 실패한다.
- 생략은 `undefined`만 뜻한다. `links`, `allowedLocators`, `maxResources`에 명시한 `null`은 `ObservationError`로 거부하며 resolver를 호출하지 않는다. 옵션은 관측 시작 시 알려진 필드를 각각 한 번 읽어 고정한다. 클래스 getter·상속·비열거 속성도 적용하며 배열은 다음 getter를 읽기 전에 복제한다.
- `ResolversLive`는 호출별 허용 목록과 `ResolverConfig.allowedLocators`의 교집합을 적용한다. 호출이 상위 정책을 넓힐 수 없다. URL 표기의 정규화도 양쪽에서 동일하게 적용한다.
- 파일의 실제 경로와 URL 리다이렉트 대상이 바뀌면 그 대상도 허용 목록에 있어야 한다. 파일 realpath 조회 후 본문을 읽기 전에 검사하고, 리다이렉트는 다음 요청 전에 검사한다.

`readScope`에는 링크·요청 locator·호출별 허용 목록·예산을 남긴다. `metrics`는 선언/선택 자원 수, locator 수, resolver 호출 수, 거부된 locator 수다. resolver 호출 수는 내부 HTTP 리다이렉트 요청 횟수나 읽은 바이트 수가 아니다. 상위 Config 정책은 실제 resolver 결과에 반영되며 `readScope.allowedLocators`는 호출별 요청 정책이다.

동일한 조회 정체성은 선택 자원, grounding 순서에서 처음 나타난 주소를 대표 요청으로 사용한다. `readScope.requestedLocators`에는 대표 주소만 들어간다. 각 자원의 `locator`는 원래 선언 표기를 보존하고, `resolution.locator`는 실제 대표 요청 주소를 가리킨다. 별칭들은 같은 수집 결과를 공유해야 한다. `uniqueLocators`·`resolverCalls`·`deniedLocators`와 `maxResources`는 정규화된 조회 정체성으로 계산한다.

직접 주입한 `Resolvers` 구현은 두 번째 인자의 정책도 준수해야 한다. 기본 관측의 선택 범위와 호스트 설정은 HSWM owner/permit 인증이나 OS sandbox를 구현한 것이 아니다. 파일 라인 범위는 현재 파일을 읽은 뒤 해당 구간을 해시하며, Git은 등록된 checkout에서 객체를 읽는다. `trust_host` 보장은 유지한다.

resolver에는 내부 plan·허용 목록과 분리한 사본을 전달한다. 각 응답은 완료 즉시 깊게 복제하고 필드 형식·요청 identity·허용된 결과 주소를 검사한다. 다른 resolver를 기다리는 동안이나 보고서 반환 후 adapter가 보관한 객체를 수정해도 수집된 관측은 바뀌지 않는다. KG 결과는 요청한 source/UID와 동일해야 하며, 직렬화된 관측을 검증할 때도 같은 조건을 적용한다.

실패 응답도 `kind`·`locator`·`reason`·`detail`을 고정해 검증한다. 잘못된 필드나 다른 요청의 실패를 반환하는 adapter는 `ObservationError`로 종료한다. 정상적인 `ORPHAN`·`AMBIGUOUS`·`IO`·`DENIED`는 기존대로 미확정 관측에 포함된다.

## 변경 비교와 CLI

```sh
npm run usl -- observe --source game.usl --link dash_behavior --out baseline.json
npm run usl -- observe --source game.usl --link dash_behavior \
  --baseline baseline.json --out current.json

# 명시적 허용 범위 또는 조회 없는 거부 관측
npm run usl -- observe --source game.usl --link dash_behavior \
  --allow-locator file://dev/path/spec.md --allow-locator file://dev/path/code.ts
npm run usl -- observe --source game.usl --deny-all
```

`--link`와 `--allow-locator`는 반복할 수 있다. `--out`은 원본 관측 보고서를 저장한다. `--baseline`이 있으면 표준 출력은 `{ observation, comparison }`이며, 없으면 관측 보고서 자체다. baseline과 source를 출력 경로로 덮어쓸 수 없다. 비교는 baseline을 자동 갱신하지 않는다.

| 비교 필드 | 의미 | 대응 |
| --- | --- | --- |
| `addressChanged` | 역할의 자원 바인딩, 선언 주소 또는 성공적으로 해석된 주소 변경 | `REVIEW_ADDRESS_BINDING` |
| `contentChanged` | 양쪽 관측이 성공했고 resolver 표현 해시가 변경 | `RECHECK_EVIDENCE` |
| `semanticContractChanged` | 의미 설명·역할 타입·적용 범위·검사 계약 변경 | `REVIEW_SEMANTIC_CONTRACT` |
| `unavailable` | 현재 허용된 조회가 성공하지 않음 | `RESTORE_AUTHORIZED_READ` |
| `baselineMissing` | 비교할 이전 성공 관측이 없음 | `ESTABLISH_BASELINE` |

주소와 내용이 동시에 바뀌면 둘 다 기록한다. 배열은 참여 역할 이름이며 grounding은 `grounding:<meaning>`으로 식별한다. 동일 주소의 별칭으로 참여자를 재바인딩하면 주소 바인딩 변경으로 기록한다. 새 링크는 의미 변경 여부를 `null`로 두며 기준 설정이 필요하다. 이전에만 관측한 링크는 `linksOutsideCurrentScope`에 남기며 삭제됐다고 단정하지 않는다. 변경이 없다는 것은 비교 가능한 표현·계약이 같다는 뜻이다.

KG의 `fingerprintScope: KG_METADATA`는 기존 공개 metadata와 `target_version`의 제한된 지문이다. KG 설명이나 전체 그래프의 의미 변경을 검증하지 않는다. 작성된 USL 의미 계약의 변경은 별도 digest가 검출한다. 외부 KG 의미를 바꿨는데 USL 정의나 공개 지문은 그대로인 경우는 여전히 검출 범위 밖이다.

관측 v1에는 의미 identity가 없으므로 새 비교 기준으로 사용할 수 없다. v2 보고서를 다시 만들어야 한다. 잘못된 digest·다른 namespace·불일치하는 의미/링크 구조는 거부한다. 종료 코드는 성공 `0`, 조회 불가 또는 비교 대응 필요 `2`, 입력·실행 실패 `1`, CLI 사용 오류 `64`다.

`validateObservation`은 모든 중첩 필드의 타입·필수 항목·허용 상태를 검사하며 알 수 없는 필드는 거부한다. 선언으로부터 검사 절차·근거 역할 연결을 재구성하고, 관측값으로부터 `resourcesResolve`·`evidenceAvailable`·전체 상태·조회 목록·통계를 계산해 대조한다. 허용 범위 밖의 성공 관측, 같은 locator의 상충하는 결과, 선택 링크에서 사용하지 않는 선언도 거부한다. 따라서 바깥 digest를 다시 계산해도 `EXECUTED` 같은 실행 상태나 모순된 조회 범위·통계를 넣을 수 없다.

동일 URL의 별칭 사이에서도 대표 요청과 수집값이 같아야 한다. v2 형식은 유지하지만, 수정 전에 URL 표기별로 중복 조회·집계한 보고서는 새 대표 요청·통계 검증을 통과하지 못한다. 이런 보고서는 원문에서 다시 관측해야 한다. 정규화된 URL 중복이 없는 기존 v2 보고서는 기존 구조를 유지한다.

선택 관측에는 원본 plan 전체가 없으므로 `declaredResources`는 음이 아닌 안전한 정수이고 선택 자원 수 이상인지만 확인할 수 있다. 전체 plan·원문 digest의 진위와 선택 범위 밖의 실제 자원 수는 원본과 별도로 대조해야 한다. 이 검증은 보고서 내부의 일관성을 확인하며 외부 사실이나 작성자 인증을 대신하지 않는다.

## 게임 개발 흐름에서의 확인

[대시 기능의 실행 가능한 비교](GAME_WORKFLOW.md)는 탐색 시간과 관측 시간을 분리하고 실제 resolver 호출 수를 센다. 격리 fixture에서 5회 전체 조회와 3회 선택 조회, 오래된 근거 1건 검출, 불필요한 자원 재조회 2건 회피를 확인한다. 실제 게임 프로젝트에서의 사람 탐색 시간과 장기 오탐률은 별도 실사용 측정이 필요하다.
