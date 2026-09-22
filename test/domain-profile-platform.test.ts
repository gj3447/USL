import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { writeFile, readFile, symlink } from "node:fs/promises"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { temporary } from "./fixtures.js"
import { engineeringFixture } from "./engineering-adversarial-cases.js"

const root = fileURLToPath(new URL("..", import.meta.url)), run = promisify(execFile)
const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)), cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
test("CLI profile is enforced on check and JSON-LD, and cannot overwrite the profile through an alias", async t => {
  const dir = await temporary(t), graphFile = join(dir, "graph.json"), profileFile = join(dir, "profile.json")
  const { graph, profile } = engineeringFixture(), encoded = JSON.stringify(profile)
  await writeFile(graphFile, JSON.stringify(graph)); await writeFile(profileFile, encoded)
  const args = [tsx, cli, "adapt", "--format", "resource-graph", "--graph", graphFile, "--profile", profileFile, "--namespace", "profile.cli"]
  const valid = await run(process.execPath, [...args, "--operation", "check"], { cwd: root })
  assert.equal(JSON.parse(valid.stdout).result.valid, true)
  const alias = join(dir, "alias.json"); await symlink(profileFile, alias)
  await assert.rejects(run(process.execPath, [...args, "--operation", "jsonld", "--out", alias]), /--out must differ from --profile/)
  assert.equal(await readFile(profileFile, "utf8"), encoded)
  graph.resources[0]!.types = ["urn:test:Wrong"]
  await writeFile(graphFile, JSON.stringify(graph))
  for (const operation of ["check", "jsonld"]) await assert.rejects(run(process.execPath, [...args, "--operation", operation]), /ROLE_TYPE/)
})

test("real MCP enforces host-selected profile, refuses changed constraints and rejects caller profile injection", async t => {
  const dir = await temporary(t), graphFile = join(dir, "graph.json"), profileFile = join(dir, "profile.json"), configFile = join(dir, "config.json")
  const { graph, profile } = engineeringFixture()
  await writeFile(graphFile, JSON.stringify(graph)); await writeFile(profileFile, JSON.stringify(profile))
  await writeFile(configFile, JSON.stringify({ programs: {}, allowedLocators: [], maxResources: 16, maxInputBytes: 1048576, maxOutputBytes: 1048576,
    connections: { review: { graph: "graph.json", profile: "profile.json", format: "resource-graph", namespace: "profile.mcp" } } }))
  const client = new Client({ name: "profile-contract-test", version: "1" })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [tsx, cli, "mcp", "--config", configFile], cwd: root, stderr: "pipe" }))
  t.after(() => client.close())
  assert.equal((await client.callTool({ name: "check", arguments: { connection: "review" } })).isError, undefined)
  assert.equal((await client.callTool({ name: "check", arguments: { connection: "review", profile: {} } })).isError, true)
  profile.meanings[0]!.roles[0]!.metadata[0]!.equals = "new-revision"
  await writeFile(profileFile, JSON.stringify(profile))
  const invalid = await client.callTool({ name: "check", arguments: { connection: "review" } })
  assert.equal(invalid.isError, true); assert.match(JSON.stringify(invalid), /METADATA_MISMATCH/)
})
