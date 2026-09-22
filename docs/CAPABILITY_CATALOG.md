# 등록된 기능의 발견과 호출 전 검사

USL은 호스트가 등록한 기능 목록을 SDK·CLI·MCP에서 같은 계약으로 읽는다. AI는 의미 IRI로 기능을 찾고, 반환된 descriptor/source digest를 입력에 붙여 사전 검사를 요청한다. 파일 경로·정책·실행기는 호스트가 관리한다.

## 바로 실행하기

```sh
npm run usl -- capability-discover \
  --config examples/usl.config.json \
  --input examples/fixtures/capability-discover.json

npm run usl -- capability-preflight \
  --config examples/usl.config.json \
  --input examples/fixtures/capability-preflight.json
```

첫 명령은 `FOUND`, 둘째는 `READY`와 `NOT_EXECUTED`를 반환한다. 예제는 [로컬 MCP tool 설명](../examples/fixtures/capability-tools.json)에서 가져온 [catalog fixture](../examples/fixtures/capability-catalog.json)다. 원격 서비스나 executor는 등록하지 않는다. `--out FILE`로 결과를 저장할 수 있으며 입력·설정·등록된 파일과 그 심볼릭 링크는 덮어쓸 수 없다.

## 호스트 설정과 카탈로그

기존 설정에 선택적 `capabilityCatalogs`를 추가한다. 경로는 설정 파일을 기준으로 해석한다.

```json
{
  "allowedLocators": [],
  "maxResources": 64,
  "maxInputBytes": 1048576,
  "maxOutputBytes": 1048576,
  "programs": {},
  "capabilityCatalogs": { "demo": "fixtures/capability-catalog.json" }
}
```

`usl-capability-catalog/v1`은 `complete`와 `entries`를 가진다. 각 entry에는 `descriptor`와 선택적 `policy`가 있다. [JSON Schema](../schemas/capability-catalog.schema.json)와 실제 [예제](../examples/fixtures/capability-catalog.json)를 참고한다.

- `(connection, id)`가 같은 기능은 중복 등록할 수 없다. 다른 connection의 같은 이름은 구분한다.
- policy가 있으면 connection·capability ID·descriptor/source digest가 해당 descriptor와 일치해야 한다. 불일치는 카탈로그 오류다.
- policy가 없는 기능도 발견할 수 있다. 이 기능의 사전 검사는 `no host policy` 오류를 반환한다.
- 등록된 파일은 매 요청에 다시 읽는다. 정책 변경은 다음 요청에 반영되며, 잘못된 새 파일을 과거 결과로 대체하지 않는다.
- 기본 상한은 1 MiB, 최대 4,096 entries다. 플랫폼은 호스트의 더 작은 byte 한도를 적용한다. 발견의 `maxResults`와 `maxInspected`는 둘 다 서버 `maxResources` 이하여야 한다.

이 카탈로그는 호스트가 관리하는 JSON 설정이다. 별도 데이터베이스·daemon·전역 레지스트리가 필요하지 않다.

## AI가 사용하는 두 요청

카탈로그를 설정한 MCP 서버는 기존 9개 tool에 다음 2개를 추가한다. 카탈로그가 없는 기본 서버는 기존 9개만 제공한다. 설정 예제의 서버는 총 11개다.

| Tool / SDK operation | 입력 | 결과 |
|---|---|---|
| `capability_discover` | `catalog`, `query` | descriptor·digest·목록 범위·`catalogDigest`; 정책 제외 |
| `capability_preflight` | `catalog`, `selection` | `READY`/`REJECTED`와 이유·pins·`catalogDigest`; 실행 없음 |

발견 요청:

```json
{
  "catalog": "demo",
  "query": { "meaning": "urn:example:sample", "maxResults": 4, "maxInspected": 16 }
}
```

사전 검사에는 `selection.connection`, `selection.capability`, `selection.invocation`을 보낸다. invocation은 발견 결과의 `descriptorDigest`, descriptor의 `sourceDigest`, 입력의 `types`, 선택적 `unit`, `value`를 담는다. [전체 요청 예제](../examples/fixtures/capability-preflight.json)를 참고한다.

클라이언트가 descriptor·policy·파일 경로를 대신 공급할 수 없다. 입력 형태와 탐색 한도는 호스트의 카탈로그 조회 callback을 부르기 전에 검사한다. 등록된 파일을 읽는 작업은 발생할 수 있지만 endpoint 조회나 capability 실행은 하지 않는다.

`FOUND`는 주어진 목록에서 찾았다는 뜻이다. 부분 목록이나 탐색 한도로 다 읽지 못한 경우 coverage가 불완전하며, 못 찾은 결과는 `UNKNOWN_WITHIN_LIMITS`다. 전체 목록에 없는 경우도 `NOT_FOUND_IN_SCOPE`로 한정한다.

`READY`는 해당 순간의 등록된 정책에 대한 사전 검사 결과다. 실행 허가 토큰이나 실행 성공의 증거가 아니다. 실제 호출은 기존 [host Effect callback](ENGINEERING_CONTRACTS.md#4-effect-실행-경계와-결과)에서 다시 검사하며, 외부 시스템의 최신 상태와 원자적 조건부 실행은 executor가 책임진다.

## SDK

```ts
import { parseCapabilityCatalog, discoverCapabilityCatalog, preflightCapabilityCatalog } from "usl/capability-catalog"

const catalog = parseCapabilityCatalog(hostOwnedCatalog)
const found = discoverCapabilityCatalog(catalog, {
  meaning: "urn:example:sample", maxResults: 4, maxInspected: 16,
})
const assessment = preflightCapabilityCatalog(catalog, hostSelectedRequest)
```

위 변수는 호출 애플리케이션이 제공한다. shared application 경로는 `executeUslOperation`의 두 operation과 호스트의 `policy.getCapabilityCatalog(id)`를 사용한다. 직접 구성하는 MCP 서버도 `policy.getCapabilityCatalog` 또는 `capabilityCatalogs` 중 하나를 받는다. callback은 설명과 정책만 반환하는 읽기 경계여야 한다.

카탈로그 파서는 입력을 복사·고정하며, 정책을 발견 결과로 내보내지 않는다. `catalogDigest`는 정책을 포함한 등록 snapshot의 변경을 식별하는 체크섬이며 서명이나 인가가 아니다. runtime credential은 이 설정의 필드가 아니며 executor 쪽에서 관리한다.

## 명세 변환의 정합성

MCP/OpenAPI inventory를 그래프로 바꿀 때 보존한 원문을 다시 해석해 native operation·schema·목록 완전성을 대조한다. 복제된 inventory에 원문에 없는 기능을 추가하거나 pagination을 완전한 목록으로 바꾸면 거부한다. owner가 명시한 의미·타입·effect binding은 여전히 선언이다.

OpenAPI path template은 parameter serializer가 필요하므로 미지원으로 표시한다. 응답의 헤더와 후속 links도 실제 매핑이 없으면 미지원이다. OpenAPI가 무시하도록 정의한 response `Content-Type` 헤더는 예외다. 이는 [OpenAPI 3.1.1의 path templating과 Response Object](https://spec.openapis.org/oas/v3.1.1.html)에 따른 제한이며 완전한 HTTP driver를 제공한다는 뜻은 아니다.
