# USL 어댑터 적대적 검증 — 2026-09-08

**상태: 7개 문제 묶음 재현, 수정 전.** 가장 우선할 문제는 네이티브 KG 관계의 방향·타입 정보가 의미 plan에 온전히 반영되지 않아 관측 비교가 의미 변경을 놓치는 것이다. 반대로 참여자 배열 순서만 바뀌면 의미 검토를 다시 요구한다.

범위는 새 property-graph 어댑터, 공개 SDK, CLI 입력, HSWM 전달 경계다. 기존 회귀 테스트 177개와 타입 검사는 통과했다. 이 결과는 아래 추가 입력에 대한 안전성을 보장하지 않는다. 모든 resolver는 격리된 결정적 fixture이며 실제 KG·네트워크·HSWM 서비스에 접근하지 않았다. CLI 재현은 임시 파일만 사용했다.

관측한 구현 버전과 재현 결과는 [증거 JSON](native-adapter-adversarial-evidence-2026-09-08.json)에 기록했다. `reviewedFileDigests`에 소스·테스트·패키지 설정 69개 파일의 SHA-256이 있고, 직전 검증 기록과 비교한 소스·테스트 65개는 모두 동일하다. 이번 작업은 `src/`, `test/`를 수정하지 않고 `audit/`에 증거만 추가했다.

| ID | 우선순위 | 확인한 문제 | 적용 경계 |
| --- | --- | --- | --- |
| F1 | 높음 | 관계 방향 누락과 타입·설명 인코딩 충돌 | 네이티브 그래프 → 의미 plan → 관측 비교 |
| F2 | 중간 | 추가 옵션이 명시한 탐색 query를 덮어씀 | SDK `context()` |
| F3 | 중간 | 호출자 객체 변경이 반환 결과와 digest를 불일치시킴 | 공개 `adapterResult()` |
| F4 | 중간 | 거절할 옵션·권한 입력을 IO 후에 검증 | SDK `observe()`, `hswm()` |
| F5 | 중간 | snapshot 검증과 출력 한도가 다른 연산과 불일치 | SDK `snapshot()` |
| F6 | 중간 | CLI가 용량 제한을 초과한 파일 전체를 먼저 읽음 | `usl adapt --graph` |
| F7 | 낮음 | 같은 역할 연결의 배열 순서 변경이 의미 검토를 유발 | property-graph 정규화·관측 비교 |

## F1. 원본은 바뀌었는데 의미 plan이 그대로다

위치: [property-graph.ts:120](/home/lagyeongjun/CD/USL/src/integrations/property-graph.ts:120), [property-graph.ts:148](/home/lagyeongjun/CD/USL/src/integrations/property-graph.ts:148).

재현 A: 관계 UID, 타입, 명시적 참여 역할을 유지하고 `from_uid: a, to_uid: b`를 `from_uid: b, to_uid: a`로 바꾼다. 입력 검사는 양 끝점이 참여자에 포함됐는지만 확인한다. 생성한 meaning/link에는 원래 방향이 남지 않는다. 명시적 관계 UID가 있는 경우이므로 방향 변경이 파생 UID 차이로 드러나지도 않는다.

- native `source.digest`: 변경됨.
- 관측 `planDigest`, `meaningsDigest`: 동일함.
- 두 관측의 상태: 모두 `RESOLVES`.
- 비교 결과: `semanticContractChanged: false`, `actions: []`.

두 plan의 digest는 `sha256:b9eac91167fc31568fd0ff7723740127b1da9b047ff95b4df88ebfc4fd70db87`이다. 각 원본·의미 digest는 증거 JSON의 `probes.boundaries.output.directionReversal.versions`에 따로 기록했다.

재현 B: `{type: "BEFORE", description: "original description"}`과, description을 생략하고 type을 문자열 `{"type":"BEFORE","description":"original description"}`로 지정한 입력이 같은 의미 설명을 생성한다. 다른 타입과 설명 유무가 같은 plan으로 합쳐진다. SHA-256 충돌이 아니라 해시하기 전 표현의 충돌이다.

영향: 네이티브 원본의 바이트 변경 자체는 외부 receipt에서 감지할 수 있다. 하지만 그 변경을 의미 계약 변경으로 분류하는 내부 관측 비교가 실패한다. 원래 KG의 방향을 agent가 plan만으로 복원할 수도 없다.

