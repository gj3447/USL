# CLI

2026-09-28: 이동 가능한 자원 선택과 호스트 등록 CLI 실행을 추가했다. [전체 설정과 실행 범위](CLI_GRAPH_ARCHITECTURE.md).

```sh
usl locate --config HOST.json --resource ID --representation REPRESENTATION_ID
usl bind-graph --config HOST.json --graph GRAPH.json --selections SELECTIONS.json --out NEW_ENVELOPE.json
usl cli-list --config HOST.json
usl cli-plan --config HOST.json --action ID --input INVOCATION.json --out NEW_PLAN.json
usl cli-run --config HOST.json --action ID --input INVOCATION.json --expected-plan sha256:... --receipt-dir NEW_DIRECTORY
```

`HOST.json`은 별도 `usl-cli-host/v1` 설정이다. MCP 설정과 혼용하지 않는다. `bind-graph` 출력은 `graph`와 `bindingReceipt` envelope이며 기존 `adapt`에 넣을 때는 `graph`를 사용한다. plan/graph 출력 파일은 새 파일만 허용한다. run은 intent와 result를 새 디렉터리에 기록한다. 거부·불명 결과는 exit 2이며 자동 재시도하지 않는다. `npm run example:cli`로 실제 실행 예제를 확인한다.

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
