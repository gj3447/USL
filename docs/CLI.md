# CLI

## 단순 바인딩의 기본 흐름

직접 작성한 선언은 `check → compile → context`로 사용한다.

```sh
npm run usl -- check --source examples/agent-navigation.usl
npm run usl -- compile --source examples/agent-navigation.usl
npm run usl -- context --source examples/agent-navigation.usl \
  --focus checkout --target concept --compact
```

기존 그래프에는 `adapt`를 사용한다. [선택 규칙 예제](ADDON_BINDING.md)는
동일한 그래프에 기본 검사와 선택한 profile 검사를 적용한다.

```sh
npm run usl -- adapt --format resource-graph \
  --graph examples/fixtures/addon-binding.json --namespace addon.example --operation check
npm run usl -- adapt --format resource-graph \
  --graph examples/fixtures/addon-binding.json --namespace addon.example \
  --profile examples/fixtures/addon-binding.profile.json --operation context \
  --focus addon:target --target addon:rule --compact
```

profile 선택은 원래 resource/link ID를 유지하고 검사한 profile의 digest를
해석에 포함하므로 `planDigest`는 기본 검사와 달라질 수 있다. context는 규칙·
설정·소비자의 네 역할과 출처를 보존한다. 규칙 계산은 해당 소비자가 담당한다.

폴더 이동은 host의 workspace mapping을 갱신하고, 로컬/Git/URL 표현의 병존은
`locate`·`bind-graph`의 명시적 선택으로 처리한다. [설정 계약](RESOURCE_BINDINGS.md)과
[실행 가능한 CLI 회귀 예제](../test/addon-binding-cli.test.ts)는 같은 자원 ID로
경로 이동·Git 표현 선택·선택 profile 재검사를 확인한다.

메인 CLI의 다음 개발 단계는 [Core CLI 계획](CORE_CLI_PLAN.md)에 정리했다.

## 호스트 등록 프로그램과 확장 명령

2026-09-28: 이동 가능한 자원 선택과 호스트 등록 CLI 실행을 추가했다. [전체 설정과 실행 범위](CLI_GRAPH_ARCHITECTURE.md).

```sh
usl locate --config HOST.json --resource ID --representation REPRESENTATION_ID
usl inspect-binding --config HOST.json --resource ID --representation REPRESENTATION_ID
usl bind-graph --config HOST.json --graph GRAPH.json --selections SELECTIONS.json --out NEW_ENVELOPE.json
usl cli-list --config HOST.json
usl cli-plan --config HOST.json --action ID --input INVOCATION.json --out NEW_PLAN.json
usl cli-run --config HOST.json --action ID --input INVOCATION.json --expected-plan sha256:... --receipt-dir NEW_DIRECTORY [--operation-key KEY]
usl cli-inspect --receipt-dir DIRECTORY
```

`HOST.json`은 별도 `usl-cli-host/v1` 설정이다. MCP 설정과 혼용하지 않는다. `bind-graph` 출력은 `graph`와 `bindingReceipt` envelope이며 기존 `adapt`에 넣을 때는 `graph`를 사용한다. plan/graph 출력 파일은 새 파일만 허용한다. run은 intent와 result를 새 디렉터리에 기록한다. 거부·불명 결과는 exit 2이며 자동 재시도하지 않는다. `npm run example:cli`로 실제 실행 예제를 확인한다.

`inspect-binding`은 파일 pin과 로컬 Git 상태를 조회하며 원격 내용을 가져오지 않는다. host에 `operations`가 있으면 `cli-run`의 `--operation-key`가 필수다. `cli-inspect`는 현재 host 없이 과거 기록을 검사하며, 유효한 intent-only 기록은 `UNKNOWN`으로 출력하고 exit 0이다. 소유자 대조는 SDK의 등록된 `connectCliReconciler` 콜백을 사용한다. [바인딩·중복 키·복구 사용법](BINDING_OPERATIONS.md).

`usl capability-discover --config FILE --input REQUEST.json`과 `usl capability-preflight --config FILE --input REQUEST.json`은 호스트가 등록한 기능을 검색하고 호출 조건을 검사한다. 둘 다 `--out FILE`을 지원하며 기능을 실행하지 않는다. [요청·설정 예제](CAPABILITY_CATALOG.md)를 참고한다.

2026-09-14: `usl adapt --format resource-graph --graph FILE --namespace NAME`으로 범용 자원 응답을 읽는다. `--operation jsonld`로 JSON-LD를 출력한다. `check`, `context`, `observe`도 지원하며 생략한 `--format`은 기존 `property-graph`이다. [범용 연결 예제](RESOURCE_GRAPH.md#cli와-mcp).

`npm run usl -- --help` lists the installed command surface. Existing `check`, `compile`, `context`, `observe`, record lifecycle, and `project` commands remain available.

For existing KG data, start with `usl adapt --graph GRAPH.json --namespace NAME
--operation context --focus NATIVE_UID --target NATIVE_UID --compact`.
`--operation check` (the default) validates its adaptation; `--operation observe`
accepts native relation IDs with `--link`, an explicit `--allow-locator` list or
`--deny-all`, and `--max-resources`. Endpoint reads default to deny-all. The graph
is an existing export/query response, not a new USL store. `--out` saves the
result envelope, including native source digest, identity map and receipt. Its
`result` field contains the usual observation/context; pass the complete observation
envelope to the validator to preserve its source and receipt checks. Unresolved observation exits 2; usage errors exit 64.

Create a standalone declaration with `usl init --out game.usl`; it refuses to overwrite an existing file. `usl watch --source game.usl --once` validates and prints the current source/plan digests. Without `--once`, it emits JSONL status updates and keeps the last valid plan after an invalid edit.

Use `usl compare --before old.json --after new.json` and `usl validate-observation --report report.json` for report-only work. Both return exit 0 when their input is valid; `compare` reports required review actions in JSON and does not read a declared resource.

Use `usl graph-import --graph graphspec.json --bindings bindings.json --out wrapper.json` for a GEIP wrapper. The CLI supplies the exact `--graph` text as `bindings.source.text` and rejects a conflicting supplied value.

Use `usl hswm-prepare --input handoff.json --out prepared.json` for a pure HSWM handoff. Pins, policy, and allowed reads remain caller-owned.

Use `usl mcp --config usl.config.json` to start the local stdio MCP server with
an administrator-owned startup configuration. It may register fixed `.usl`
programs and existing native graph files under IDs. `stdout` is reserved for
MCP messages. See [MCP.md](MCP.md) for the schema and client requests.

All `--out` values use atomic writes and must differ from every input path, including symlink aliases.