보완 방향: 타입, 설명의 존재 여부, 순서 있는 원래 끝점, 역할 연결을 하나의 명시적인 구조로 보존하고 의미 digest에 연결해야 한다. 설명이 있는 경우와 없는 경우에 서로 다른 인코딩 규칙을 쓰지 않아야 한다.

## F2. 추가 옵션으로 탐색 제한을 덮어쓸 수 있다

위치: [adapters.ts:111](/home/lagyeongjun/CD/USL/src/adapters.ts:111).

`context(request, query, options)`는 `{ query, ...capturedOptions }`를 만든다. options에 허용된 키만 있는지 검사하지 않아 런타임 입력 `{query: {...query, maxHops: 2}}`가 기존 `maxHops: 0`을 덮어쓴다. 같은 탐색이 `NOT_FOUND_WITHIN_LIMITS`에서 `FOUND`로 바뀌었다.

영향: 신뢰한 query와 동적 추가 옵션을 합치는 SDK 호출에서 탐색 범위가 확대된다. TypeScript 선언만으로 JavaScript·JSON 입력을 막을 수 없다. 이 재현은 MCP의 엄격한 입력 스키마나 서버의 locator 허용 목록을 우회한 증거는 아니다.

보완 방향: 추가 옵션의 키와 타입을 먼저 검증하고, 별도 query 인자가 spread로 덮어써지지 않게 구성해야 한다.

## F3. 반환 후에도 호출자 객체가 receipt 결과를 바꾼다

위치: [adapters.ts:70](/home/lagyeongjun/CD/USL/src/adapters.ts:70).

`adapterResult(graph, result)`는 source·identities를 복제하지만 result는 원래 참조를 반환한다. 반환 직후에는 digest가 맞는다. 이후 호출자가 원래 result의 상태를 `UNRESOLVED`에서 `READY`로 바꾸고 evidence를 추가하면 반환된 envelope도 바뀌며 `receipt.resultDigest`는 이전 값이다.

영향: 공개 helper로 만든 결과가 호출자의 후속 변경에 영향을 받아 무결성 검사를 통과할 수 없게 된다. 일반 `observe()` 전체에 동일한 별칭 문제가 있다는 주장은 아니며, receipt를 서명이나 권한 증명으로 간주한 공격도 아니다.

보완 방향: JSON 데이터 검증·복제를 한 번 수행하고 동일한 스냅샷을 해시하고 반환해야 한다.

## F4. 입력을 거절하기 전에 불필요한 조회가 실행된다

위치: [adapters.ts:103](/home/lagyeongjun/CD/USL/src/adapters.ts:103), [adapters.ts:116](/home/lagyeongjun/CD/USL/src/adapters.ts:116).

재현 결과:

| 입력 | 원본 read 호출 | resolver 호출 | 최종 결과 |
| --- | ---: | ---: | --- |
| `observe({}, {links: null})` | 1 | 0 | `options.links must be an array` |
| HSWM authority의 `policy: {}` | 1 | 2 | `HSWM v2 policy is required` |

옵션·authority 복제는 먼저 하지만, 의미 있는 필드 검사는 원본 또는 endpoint 조회 이후에 한다. 두 번째 재현의 locator들은 연결 정책이 허용한 범위다. 허용 목록 바깥의 읽기를 성공시킨 것은 아니다.

영향: 실패가 확정된 요청도 원본 조회와 resolver 비용을 사용한다. 제한된 데이터 읽기와 토큰·IO 비용 관리에 불리하다.

보완 방향: 원본 없이 확인 가능한 옵션 타입·예산·HSWM authority 형식은 IO 전에 검증하고, plan에 의존하는 항목도 endpoint 조회 전에 검증해야 한다.

## F5. snapshot만 다른 검증 경계를 갖는다

위치: [adapters.ts:89](/home/lagyeongjun/CD/USL/src/adapters.ts:89). 비교 위치: [application.ts:123](/home/lagyeongjun/CD/USL/src/application.ts:123).

정상 plan과 정확한 native digest에 빈 identity map을 붙여 custom adapter에서 반환했다. `snapshot()`은 그대로 반환했다. 같은 adapter의 `check()`는 `connection resources identities must cover the view`로 거절했다. `maxOutputBytes: 1`을 설정해도 snapshot의 직렬화 결과 929바이트가 반환됐다.

