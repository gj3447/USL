import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, readFile, writeFile, rename, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { contractDigest } from "../src/contract-core.js"
import { digestSource } from "../src/language/digest.js"
import { executeCliAction, planCliAction, type CliHostConfig } from "../src/cli-host.js"
import { inspectCliAttempt } from "../src/cli-recovery.js"
import { temporary } from "./fixtures.js"

const run = promisify(execFile)
const setup = async (t: Parameters<typeof temporary>[0]) => {
  const base = await temporary(t), project = join(base, "project")
  await mkdir(project)
  const script = "import {appendFileSync} from 'node:fs'; appendFileSync('runs', 'ran\\n'); console.log(JSON.stringify({ok:true}));"
  await writeFile(join(project, "run.mjs"), script)
  const graph = await readFile("examples/fixtures/cli/graphspec.json", "utf8")
  await writeFile(join(project, "graph.json"), graph)
  await writeFile(join(base, "bindings.json"), JSON.stringify({ schema: "usl-resource-bindings/v1", resources:
    [["graph", "graph.json"], ["runner", "run.mjs"], ["cwd", "."]].map(([id, path]) => ({ id,
      representations: [{ id: `${id}-local`, relation: "working-copy", kind: "workspace", workspace: "project", path }] })) }))
  const sourceDigest = digestSource("operation descriptor")
  const descriptor: CliHostConfig["actions"][number]["descriptor"] = {
    schema: "usl-capability/v1", id: "run", version: "1", connection: "fixture", nativeOperation: "run", sourceDigest,
    kind: "ACTION", effect: "WRITE", meanings: ["urn:test:run"], requiredScopes: ["run"],
    input: { types: ["urn:test:Input"], schema: true }, output: { types: ["urn:test:Output"], schema: { type: "object", required: ["ok"], properties: { ok: { const: true } }, additionalProperties: false } },
    mapping: { completeness: "COMPLETE", losses: [], unsupported: [] },
  }
  const descriptorDigest = contractDigest(descriptor)
  const config: CliHostConfig = { schema: "usl-cli-host/v1", bindings: "bindings.json", workspaces: { project }, maxSourceBytes: 65536,
    operations: { namespace: "fixture-operations", directory: "operations" },
    actions: [{ id: "run", descriptor, policy: { connection: "fixture", capabilityId: "run", descriptorDigest, sourceDigest,
      allowedEffects: ["WRITE"], allowedScopes: ["run"], allowLossy: false, maxInputBytes: 4096, maxOutputBytes: 4096, timeoutMs: 3000 },
      graph: { source: { resource: "graph", representation: "graph-local" }, sourceDigest: digestSource(graph),
        graphId: "usl.cli.example", graphspecDigest: JSON.parse(graph).identity.graphspec_sha256, node: "usl_check", scope: "ENTRY_NODE_ONLY" },
      cwd: { resource: "cwd", representation: "cwd-local" }, command: { executable: "node", args: [{ resource: "runner", representation: "runner-local" }], envAllowlist: [] },
      pins: [{ source: { resource: "runner", representation: "runner-local" }, digest: digestSource(script) }] }] }
  const configFile = join(base, "host.json")
  await writeFile(configFile, JSON.stringify(config))
  const request = { descriptorDigest, sourceDigest, input: { types: ["urn:test:Input"], value: { target: "one" } } }
  const plan = await planCliAction(configFile, "run", request)
  assert.equal(plan.status, "READY")
  return { base, project, config, configFile, request, plan }
}

