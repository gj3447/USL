import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { readFile } from "node:fs/promises"
import { Either } from "effect"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { parseMcpConfig } from "../src/mcp-config.js"
import { adaptResourceGraph } from "../src/integrations/resource-graph.js"
import { sourceFromPlan } from "../src/language/code.js"
import { compileSource } from "../src/language/compiler.js"
import { planDigest } from "../src/language/digest.js"

const root = fileURLToPath(new URL("..", import.meta.url))
const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url))
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const run = promisify(execFile)
const args = [tsx, cli, "adapt", "--format", "resource-graph", "--graph", "examples/fixtures/resource-graph.json", "--namespace", "example"]

test("new resource graph CLI emits JSON-LD, navigates native IDs and rejects protocol confusion", async () => {
  const jsonld = await run(process.execPath, [...args, "--operation", "jsonld"], { cwd: root })
  assert.ok(JSON.parse(jsonld.stdout)["@graph"].length > 14)
  const context = await run(process.execPath, [...args, "--operation", "context", "--focus", "example:spec", "--target", "example:proof"], { cwd: root })
  assert.equal(JSON.parse(context.stdout).result.target.status, "FOUND")
  await assert.rejects(run(process.execPath, [...args, "--kg-source", "invented"], { cwd: root }), /explicit locators/)
})

test("resource graph runs through real stdio MCP with host-selected format", async t => {
  const client = new Client({ name: "resource-graph-test", version: "1" })
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [tsx, cli, "mcp", "--config", "examples/usl.config.json"], cwd: root, stderr: "pipe" }))
  t.after(() => client.close())
  const context = await client.callTool({ name: "context", arguments: {
    connection: "resources", query: { focus: "example:spec", target: "example:proof" }, compact: true,
  } })
  assert.equal(context.isError, undefined)
  assert.match(JSON.stringify(context), /FOUND/)
  const config = JSON.parse(await readFile(new URL("../examples/usl.config.json", import.meta.url), "utf8"))
  config.connections.resources.format = "sql"
  assert.throws(() => parseMcpConfig(JSON.stringify(config), root), /invalid connection format/)
})

test("unary descriptors and n-ary links round-trip through the existing USL grammar", async () => {
  const raw = await readFile(new URL("../examples/fixtures/resource-graph.json", import.meta.url), "utf8")
  const graph = Either.getOrThrowWith(adaptResourceGraph(raw, { namespace: "roundtrip" }), error => error)
  const source = Either.getOrThrowWith(sourceFromPlan(graph.plan), error => error)
  const rebuilt = Either.getOrThrowWith(compileSource(source), error => error)
  assert.equal(planDigest(graph.plan), planDigest(rebuilt))
  assert.ok(graph.plan.links.some(link => link.participants.length === 1))
  assert.ok(Either.isLeft(compileSource('usl "0.1"; namespace "invalid"; meaning empty() = "invalid";')))
})
