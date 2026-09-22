import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { readFile, symlink, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { promisify } from "node:util"
import { test } from "node:test"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { DEFAULT_USL_POLICY, executeUslOperation, type UslOperationPolicy } from "../src/application.js"
import type { CapabilityCatalog } from "../src/capability-catalog.js"
import { capabilityFixture } from "./engineering-adversarial-cases.js"
import { temporary } from "./fixtures.js"

const root = fileURLToPath(new URL("..", import.meta.url))
const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url))
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const run = promisify(execFile)

const catalog = (entries: CapabilityCatalog["entries"], complete = true): CapabilityCatalog => ({ schema: "usl-capability-catalog/v1", complete, entries })
const configuredCatalog = () => {
  const { descriptor, policy, request } = capabilityFixture()
  return { catalog: catalog([{ descriptor, policy }]), request }
}
const discover = { meaning: "urn:test:read", maxResults: 1, maxInspected: 1 }
const content = (result: any) => {
  const block = result.content.find((entry: any) => entry.type === "text")
  return JSON.parse(block.text)
}

test("capability application rejects untrusted shape, limit expansion and policy injection before catalog lookup", async () => {
  let calls = 0
  const { catalog: registered, request } = configuredCatalog()
  const policy: UslOperationPolicy = {
    ...DEFAULT_USL_POLICY,
    maxResources: 1,
    getCapabilityCatalog: async id => { calls++; assert.equal(id, "demo"); return registered },
  }
  await assert.rejects(executeUslOperation("capability_discover", { catalog: "demo", query: { ...discover, extra: true } }, policy), /unknown|unrecognized/i)
  await assert.rejects(executeUslOperation("capability_discover", { catalog: "demo", query: { ...discover, maxResults: 2 } }, policy), /capability query exceeds server maxResources/)
  await assert.rejects(executeUslOperation("capability_discover", { catalog: "demo", query: { ...discover, maxInspected: 2 } }, policy), /capability query exceeds server maxResources/)
  await assert.rejects(executeUslOperation("capability_preflight", {
    catalog: "demo", selection: { connection: "owner", capability: "read", invocation: request, policy: { allowedEffects: ["WRITE"] } },
  }, policy), /unknown input field|unknown|unrecognized/i)
  assert.equal(calls, 0)
})

test("capability application is catalog-owned, bounded and read-only", async () => {
  let calls = 0
  const { catalog: registered, request } = configuredCatalog()
  const policy: UslOperationPolicy = {
    ...DEFAULT_USL_POLICY,
    maxResources: 1,
    getCapabilityCatalog: async () => { calls++; return registered },
  }
  const found = await executeUslOperation("capability_discover", { catalog: "demo", query: discover }, policy) as any
  assert.equal(found.status, "FOUND")
  assert.equal(found.matches.length, 1)
  assert.equal(found.matches[0].descriptor.id, "read")
  assert.equal("policy" in found.matches[0], false)
  const ready = await executeUslOperation("capability_preflight", {
    catalog: "demo", selection: { connection: "owner", capability: "read", invocation: request },
  }, policy) as any
  assert.equal(ready.status, "READY")
  assert.equal(ready.execution, "NOT_EXECUTED")
  await assert.rejects(executeUslOperation("capability_preflight", {
    catalog: "demo", selection: { connection: "owner", capability: "read", invocation: { ...request, descriptor: registered.entries[0]!.descriptor } },
  }, policy), /unknown|unrecognized/i)
  assert.equal(calls, 2)
  await assert.rejects(executeUslOperation("capability_discover", { catalog: "demo", query: discover }, DEFAULT_USL_POLICY), /capability catalogs are not configured/)
})

