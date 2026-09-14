import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { fileConnectionResolver, parseMcpConfig, readMcpConfig } from "../src/mcp-config.js"
import { DEFAULT_USL_POLICY } from "../src/application.js"
import { startUslMcpServer } from "../src/mcp.js"
import { temporary } from "./fixtures.js"

const root = fileURLToPath(new URL("..", import.meta.url))
const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url))
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const graph = (description: string) => JSON.stringify({
  nodes: [
    { uid: "game:dash", properties: { locator: "file://fixture/dash.ts" } },
    { uid: "checkout:game", properties: { locator: "file://fixture/checkout.ts" } },
  ],
  relations: [{ uid: "game:implements", from_uid: "game:dash", to_uid: "checkout:game", type: "IMPLEMENTS", properties: { description } }],
})

const config = (graphPath: string, programPath = "navigation.usl") => JSON.stringify({
  allowedLocators: [], maxResources: 4, maxInputBytes: 1_048_576, maxOutputBytes: 1_048_576,
  programs: { navigation: programPath }, connections: { game: { graph: graphPath, namespace: "mcp.config.game", kgSource: "fixture-kg" } },
})

test("MCP config requires exact JSON fields and safe limits", () => {
  const base = "/configured"
  assert.throws(() => parseMcpConfig(JSON.stringify({ allowedLocators: [], maxResources: 1, maxInputBytes: 1, maxOutputBytes: 1, programs: {}, extra: true }), base), /unknown USL_MCP_POLICY field/)
  assert.throws(() => parseMcpConfig(JSON.stringify({ allowedLocators: [], maxResources: -1, maxInputBytes: 1, maxOutputBytes: 1, programs: {} }), base), /maxResources must be a nonnegative safe integer/)
  assert.throws(() => parseMcpConfig(JSON.stringify({ allowedLocators: [], maxResources: 1, maxInputBytes: 1, maxOutputBytes: 1, programs: null }), base), /programs must be an object/)
  assert.throws(() => parseMcpConfig(JSON.stringify({ allowedLocators: [], maxResources: 1, maxInputBytes: 1, maxOutputBytes: 1, programs: {}, connections: null }), base), /connections must be an object/)
})

test("file config resolves program and graph paths from its own directory and rejects an environment conflict", async (t) => {
  const dir = await temporary(t), nested = join(dir, "configured"), configPath = join(nested, "usl.config.json")
  await mkdir(nested)
  await writeFile(configPath, config("graphs/game.json", "programs/navigation.usl"))
  const loaded = await readMcpConfig(configPath, {})
  assert.equal(loaded.programs.navigation, join(nested, "programs/navigation.usl"))
  assert.equal(loaded.connections?.game?.graph, join(nested, "graphs/game.json"))
  await assert.rejects(readMcpConfig(configPath, { USL_MCP_POLICY: config("ignored.json") }), /choose --config or USL_MCP_POLICY/)
})

test("CLI MCP config reads a fresh configured graph, refuses an invalid newest graph, and treats connection as an ID", async (t) => {
  const dir = await temporary(t), configured = join(dir, "configured"), elsewhere = join(dir, "elsewhere")
  await mkdir(configured); await mkdir(elsewhere)
  const graphPath = join(configured, "game.json"), programPath = join(configured, "navigation.usl"), configPath = join(configured, "usl.config.json")
  await writeFile(graphPath, graph("first declaration"))
  await writeFile(programPath, 'usl "0.1";\nnamespace "mcp_navigation";\nresource a = "file://fixture/a";\n')
  await writeFile(configPath, config("game.json"))
  const client = new Client({ name: "usl-mcp-config-test", version: "1" })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [tsx, cli, "mcp", "--config", configPath], cwd: elsewhere, stderr: "pipe" }))
  t.after(() => client.close())
  const call = (connection = "game") => client.callTool({ name: "context", arguments: { connection, query: { focus: "game:dash", target: "checkout:game" }, compact: true } })
  const first = await call()
  assert.equal(first.isError, undefined)
  assert.match(JSON.stringify(first), /first declaration/)
  await writeFile(graphPath, graph("second declaration"))
  const second = await call()
  assert.equal(second.isError, undefined)
  assert.match(JSON.stringify(second), /second declaration/)
  await writeFile(graphPath, "{")
  const invalid = await call()
  assert.equal(invalid.isError, true)
  assert.match(JSON.stringify(invalid), /property-graph rawText must be JSON/)
  const unknown = await call("../game.json")
  assert.equal(unknown.isError, true)
  assert.match(JSON.stringify(unknown), /unknown connection/)
})

test("MCP config source itself is read with the startup byte bound", async (t) => {
  const dir = await temporary(t), configPath = join(dir, "large.config.json")
  const input = `${config("graph.json")}${" ".repeat(1_048_577)}`
  await writeFile(configPath, input)
  await assert.rejects(readMcpConfig(configPath, {}), /source exceeds maxInputBytes/)
  assert.equal((await readFile(configPath, "utf8")).length, input.length)
})

test("native file connections capture registration and bound each graph read", async (t) => {
  const dir = await temporary(t), file = join(dir, "game.json")
  await writeFile(file, graph("captured"))
  const registration = { game: { graph: file, namespace: "configured" } }
  const resolve = fileConnectionResolver(registration, 4096)
  registration.game.graph = join(dir, "missing.json")
  assert.equal((await resolve("game")).plan.namespace, "configured")
  await writeFile(file, " ".repeat(4097))
  await assert.rejects(resolve("game"), /source exceeds maxInputBytes/)
})

test("ambiguous or invalid MCP startup policy fails before opening program files", async () => {
  const programs = { missing: "/does-not-exist/program.usl" }
  await assert.rejects(startUslMcpServer({ programs, connections: {}, policy: {
    ...DEFAULT_USL_POLICY, getConnection: async () => { throw new Error("must not run") },
  } }), /either policy.getConnection or connections/)
  await assert.rejects(startUslMcpServer({ programs, policy: {
    ...DEFAULT_USL_POLICY, allowedLocators: ["not-a-locator"],
  } }), /invalid MCP policy/)
})
