# MCP server

USL provides a local stdio MCP server through `src/mcp.ts`. It uses the
official TypeScript MCP SDK v2 `McpServer` and `serveStdio` API. Start it with:

```sh
npx tsx src/mcp.ts
```

At startup, `USL_MCP_POLICY` may contain this exact JSON object; unknown or
missing fields are rejected:

```json
{
  "allowedLocators": ["file://host/approved/source.usl"],
  "maxResources": 16,
  "maxInputBytes": 1048576,
  "maxOutputBytes": 1048576,
  "programs": { "game": "/approved/game.usl" }
}
```

If it is absent, the server uses `DEFAULT_USL_POLICY` and no registered
programs. This environment value is read only at startup.

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

The implementation follows the official [MCP server guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md), [stdio guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/stdio.md), and [TypeScript package guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/get-started/packages.md).

## Client launch configuration

The repository includes [mcp-client.json](../examples/mcp-client.json), a local
stdio launch example using this checkout's absolute paths. Adjust paths for a
different machine. It starts directly through Node and the installed `tsx`
runner, so no build step is required for this development checkout. Do not use
ordinary `npm run` as a client's stdio command: npm's banner shares stdout.
The `mcpServers` wrapper is a common client convention; use the equivalent
command/args/env fields required by your client.

The example registers `examples/agent-navigation.usl` as `navigation` and
permits no endpoint reads. After connecting, send:

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
