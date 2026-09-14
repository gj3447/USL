# MCP server

For an existing native graph file, configure a fixed connection ID at server
startup. The server reads and adapts that file afresh for each request, without
a USL source file or registry entry. The included
[usl.config.json](../examples/usl.config.json) registers `game`; call `context`
with `{ "connection": "game", "query": { "focus": "game:dash", "target":
"checkout:game" }, "compact": true }`. `source`, `program`, and `connection`
are alternative inputs, so supply exactly one. Each native result envelope
contains `source`, `identities`, `result`, and a receipt binding their digests.
For a dynamic owner API rather than a fixed graph file, a host can still supply
`policy.getConnection`; [adapter-mcp.ts](../examples/adapter-mcp.ts) shows that
SDK integration. See [ADAPTER_INTEGRATION.md](ADAPTER_INTEGRATION.md).

USL provides a local stdio MCP server through `src/mcp.ts`. It uses the
official TypeScript MCP SDK v2 `McpServer` and `serveStdio` API. Start it with:

```sh
npx tsx src/mcp.ts
```

Start with a config file:

```sh
npx tsx src/mcp.ts --config examples/usl.config.json
# equivalently after building: usl-mcp --config examples/usl.config.json
```

Its top-level JSON object has these required fields and optional `connections`;
unknown fields are rejected:

```json
{
  "allowedLocators": ["file://host/approved/source.usl"],
  "maxResources": 16,
  "maxInputBytes": 1048576,
  "maxOutputBytes": 1048576,
  "programs": { "game": "game.usl" },
  "connections": {
    "game-graph": {
      "graph": "native-graph.json",
      "namespace": "game.graph",
      "kgSource": "game-kg"
    }
  }
}
```

`allowedLocators` is an array of valid locator strings. `maxResources`,
`maxInputBytes`, and `maxOutputBytes` are nonnegative safe integers.
`programs` maps IDs to `.usl` files; `connections` maps IDs to a
property-graph JSON file, namespace, and optional KG source. Every path is
relative to the config file's directory. This makes the example portable as a
directory: move it with its fixture files, or update the relative paths.

`USL_MCP_POLICY` supports the same shape for environments that cannot use a
file; its relative paths use the startup working directory. The config is read
once at startup. Do not set a nonempty `USL_MCP_POLICY` together with
`--config`; the server rejects that ambiguous launch. Without either, it uses
`DEFAULT_USL_POLICY`, no programs, and no connections.

`stdout` is the MCP JSON-RPC channel. Diagnostics are written only to `stderr`.
The server exposes `check`, `compile`, `context`, `observe`, `compare`,
`validate_observation`, `graph_import`, `hswm_prepare`, and `project`. Every
tool delegates to `executeUslOperation`, also used by the new offline CLI
commands. Existing CLI source commands use the same underlying language API.

The startup configuration fixes `allowedLocators`, `maxResources`,
`maxInputBytes`, and `maxOutputBytes`. A tool argument can request fewer
resources or bytes, but cannot expand an allowlist or a limit. The default
policy has an empty allowlist, so `observe` reads nothing until the launching
application supplies a concrete policy. Program IDs are resolved only by an
administrator-supplied registry callback; they are never interpreted as file
paths. The server has no tool for arbitrary filesystem paths, shell execution,
or KG writes.

`startUslMcpServer({ programs: { game: "/approved/game.usl" } })` opens an
administrator-owned ID-to-file registry once at startup. A client uses
`{ "program": "game" }`, never a path. The registry recompiles a changed file
before each use and atomically installs only a valid result. An invalid newest
edit is returned as an error and cannot be silently served as the prior
snapshot. Closing stdio or the returned server handle closes its file watchers.

`graph_import` accepts raw GraphSpec text and explicit USL bindings. It checks
document identity and produces declarations only; it does not execute graph
nodes. `hswm_prepare` prepares an argument bundle and does not contact HSWM.
`project` produces a projection only and does not write a KG.

The implementation follows the official [MCP TypeScript SDK v2 server guide](https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-server).

## Client launch configuration

The repository includes [mcp-client.json](../examples/mcp-client.json), a local
stdio launch example using this checkout's absolute paths, and
[mcp-adapter-client.json](../examples/mcp-adapter-client.json) for the same
server with the fixed native `game` connection. Adjust the three launcher paths
for a different checkout. Both start `src/mcp.ts` through Node and the installed
`tsx` runner, so no custom server TypeScript is required. Do not use ordinary
`npm run` as a client's stdio command: npm's banner shares stdout.
The `mcpServers` wrapper is a common client convention; use the equivalent
command/args/env fields required by your client.

The shared config registers `agent-navigation.usl` as `navigation`, a native
graph as `game`, and permits no endpoint reads. After connecting, send either:

```json
{
  "name": "context",
  "arguments": {
    "program": "navigation",
    "query": { "focus": "concept", "target": "checkout" },
    "compact": true
  }
}
```

```json
{
  "name": "context",
  "arguments": {
    "connection": "game",
    "query": { "focus": "game:dash", "target": "checkout:game" },
    "compact": true
  }
}
```

Only send `knownContextDigest` when the receiver still holds that exact context.
For real observation, the host must supply the concrete participant/grounding
locators it authorizes in `allowedLocators`, as well as resolver configuration.
Client tool arguments cannot grant those permissions. JSON inputs containing
inherited options or accessors are rejected by the shared API as well.

For an already-built installation, the package supplies `usl` and `usl-mcp`
executables (`node dist/src/cli.js` and `node dist/src/mcp.js`). Building the USL
TypeScript implementation is separate from updating a registered `.usl` file;
the latter refreshes automatically. This example does not modify any client's
global configuration.