영향: 공개 SDK가 같은 AdaptedGraph에 서로 다른 유효성 기준을 적용한다. 잘못 작성된 host adapter 결과가 snapshot 소비자에 전달된다. 신뢰한 host callback을 공격자가 임의로 설치할 수 있다는 가정은 하지 않는다. snapshot에 출력 정책을 적용하지 않을 의도라면 그 예외도 현재 API에서 명확히 구분해야 한다.

보완 방향: AdaptedGraph 검증을 공통화하고, snapshot 출력에도 한도를 적용하거나 별도 정책을 명시해야 한다.

## F6. CLI 용량 제한이 파일 읽기 비용을 제한하지 않는다

위치: [cli-adapter.ts:40](/home/lagyeongjun/CD/USL/src/cli-adapter.ts:40), [adapters.ts:86](/home/lagyeongjun/CD/USL/src/adapters.ts:86).

CLI는 `readFile(graph, "utf8")`로 파일을 모두 읽은 뒤 SDK에서 바이트 수를 검사한다. 실제 CLI 함수에 1,048,577바이트 임시 파일을 전달하고 완료된 읽기의 크기를 계측했다. 기본 제한은 1,048,576바이트였지만 1,048,577바이트를 모두 읽은 후 `adapter source exceeds maxInputBytes or is not text`로 실패했다.

영향: 입력은 최종 거절되지만, 큰 파일의 읽기와 메모리 할당 비용은 이미 지불한다. 재현은 제한 초과 읽기를 입증하며 OOM을 일으키지는 않았다. 일반 `connectUsl.read` callback은 문서대로 자신의 IO 한도를 책임져야 한다. 여기서 지적하는 것은 USL이 제공하는 CLI callback의 전체 파일 읽기다.

보완 방향: 파일을 제한된 크기까지 읽는 reader를 사용해야 한다. 사전 stat만으로는 읽는 도중 커지는 파일까지 제한할 수 없으므로 실제 읽기에도 상한을 적용해야 한다.

## F7. 역할 배열 순서 때문에 불필요한 의미 검토가 생긴다

위치: [property-graph.ts:142](/home/lagyeongjun/CD/USL/src/integrations/property-graph.ts:142), [property-graph.ts:149](/home/lagyeongjun/CD/USL/src/integrations/property-graph.ts:149).

역할 이름과 연결된 UID를 모두 유지하고 participants 배열 순서만 뒤집었다. 주소·내용 변경은 없지만 plan digest가 달라지고 `semanticContractChanged: true`, `actions: ["REVIEW_SEMANTIC_CONTRACT"]`가 나왔다.

영향: 역할 이름으로 식별하는 같은 연결을 내보내는 DB 쿼리에서 배열 순서가 달라질 때 불필요한 재검사와 pin 갱신을 유발할 수 있다. 네이티브 participants의 순서에 별도 도메인 의미를 부여하는 사용처는 그 의미를 명시해야 한다. 순서 자체가 의미인 모든 배열을 무조건 정렬하라는 제안은 아니다.

보완 방향: 이름으로 식별하는 역할 연결의 동등성 규칙을 정하고, 순서가 의미 없는 영역만 안정적으로 정규화해야 한다.

## 재현과 검증 범위

```bash
npx --no-install tsx audit/probe-native-boundaries-2026-09-08.ts
npx --no-install tsx audit/probe-native-semantics-2026-09-08.ts
npx --no-install tsx audit/probe-native-hswm-2026-09-08.ts
npx --no-install tsx audit/probe-native-io-2026-09-08.ts
```

네 스크립트 모두 종료 코드 0으로 실행됐고, 출력으로 7개 문제 묶음의 조건을 확인했다. 스크립트 종료 코드 0은 제품 검증 통과를 뜻하지 않는다. 증거 JSON의 `reproduced` 값 8개가 모두 true다. F1의 두 재현을 별도로 기록했기 때문에 문제 묶음 수보다 하나 많다.

기존 테스트 결과는 [회귀 로그](native-adapter-adversarial-tests-2026-09-08.log)에 있다. 타입 검사도 통과했다. 소스 수정이 없으므로 이번 감사에서 별도 build는 반복하지 않았다.

JSON 중복 키의 마지막 값 채택, native UID와 명시적 locator UID가 다른 매핑은 추가로 관찰했지만 현재 계약만으로 결함이라고 단정하지 않았다. MCP의 open-world 표기도 네트워크 IO 유무만으로 결함 처리하지 않았다. 이번 범위에서 새로 재현하지 못한 문제나 실제 외부 시스템의 동작까지 안전하다고 결론내리지 않는다.
