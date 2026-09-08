import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { readMcpConfigFromEnv } from "../src/mcp.js"

test("MCP startup policy is exact and defaults to deny-all with no programs", () => {
  const fallback = readMcpConfigFromEnv({})
  assert.deepEqual(fallback.policy?.allowedLocators, [])
  assert.deepEqual(fallback.programs, {})
  assert.throws(() => readMcpConfigFromEnv({ USL_MCP_POLICY: JSON.stringify({ allowedLocators: [], maxResources: 1, maxInputBytes: 1, maxOutputBytes: 1, programs: {}, extra: true }) }), /unknown USL_MCP_POLICY field/)
})

test("stdio MCP client lists tools and dispatches read-free compile", async () => {
  const server = fileURLToPath(new URL("../src/mcp.ts", import.meta.url))
  const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url))
  const transport = new StdioClientTransport({ command: process.execPath, args: [tsx, server], cwd: process.cwd(), stderr: "pipe" })
  const client = new Client({ name: "usl-mcp-test", version: "1.0.0" })
  await client.connect(transport)
  try {
    const listed = await client.listTools()
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["check", "compare", "compile", "context", "graph_import", "hswm_prepare", "observe", "project", "validate_observation"])
    const observe = listed.tools.find((tool) => tool.name === "observe")!
    const compile = listed.tools.find((tool) => tool.name === "compile")!
    assert.deepEqual(observe.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true })
    assert.deepEqual(compile.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
    const result = await client.callTool({ name: "compile", arguments: { source: 'usl "0.1";\nnamespace "mcp_test";\nresource code = "file://fixture/tmp.ts";\n' } })
    assert.equal(result.isError, undefined)
    const body = JSON.parse((result.content[0] as { readonly text: string }).text)
    assert.equal(body.namespace, "mcp_test")
  } finally { await client.close() }
})

test("MCP default observe policy cannot be expanded by a client", async () => {
  const server = fileURLToPath(new URL("../src/mcp.ts", import.meta.url))
  const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url))
  const client = new Client({ name: "usl-mcp-test", version: "1.0.0" })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [tsx, server], cwd: process.cwd(), stderr: "pipe" }))
  try {
    const result = await client.callTool({ name: "observe", arguments: { source: 'usl "0.1";\nnamespace "mcp_deny";\nresource code = "file://fixture/tmp.ts";\n', options: { allowedLocators: ["file://fixture/tmp.ts"] } } })
    assert.equal(result.isError, true)
    assert.match((result.content[0] as { readonly text: string }).text, /expand the server read allowlist/)
  } finally { await client.close() }
})

const registeredSource = (description: string) => `usl "0.1";
namespace "registered_program";
resource source = "file://fixture/source.ts";
resource concept = "kg://canonical-neo4j/sym:Concept:registered";
meaning implements(from: filesystem, to: kg) = "${description}";
link implementation = implements(from: source, to: concept);
`

test("a configured program ID refreshes on valid edits and refuses an invalid newest edit", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "usl-mcp-program-"))
  const program = join(dir, "registered.usl")
  await writeFile(program, registeredSource("first contract"))
  const server = fileURLToPath(new URL("./mcp-program-server.ts", import.meta.url))
  const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url))
  const client = new Client({ name: "usl-mcp-program-test", version: "1.0.0" })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [tsx, server, program], cwd: process.cwd(), stderr: "pipe" }))
  t.after(async () => { await client.close(); await rm(dir, { recursive: true, force: true }) })
  const call = async (name: "check" | "context") => client.callTool({ name, arguments: name === "check" ? { program: "registered" } : { program: "registered", query: { focus: "source" } } })
  const pathAttempt = await client.callTool({ name: "check", arguments: { program } })
  assert.equal(pathAttempt.isError, true)
  assert.match((pathAttempt.content[0] as { readonly text: string }).text, /unknown registered program/)
  const before = await call("check")
  const beforeBody = JSON.parse((before.content[0] as { readonly text: string }).text)
  const beforeContext = await call("context")
  assert.match(JSON.stringify(beforeContext), /first contract/)
  await writeFile(program, registeredSource("second contract"))
  const after = await call("check")
  const afterBody = JSON.parse((after.content[0] as { readonly text: string }).text)
  const afterContext = await call("context")
  assert.notEqual(afterBody.sourceDigest, beforeBody.sourceDigest)
  assert.match(JSON.stringify(afterContext), /second contract/)
  await writeFile(program, "usl \"0.1\"; broken")
  const invalid = await call("check")
  assert.equal(invalid.isError, true)
  assert.match((invalid.content[0] as { readonly text: string }).text, /invalid edit/)
})

test("MCP starts when its entrypoint is invoked through a package-bin symlink", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usl-mcp-bin-"))
  const entrypoint = join(dir, "usl-mcp.ts")
  const client = new Client({ name: "usl-bin-test", version: "1.0.0" })
  try {
    await symlink(fileURLToPath(new URL("../src/mcp.ts", import.meta.url)), entrypoint)
    const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url))
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [tsx, entrypoint], stderr: "pipe" }))
    assert.equal((await client.listTools()).tools.length, 9)
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }) }
})