test("file-configured catalogs are fresh for MCP and CLI, with registered input/output protection", async t => {
  const dir = await temporary(t)
  const catalogFile = join(dir, "catalog.json"), configFile = join(dir, "usl.json"), requestFile = join(dir, "request.json")
  const alias = join(dir, "catalog-alias.json")
  const { catalog: registered, request } = configuredCatalog()
  const configuration = { programs: {}, allowedLocators: [], maxResources: 1, maxInputBytes: 1048576, maxOutputBytes: 1048576,
    capabilityCatalogs: { demo: "catalog.json" } }
  await writeFile(catalogFile, JSON.stringify(registered)); await writeFile(configFile, JSON.stringify(configuration))
  await writeFile(requestFile, JSON.stringify({ catalog: "demo", query: discover }))
  await symlink(catalogFile, alias)

  const client = new Client({ name: "capability-platform-test", version: "1" })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [tsx, cli, "mcp", "--config", configFile], cwd: root, stderr: "pipe" }))
  t.after(() => client.close())
  const tools = await client.listTools()
  assert.ok(tools.tools.some(tool => tool.name === "capability_discover"))
  assert.ok(tools.tools.some(tool => tool.name === "capability_preflight"))
  assert.equal(tools.tools.some(tool => /invoke|execute/i.test(tool.name)), false)
  const discovered = await client.callTool({ name: "capability_discover", arguments: { catalog: "demo", query: discover } })
  assert.equal(discovered.isError, undefined); assert.equal(content(discovered).status, "FOUND")
  const preflight = await client.callTool({ name: "capability_preflight", arguments: { catalog: "demo", selection: { connection: "owner", capability: "read", invocation: request } } })
  assert.equal(preflight.isError, undefined); assert.equal(content(preflight).status, "READY")

  const cliDiscover = await run(process.execPath, [tsx, cli, "capability-discover", "--config", configFile, "--input", requestFile], { cwd: root })
  assert.equal(JSON.parse(cliDiscover.stdout).status, "FOUND")
  const preflightFile = join(dir, "preflight.json")
  await writeFile(preflightFile, JSON.stringify({ catalog: "demo", selection: { connection: "owner", capability: "read", invocation: request } }))
  const cliPreflight = await run(process.execPath, [tsx, cli, "capability-preflight", "--config", configFile, "--input", preflightFile], { cwd: root })
  assert.equal(JSON.parse(cliPreflight.stdout).status, "READY")
  await assert.rejects(run(process.execPath, [tsx, cli, "capability-discover", "--config", configFile, "--input", requestFile, "--out", configFile], { cwd: root }), /--out must differ/)
  await assert.rejects(run(process.execPath, [tsx, cli, "capability-discover", "--config", configFile, "--input", requestFile, "--out", requestFile], { cwd: root }), /--out must differ/)
  await assert.rejects(run(process.execPath, [tsx, cli, "capability-discover", "--config", configFile, "--input", requestFile, "--out", alias], { cwd: root }), /--out must differ/)
  assert.equal(await readFile(catalogFile, "utf8"), JSON.stringify(registered))

  const changed = structuredClone(registered) as any
  changed.entries[0].policy.allowedScopes = []
  await writeFile(catalogFile, JSON.stringify(changed))
  const rejected = await client.callTool({ name: "capability_preflight", arguments: { catalog: "demo", selection: { connection: "owner", capability: "read", invocation: request } } })
  assert.equal(rejected.isError, undefined); assert.equal(content(rejected).status, "REJECTED")
  changed.entries[0].descriptor.version = "2"
  await writeFile(catalogFile, JSON.stringify(changed))
  const stale = await client.callTool({ name: "capability_preflight", arguments: { catalog: "demo", selection: { connection: "owner", capability: "read", invocation: request } } })
  assert.equal(stale.isError, true); assert.match(JSON.stringify(stale), /descriptor pin differs/)
})

test("MCP hides capability tools when no administrator catalog resolver exists", async t => {
  const client = new Client({ name: "capability-default-test", version: "1" })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [tsx, cli, "mcp"], cwd: root, stderr: "pipe" }))
  t.after(() => client.close())
  const tools = await client.listTools()
  assert.equal(tools.tools.length, 9)
  assert.equal(tools.tools.some(tool => tool.name === "capability_discover" || tool.name === "capability_preflight"), false)
})