test("operation keys block duplicate and conflicting effects, including concurrent requests", async t => {
  const f = await setup(t)
  const missing = await executeCliAction(f.configFile, "run", f.request, f.plan.planDigest, join(f.base, "missing"))
  assert.equal(missing.reason, "OPERATION_KEY_REQUIRED")
  const results = await Promise.all(["one", "two"].map(name => executeCliAction(f.configFile, "run", f.request, f.plan.planDigest, join(f.base, name), { operationKey: "logical:one" })))
  assert.equal(results.filter(result => result.status === "SUCCEEDED").length, 1)
  assert.equal(results.filter(result => result.status === "REJECTED" && result.attempts === 0).length, 1)
  assert.equal(await readFile(join(f.project, "runs"), "utf8"), "ran\n")
  const duplicate = await executeCliAction(f.configFile, "run", f.request, f.plan.planDigest, join(f.base, "duplicate"), { operationKey: "logical:one" })
  assert.equal(duplicate.reason, "OPERATION_ALREADY_RESERVED")
  const request = { ...f.request, input: { ...f.request.input, value: { target: "two" } } }
  const other = await planCliAction(f.configFile, "run", request)
  const conflict = await executeCliAction(f.configFile, "run", request, other.planDigest, join(f.base, "conflict"), { operationKey: "logical:one" })
  assert.equal(conflict.reason, "OPERATION_KEY_CONFLICT")
  const inspected = await inspectCliAttempt(join(f.base, "conflict"))
  assert.equal(inspected.recordedStatus, "REJECTED")
})

test("moving a workspace changes the plan while retaining logical operation identity", async t => {
  const f = await setup(t)
  const first = await executeCliAction(f.configFile, "run", f.request, f.plan.planDigest, join(f.base, "first"), { operationKey: "move-test" })
  assert.equal(first.status, "SUCCEEDED")
  const moved = join(f.base, "moved")
  await rename(f.project, moved); f.config.workspaces.project = moved
  await writeFile(f.configFile, JSON.stringify(f.config))
  const second = await planCliAction(f.configFile, "run", f.request)
  assert.equal(second.status, "READY"); assert.notEqual(second.planDigest, f.plan.planDigest)
  if (second.status !== "READY" || f.plan.status !== "READY") throw new Error("ready plan required")
  assert.equal(second.operation?.semanticDigest, f.plan.operation?.semanticDigest)
  const result = await executeCliAction(f.configFile, "run", f.request, second.planDigest, join(f.base, "second"), { operationKey: "move-test" })
  assert.equal(result.reason, "OPERATION_ALREADY_RESERVED")
  assert.equal(await readFile(join(moved, "runs"), "utf8"), "ran\n")
})

test("an incomplete reservation left by interruption remains blocked", async t => {
  const f = await setup(t)
  await executeCliAction(f.configFile, "run", f.request, f.plan.planDigest, join(f.base, "first"), { operationKey: "interrupted" })
  const [reservation] = await readdir(join(f.base, "operations"))
  await rm(join(f.base, "operations", reservation!, "reservation.json"))
  const result = await executeCliAction(f.configFile, "run", f.request, f.plan.planDigest, join(f.base, "second"), { operationKey: "interrupted" })
  assert.equal(result.reason, "OPERATION_RESERVATION_UNKNOWN")
  assert.equal(await readFile(join(f.project, "runs"), "utf8"), "ran\n")
})

test("CLI exposes binding inspection, operation keys and historical receipt inspection", async t => {
  const f = await setup(t), cli = join(process.cwd(), "src/cli.ts")
  const execute = (...args: string[]) => run(process.execPath, ["--import", "tsx", cli, ...args], { maxBuffer: 1024 * 1024 })
  const inspected = JSON.parse((await execute("inspect-binding", "--config", f.configFile, "--resource", "runner", "--representation", "runner-local")).stdout)
  assert.equal(inspected.resource, "runner"); assert.equal(inspected.content.kind, "file")
  const input = join(f.base, "request.json"); await writeFile(input, JSON.stringify(f.request))
  const receiptDir = join(f.base, "cli")
  const result = JSON.parse((await execute("cli-run", "--config", f.configFile, "--action", "run", "--input", input,
    "--expected-plan", f.plan.planDigest, "--receipt-dir", receiptDir, "--operation-key", "via-cli")).stdout)
  assert.equal(result.status, "SUCCEEDED"); assert.equal(result.lifecycle.phase, "SUCCEEDED")
  const receipt = JSON.parse((await execute("cli-inspect", "--receipt-dir", receiptDir)).stdout)
  assert.equal(receipt.recordedStatus, "SUCCEEDED"); assert.equal(receipt.externalEffect, "UNKNOWN")
})
