# USL 사용자 매뉴얼

USL은 이미 있는 게임 코드, 기획 문서, KG, Git, URL, 파일을 이름과 역할로
연결하고, 필요한 부분만 읽어 관측 결과를 남깁니다. 그래프 DB나 별도 DSL을
반드시 도입할 필요는 없습니다. 원본 데이터와 native UID는 기존 서비스가
소유하고, USL은 요청 시점의 제한된 뷰를 만들 뿐입니다.

관측은 “주소를 찾았는가”와 “선언된 근거를 읽을 수 있었는가”를 기록합니다.
`implements` 같은 의미가 참이라는 판정이나 check 실행은 포함하지 않습니다.

## 설치와 빠른 확인

저장소에서 다음을 실행합니다.

```bash
npm ci
npm run usl -- --help
npm run example:adapter
```

설치한 실행 파일 형태로 쓰려면 `npm run build` 후
`node dist/src/cli.js --help`, `node dist/src/mcp.js --config examples/usl.config.json`을
실행합니다. 빌드는 USL 자체 TypeScript 코드를 바꿨을 때 필요합니다. 연결된 graph
데이터를 수정한 뒤 별도로 컴파일할 필요는 없습니다.

마지막 명령은 포함된 native graph fixture를 한 번 읽어 compact context와
deny-default observation 결과를 출력합니다. 외부 DB나 URL을 호출하지 않습니다.

## 게임 그래프를 바로 사용하기

기존 KG/Cypher 결과를 다음처럼 JSON projection으로 저장하거나, SDK에서 같은
형태의 문자열을 owner callback으로 반환합니다.

```json
{
  "nodes": [
    { "uid": "game:dash", "properties": { "locator": "kg://game/game:dash" } },
    { "uid": "repo:game", "properties": { "locator": "git://example.test/team/game" } },
    { "uid": "spec:dash", "properties": { "locator": "https://example.test/game/dash" } }
  ],
  "relations": [{
    "uid": "game:dash-implementation",
    "from_uid": "repo:game",
    "to_uid": "game:dash",
    "type": "IMPLEMENTS",
    "properties": {
      "description": "repository implements the dashboard specification",
      "participants": [
        { "role": "repository", "uid": "repo:game" },
        { "role": "concept", "uid": "game:dash" },
        { "role": "specification", "uid": "spec:dash" }
      ]
    }
  }]
}
```

`from_uid`와 `to_uid`는 방향 있는 관계로 보존됩니다. role 이름이 같은 n-ary
participant mapping은 입력 배열 순서와 무관하게 같은 plan으로 정규화됩니다.
원본 JSON 바이트 digest는 항상 별도로 남으므로, 배열 순서 변경도 native
snapshot 변경으로는 식별됩니다.

CLI에서는 `.usl` 파일을 만들지 않고 native UID로 탐색합니다.

```bash
npm run usl -- adapt --graph examples/fixtures/native-graph.json \
  --namespace game.adapter --operation context \
  --focus game:dash --target checkout:game --compact
```

compact 출력의 `result.context`가 문맥이고 `result.stats`가 전달량 통계입니다.
`source.digest`와 `receipt`가 이 native graph 응답의 identity입니다.
compact context의 `mode: "UNCHANGED"`는 수신자가 같은
context digest를 이미 가진 경우에만 재전송을 생략할 수 있다는 뜻입니다. 이
방식으로 긴 그래프를 매번 agent prompt에 넣지 않습니다.

## 필요한 자원만 관측하기

관측은 선택한 link의 participant와 meaning grounding만 대상으로 합니다. 먼저
읽지 않는 관측을 저장해 범위를 확인할 수 있습니다.

```bash
npm run usl -- adapt --graph examples/fixtures/native-graph.json \
  --namespace game.adapter --operation observe \
  --link game:dash-implementation --deny-all --out denied.json
```

이 명령은 의도적으로 exit status 2를 반환할 수 있지만 `denied.json`은 유효한
관측 결과입니다. `resolverCalls: 0`, `DENIED` rows, `status: "UNRESOLVED"`를
확인합니다.

