# Getting started with USL

현재 전체 모델은 [ARCHITECTURE.md](ARCHITECTURE.md)다. 다양한 자원을 연결하려면 [범용 자원 문법](RESOURCE_GRAPH.md), Lean 정의·정리·증명 연결과 형식 검증은 [Lean 4 안내](LEAN4_INTEGRATION.md)에서 시작한다.

USL adapts existing systems so their resources can be connected, observed and
passed into agent or HSWM context. Data remains with its owner. Start with the
owner's existing read API or bounded KG query projection; no USL database,
registration file or `.usl` source is required.

```bash
npm run example:adapter
npm run usl -- adapt --graph examples/fixtures/native-graph.json --namespace game.adapter \
  --operation context --focus game:dash --target checkout:game --compact
```

The example uses native graph UIDs and preserves every role of its three-party
relation. It reads an illustrative graph response and does not fetch the
example endpoints. In an application, `connectUsl({ read, adapt, policy })`
binds the owner's read operation directly: each request adapts one fresh response
and uses a transient plan for validation and navigation. See
[ADAPTER_INTEGRATION.md](ADAPTER_INTEGRATION.md) for SDK, MCP and HSWM usage.

## Optional authored declarations

Use `.usl` when people want to author a standalone declaration document, or the
code SDK to attach declarations to functions. These are additional inputs to
the same observation and navigation functions.

```usl
usl "0.1";
namespace "game.example";
resource spec = "https://example.test/spec";
resource implementation = "file://host/project/src/game.ts";
meaning implements(specification: url, code: filesystem) = "코드가 명세를 구현한다"
  applies "고정된 빌드"
  check review(specification, code) = "명세와 코드를 대조한다";
link game_flow = implements(specification: spec, code: implementation);
```

## A first local flow

The example above is what `init` writes. Generate the file, then ask for compact
context. `context` reads the plan only and does not fetch its example locators.

```bash
npm run usl -- init --out game.usl
npm run usl -- context --source game.usl --focus spec --compact
```

An observation requires an explicit scope. This deny-all invocation produces a
valid historical report with zero resolver calls and denied resources. It exits
with status 2 because the selected link is unresolved, so scripts that expect
that result should handle that status before validating the saved report.

```bash
npm run usl -- observe --source game.usl --link game_flow --deny-all --out observation.json
npm run usl -- validate-observation --report observation.json
```

To permit a real read, pass each valid locator with `--allow-locator` and set a
resource budget appropriate to the selected link. Include a meaning grounding
when the declared meaning uses one. A source path or `sourceText` identifies a
declaration; it does not authorize filesystem, network, KG, HSWM, or admission
access.

## Reuse and refresh a program

For code-embedded declarations, retain the validated `SemanticPlan` and pass
it to navigation, compact context, observation, or integration functions. It
does not need recompilation for each agent call.

For a host-managed `.usl` file, register a fixed program ID at startup with
`openProgramRegistry`. The registry watches the file, validates each edit, and
caches the latest valid immutable snapshot. A changed valid source updates its
source digest; the plan digest changes when its compiled declarations change.
An invalid edit is reported as `INVALID_EDIT` to new registered
program requests, rather than silently serving it as a new plan. Previously
produced observations retain their original plan and source digests.

Use the CLI to inspect a file's current validated revision:

```bash
npm run usl -- watch --source game.usl --once
```

See [CODE_INTEGRATION.md](CODE_INTEGRATION.md) for the code-embedded API and
[COMPACT_CONTEXT.md](COMPACT_CONTEXT.md) for `agentContext`. Compact context
can return `UNCHANGED` only for the exact context digest already held by the
receiver.

## Observation is scoped read-only work

An observation resolves only selected link participants and their meaning
groundings. Give it a caller-owned locator allowlist and resource budget. The
report distinguishes address changes, representation-content changes, and
meaning-contract changes. It records availability and declared check evidence;
it does not execute a check or establish a meaning as true.

Do not create permissions, pins, owners, or admission from a locator, resource
text, or report. Resolver policy can still deny an allowlisted locator.

## Compare, graph, and HSWM handoff

The CLI supports offline report comparison and validation, GraphSpec import,
and HSWM preparation:

```bash
npm run usl -- compare --before observation-before.json --after observation-after.json
npm run usl -- validate-observation --report observation.json
npm run usl -- graph-import --graph game.graph.json --bindings bindings.json --out geip.json
npm run usl -- hswm-prepare --input hswm-input.json --out hswm-arguments.json
```

[GRAPH_ENGINEERING_INTEGRATION.md](GRAPH_ENGINEERING_INTEGRATION.md) preserves
GraphSpec provenance. [HSWM_INTEGRATION.md](HSWM_INTEGRATION.md) documents the
existing HSWM Python adapter input. These are pure handoffs: HSWM policy, exact
pins, and `allowed_reads` must come from the caller; USL does not grant
admission, a Permit, ownership, credit, or learning.

## MCP

Start the local read-only stdio server with an administrator-owned startup
configuration:

```bash
npm run usl -- mcp --config examples/usl.config.json
```

The included config registers both a fixed `.usl` program ID and a fixed native
graph connection ID. MCP callers select those IDs; they cannot submit a
filesystem path through either registration mechanism. It starts deny-all for
endpoint reads because its `allowedLocators` list is empty.

```json
{
  "allowedLocators": [],
  "maxResources": 64,
  "maxInputBytes": 1048576,
  "maxOutputBytes": 1048576,
  "programs": { "game-dashboard": "game-dashboard.usl" },
  "connections": {
    "game": { "graph": "native-graph.json", "namespace": "game.adapter" }
  }
}
```

Config paths are relative to the config file. `USL_MCP_POLICY` supports the
same object when a file is unavailable, with paths relative to startup cwd;
do not combine it with `--config`. The config is fixed until the server is
restarted. A registered `.usl` program refreshes valid edits automatically;
a configured graph is bounded-read and adapted on each selected request.

The server provides `check`, `compile`, `context`, `observe`, `compare`,
`validate_observation`, `graph_import`, `hswm_prepare`, and `project`.
Arguments can narrow the startup policy but cannot broaden it. Registered files
are watched and revalidated; existing observation reports stay unchanged.
