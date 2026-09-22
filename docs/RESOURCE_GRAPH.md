# 범용 자원 연결 문법

`usl-resource-graph/v1`은 기존 시스템 응답을 담는 JSON 교환 문법이다. DB 스키마나 새 저장소가 아니다. TypeScript API는 `usl/resource-graph`에서 가져온다. [JSON Schema](../schemas/resource-graph.schema.json), [14종 예제](../examples/fixtures/resource-graph.json), [SHACL](../schemas/resource-graph.shacl.ttl)을 함께 제공한다.

## 최소 입력

```json
{
  "schema": "usl-resource-graph/v1",
  "resources": [
    { "id": "spec:dash", "types": ["urn:game:Requirement"], "locator": "https://example.invalid/spec" },
    { "id": "proof:dash", "types": ["urn:lean4:Theorem"], "locator": "file://fixture/Proof.lean", "metadata": { "declaration": "Demo.dash_requires_ground" } }
  ],
  "meanings": [{ "id": "formalizes", "description": "The author connects this formalization to the requirement." }],
  "links": [{
    "id": "dash-formalization", "meaning": "formalizes",
    "participants": [{ "role": "specification", "resource": "spec:dash" }, { "role": "formalization", "resource": "proof:dash" }]
  }]
}
```

각 `id`는 주어진 응답/연결 범위 안에서 유일한 소유자 ID다. `types`는 도메인을 표현하는 절대 IRI 목록이다. `locator`는 실제 읽기 수단이며 기존 KG·Git·HTTP(S)·파일 문법을 사용한다. 새 도메인 타입이 새 접근 프로토콜을 뜻하지 않는다.

metadata에는 native 심볼, 버전, 문서 selector, 실행 세대, 데이터 키 등의 JSON 값을 보존할 수 있다. 보존한 selector를 USL이 모두 직접 해석하는 것은 아니다. 소유자가 해당 부분을 조회한 응답과 범위를 제공해야 한다. 예제 주소들은 조회 가능한 운영 주소가 아니다.

`provenance`를 쓰면 `sources`, 선택적 `activity`, `agent`에 **입력에 선언한 자원 ID**를 지정한다. 누락된 출처는 추측해서 채우지 않는다. 같은 역할을 두 번 넣거나 정의하지 않은 자원을 참조하면 거부한다. 순서가 의미를 가지면 서로 다른 역할이나 metadata로 명시한다.

## SDK

선택적 `adaptResourceGraph(raw, { namespace, profile })`은 역할 타입·필수 metadata·허용 meaning을 변환 전에 검사한다. CLI는 `--profile FILE`, MCP 고정 연결은 `profile` 파일 경로를 사용한다. 생략하면 기존 동작을 유지한다. [profile 계약과 예제](ENGINEERING_CONTRACTS.md)를 참고한다.

```ts
import { Effect } from "effect"
import { connectUsl } from "usl/adapters"
import { adaptResourceGraph } from "usl/resource-graph"

const connection = connectUsl({
  read: request => owner.readBoundedProjection(request), // Effect<string>, 소유자의 실제 조회
  adapt: raw => adaptResourceGraph(raw, { namespace: "my.resources" }),
  policy: owner.uslReadPolicy,
})
const context = await Effect.runPromise(connection.context(
  { project: "game" }, { focus: "spec:dash", target: "proof:dash" }, { compact: true },
))
```

이 코드는 호스트 통합 형태를 설명한다. `owner`는 호출 애플리케이션이 제공한다. 직접 실행 가능한 예제는 기존 `npm run example:adapter`와 `npm run example:lean`, 아래 CLI다.

`source.digest`는 호스트가 반환한 **원문 전체**의 digest다. 내부 plan은 임시 해석이다. 도메인 타입·metadata는 자원 설명과 사용된 링크의 의미 계약에 포함돼 문맥과 변경 비교에 남는다. 생성 ID는 내부용이며 외부 API는 원래 ID를 사용한다. `resourceDescriptorId(id)`는 해당 자원의 단항 설명 링크 ID를 돌려준다.

## CLI와 MCP

```sh
npm run usl -- adapt --format resource-graph --graph examples/fixtures/resource-graph.json --namespace demo --operation check
npm run usl -- adapt --format resource-graph --graph examples/fixtures/resource-graph.json --namespace demo --operation context --focus example:spec --target example:proof --compact
npm run usl -- adapt --format resource-graph --graph examples/fixtures/resource-graph.json --namespace demo --operation jsonld --out /tmp/usl-resources.jsonld
```

MCP 설정의 연결 항목에 `"format": "resource-graph"`를 지정한다. 생략하면 기존 `property-graph`이다. `resource-graph`에는 모든 locator가 명시되므로 `kgSource`를 함께 지정하면 오류다.

```json
{
  "graph": "fixtures/resource-graph.json",
  "namespace": "example.resources",
  "format": "resource-graph"
}
```

`examples/usl.config.json`은 이 연결을 `resources` ID로 제공한다. MCP 클라이언트는 `context`에 `{ "connection": "resources", "query": { "focus": "example:spec", "target": "example:proof" } }`를 보낸다. 파일 경로·읽기 범위는 호스트 설정이 고정한다. 변경된 응답 파일은 다음 요청에서 다시 읽는다.

## 표준 교환

`resourceGraphJsonLd(raw, { namespace })`와 CLI의 `--operation jsonld`는 JSON-LD 1.1을 반환한다. 원래 ID는 `usl:nativeId`로 보존하고, 교환용 IRI는 namespace·종류·원래 ID를 인코딩해 만든다. 원문 digest를 가진 PROV Entity를 출처로 둔다. 관계는 이름 있는 `usl:Link`와 역할 참여자 노드로 표현한다.

`scripts/validate-rdf.py`는 실제 CLI 출력의 JSON-LD를 RDFLib로 파싱하고 pySHACL로 검사한다. 누락된 의미와 중복 역할을 넣은 두 반례도 거부해야 통과한다. 이 검사는 문법·구조에 대한 것이며 외부 관계의 참이나 서비스 가동을 증명하지 않는다.