읽기를 허용할 때는 필요한 locator만 나열합니다. 아래 주소는 예시이므로 실제
KG·저장소·URL 주소로 바꾸고 [resolver 설정](../README.md#locator와-조회-설정)을
맞춰야 합니다. 예시 그대로 실행하면 실제 근거 조회 성공을 기대할 수 없습니다.

```bash
npm run usl -- adapt --graph examples/fixtures/native-graph.json \
  --namespace game.adapter --operation observe \
  --link game:dash-implementation \
  --allow-locator 'git://example.test/team/game' \
  --allow-locator 'kg://example/game:dash' \
  --allow-locator 'https://example.test/game/dash' \
  --max-resources 3 --out observation.json
```

CLI export는 로컬 graph 파일을 읽습니다. 애플리케이션에서는 owner가 고정된
bounded query/API 호출을 제공하고 `connectUsl({ read, adapt, policy })`에
연결합니다. 클라이언트 입력으로 Cypher, DB 주소, 임의 파일 경로를 받지 마세요.
allowlist, resource budget, HSWM pins와 `allowed_reads`도 resource 내용에서 만들지
않고 caller/host policy에서 제공합니다.

## 결과를 비교하고 검증하기

native adapter의 저장 결과는 wrapper envelope입니다.

```json
{
  "source": { "adapter": "property-graph/v2", "digest": "sha256:..." },
  "identities": { "resources": {}, "links": {} },
  "result": { "schema": "usl-program-observation/v2", "sourceDigest": null },
  "receipt": { "sourceDigest": "sha256:...", "planDigest": "sha256:...", "resultDigest": "sha256:...", "digest": "sha256:..." }
}
```

`result.sourceDigest: null`은 오류가 아니라 native graph에서 `.usl` 원문을
컴파일하지 않았다는 표시입니다. 원본 graph identity는 바깥 `source.digest`와
`receipt.sourceDigest`에서 읽습니다. wrapper를 풀어 `result`만 임의로 바꾸지
말고, 저장한 envelope를 그대로 검사·비교합니다.
이 검사는 JSON 내부의 일관성을 확인합니다. receipt는 서명이나 의미가 참이라는
증명이 아니므로, 출처를 신뢰할 수 있는지는 별도로 판단해야 합니다.

```bash
npm run usl -- validate-observation --report observation.json
npm run usl -- compare --before observation-before.json --after observation.json
```

비교 결과는 다음을 따로 냅니다.

- `REVIEW_ADDRESS_BINDING`: 역할이 가리키는 주소 또는 resolved address가 바뀜
- `RECHECK_EVIDENCE`: 같은 주소의 representation content가 바뀜
- `REVIEW_SEMANTIC_CONTRACT`: type, 관계 방향, description, role/contract가 바뀜

`property-graph/v1`에서 v2로 올린 graph는 새 plan digest를 만듭니다. 기존
observation은 역사 기록으로 남겨 두고 새 baseline을 만든 뒤, caller가 소유한
HSWM plan pin도 한 번 검토합니다.

## MCP로 고정된 프로그램과 native graph 연결하기

MCP는 stdio 서버입니다. config 파일은 startup에서 한 번만 읽으며, client가
임의 경로나 Cypher를 보내지 못하게 고정 ID를 등록합니다.

`usl-mcp.json` 예시:

```json
{
  "allowedLocators": ["https://example.test/game/dash"],
  "maxResources": 4,
  "maxInputBytes": 1048576,
  "maxOutputBytes": 1048576,
  "programs": { "game-declarations": "./game.usl" },
  "connections": {
    "game": {
      "graph": "./native-game-graph.json",
      "namespace": "game.adapter",
      "kgSource": "game"
    }
  }
}
```

```bash
npm run usl -- mcp --config usl-mcp.json
# 설치한 binary에서는: usl-mcp --config usl-mcp.json
```

`programs`와 `connections`의 경로는 config 파일이 있는 디렉터리 기준입니다.
`connections`는 선택할 때마다 graph를 제한된 크기로 다시 읽고
`property-graph/v2` view로 적응합니다. config를 바꿨으면 서버를 재시작합니다.
`USL_MCP_POLICY` 환경 변수도 같은 shape을 받지만 상대 경로는 startup working
directory 기준입니다. `--config`와 그 환경 변수를 함께 주지 않습니다.

MCP에는 다음 9개 read-only tool이 있습니다.

| Tool | 하는 일 |
| --- | --- |
| `check`, `compile` | source/program/connection의 plan 확인 |
| `context` | 제한된 구조 context 반환 |
| `observe` | policy 범위 안에서 evidence availability 관측 |
| `compare`, `validate_observation` | 저장한 report/envelope 비교·검증 |
| `graph_import` | GEIP GraphSpec handoff 준비 |
| `hswm_prepare` | HSWM 입력 검증·준비 |
| `project` | semantic projection 생성; KG write 없음 |

connection context input 예시는 다음과 같습니다.

```json
{ "connection": "game", "query": { "focus": "game:dash", "target": "repo:game" } }
```

관계 경로를 제한하면 `routes[].meaning`은 native relation UID를, `enter`/`exit`은
원래 role 이름을 사용합니다. observe에서는 native relation UID를
`options.links`에 넣습니다. tool 입력은 startup allowlist나 budget을 넓힐 수 없고
더 좁힐 수만 있습니다.

## HSWM으로 넘기기

HSWM 준비는 USL이 권한을 만들어 주는 단계가 아닙니다. caller가 policy, exact
resource pins, `allowed_reads`, revision을 독립적으로 제공해야 합니다. native
adapter 관측은 `sourceDigest: null`이므로 HSWM policy의 `source_digest`도 `null`이어야
합니다. 정상 live flow에서는 `authority.now`를 생략해 endpoint 관측 후 freshness를
계산합니다.

```ts
const prepared = await Effect.runPromise(
  connection.hswm(request, { links: ["game:dash-implementation"] }, authority)
)
```

준비된 값은 HSWM Python consumer에 전달할 pure input입니다. USL은 HSWM을 호출하거나
admission, owner, Permit, credit, execution, learning 상태를 만들지 않습니다.

## agent 스킬 사용하기

[skills/usl](../skills/usl/SKILL.md)의 `SKILL.md`와 `references/`를 함께 agent가
지원하는 스킬 디렉터리에 등록합니다. 스킬 폴더 전체를 복사해도 저장소 밖에서
참조를 읽을 수 있습니다. 이 작업 환경에는 이미 저장소의 스킬을 가리키는 링크가
등록돼 있어 이번 수정이 반영됩니다.

agent에게는 “USL 스킬로 `game` 연결에서 `game:dash`의 관련 코드를 찾고,
허용된 선택 링크만 관측해 이전 보고서와 비교해줘”처럼 요청합니다.
MCP 연결은 별도로 [클라이언트 설정 예제](../examples/mcp-adapter-client.json)의
command/args를 클라이언트 설정에 등록합니다. 스킬이 자동으로 MCP 서버를 설치하거나
읽기 권한을 만들지는 않습니다.

## 토큰과 재검사 비용을 줄이는 방법

게임 개발 흐름에서는 다음만 측정하면 됩니다.

1. native UID로 `context --compact`를 요청하고 context digest를 수신자 cache와
   비교해 이미 가진 context를 재전송하지 않습니다.
2. 전체 graph 대신 선택한 link만 observe하고 `maxResources`를 그 link의
   participant/grounding 수로 제한합니다.
3. 이전 envelope를 비교해 address, content, semantic contract 중 바뀐 channel만
   처리합니다. participant 배열 순서만 바뀐 v2 graph는 semantic review가 나오지
   않습니다.
4. 문서·코드·graph owner가 바뀌어도 fixed connection ID 또는 owner callback 한 곳만
   갱신합니다. 연결된 agent prompt와 consumer가 개별 URL을 다시 작성할 필요는 없습니다.
