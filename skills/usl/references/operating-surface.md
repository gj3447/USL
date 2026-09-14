# CLI and MCP operating surface

Run from a USL checkout with `npm run usl -- ...`, or use the installed `usl`
binary after building the package. `usl --help` lists the local version's full
surface.

## Native graph projection

The local adapter reads a JSON export; it does not contact a graph database.
`--focus`, `--target`, and `--link` are original native UIDs.

```bash
usl adapt --graph graph.json --namespace game.graph --operation context \
  --focus native:player --target native:spec --compact

usl adapt --graph graph.json --namespace game.graph --operation observe \
  --link native:implements:1 --deny-all --out denied-observation.json
```

The latter intentionally exits 2 when the selected link is unresolved, while
still writing a valid report. Validate it with
`usl validate-observation --report denied-observation.json`. To permit reads,
replace `--deny-all` with one `--allow-locator LOC` per selected address and set
`--max-resources N`.

An adapter result is an envelope:

```json
{
  "source": { "adapter": "property-graph/v2", "digest": "sha256:..." },
  "identities": { "resources": { "native:player": "pg_resource_..." }, "links": { "native:implements:1": "pg_link_..." } },
  "result": { "schema": "usl-program-observation/v2", "sourceDigest": null },
  "receipt": { "sourceDigest": "sha256:...", "planDigest": "sha256:...", "resultDigest": "sha256:...", "digest": "sha256:..." }
}
```

Use the outer `source.digest` and receipt to identify the native snapshot. For
compare/validation commands, pass the saved envelope unchanged; the commands
recognize the contained observation. Do not replace `result.sourceDigest: null`
with the native digest.

## MCP stdio server

Use a startup-owned JSON file for a repeatable local server:

```json
{
  "allowedLocators": ["https://docs.example/game/spec"],
  "maxResources": 4,
  "maxInputBytes": 1048576,
  "maxOutputBytes": 1048576,
  "programs": { "game-declarations": "./game.usl" },
  "connections": {
    "game": { "graph": "./game-projection.json", "namespace": "game.graph", "kgSource": "canonical-neo4j" }
  }
}
```

Start it with `usl mcp --config usl-mcp.json` (or
`usl-mcp --config usl-mcp.json`). Paths in that file are relative to the
configuration file. All top-level fields shown except `connections` are
required; unknown keys are rejected. `connections` is optional. `programs` and
`connections` create fixed IDs only at startup. A connection rereads and
bounded-adapts its graph file for each selected operation. Restart the server
after changing its config.

`USL_MCP_POLICY` accepts the same shape for environment-managed deployment;
its relative paths use the startup working directory. Do not set both that
environment value and `--config`.

The server has exactly these read-only tools:

| Tool | Required input | Result |
| --- | --- | --- |
| `check` | `source`, `program`, or `connection` | plan/snapshot identity |
| `compile` | `source`, `program`, or `connection` | compiled plan |
| `context` | source selector + `query.focus` | bounded graph context |
| `observe` | source selector + optional scoped `options` | availability report/envelope |
| `compare` | `before`, `after` reports or envelopes | address/content/contract change actions |
| `validate_observation` | `report` or envelope | structural/digest validation |
| `graph_import` | raw GraphSpec plus bindings | GEIP handoff only |
| `hswm_prepare` | independently owned arguments | pure HSWM input bundle |
| `project` | source selector + projection options | semantic projection; no KG write |

For a native connection, the key inputs are:

```json
{ "connection": "game", "query": { "focus": "native:player", "target": "native:spec" } }
```

```json
{ "connection": "game", "options": { "links": ["native:implements:1"] } }
```

Tool options can narrow the startup allowlist and budgets but cannot expand
them. A missing policy starts deny-all, so `observe` returns denied rows and
makes no resolver calls.
