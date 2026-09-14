# CLI

2026-09-14: `usl adapt --format resource-graph --graph FILE --namespace NAME`으로 범용 자원 응답을 읽는다. `--operation jsonld`로 JSON-LD를 출력한다. `check`, `context`, `observe`도 지원하며 생략한 `--format`은 기존 `property-graph`이다. [범용 연결 예제](RESOURCE_GRAPH.md#cli와-mcp).

`npm run usl -- --help` lists the installed command surface. Existing `check`, `compile`, `context`, `observe`, record lifecycle, and `project` commands remain available.

For existing KG data, start with `usl adapt --graph GRAPH.json --namespace NAME
--operation context --focus NATIVE_UID --target NATIVE_UID --compact`.
`--operation check` (the default) validates its adaptation; `--operation observe`
accepts native relation IDs with `--link`, an explicit `--allow-locator` list or
`--deny-all`, and `--max-resources`. Endpoint reads default to deny-all. The graph
is an existing export/query response, not a new USL store. `--out` saves the
result envelope, including native source digest, identity map and receipt. Its
`result` field contains the usual observation/context; pass `result` to the
observation validator. Unresolved observation exits 2; usage errors exit 64.

Create a standalone declaration with `usl init --out game.usl`; it refuses to overwrite an existing file. `usl watch --source game.usl --once` validates and prints the current source/plan digests. Without `--once`, it emits JSONL status updates and keeps the last valid plan after an invalid edit.

Use `usl compare --before old.json --after new.json` and `usl validate-observation --report report.json` for report-only work. Both return exit 0 when their input is valid; `compare` reports required review actions in JSON and does not read a declared resource.

Use `usl graph-import --graph graphspec.json --bindings bindings.json --out wrapper.json` for a GEIP wrapper. The CLI supplies the exact `--graph` text as `bindings.source.text` and rejects a conflicting supplied value.

Use `usl hswm-prepare --input handoff.json --out prepared.json` for a pure HSWM handoff. Pins, policy, and allowed reads remain caller-owned.

Use `usl mcp --config usl.config.json` to start the local stdio MCP server with
an administrator-owned startup configuration. It may register fixed `.usl`
programs and existing native graph files under IDs. `stdout` is reserved for
MCP messages. See [MCP.md](MCP.md) for the schema and client requests.

All `--out` values use atomic writes and must differ from every input path, including symlink aliases.
