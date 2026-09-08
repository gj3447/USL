# Getting started with USL

USL gives a stable name to a resource, declares a relationship with typed
roles, and records a meaning contract including its scope and declared checks.
The source file is optional: an application may keep a validated
`SemanticPlan` built through the TypeScript API. Use `.usl` when people need to
author or review declarations.

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

Start the local read-only stdio server with:

```bash
npm run usl -- mcp
```

It starts deny-all unless the host sets `USL_MCP_POLICY`. That JSON must contain
exactly the startup-owned fields below. `programs` maps fixed IDs to `.usl`
files; MCP callers select an ID and cannot submit a filesystem path through
that registration mechanism.

```json
{
  "allowedLocators": ["https://docs.example/game/dashboard"],
  "maxResources": 4,
  "maxInputBytes": 1048576,
  "maxOutputBytes": 1048576,
  "programs": { "game-dashboard": "/srv/usl/game-dashboard.usl" }
}
```

The server provides `check`, `compile`, `context`, `observe`, `compare`,
`validate_observation`, `graph_import`, `hswm_prepare`, and `project`.
Arguments can narrow the startup policy but cannot broaden it. Registered files
are watched and revalidated; existing observation reports stay unchanged.
