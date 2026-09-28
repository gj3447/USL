import assert from "node:assert/strict"
import { test } from "node:test"
import { chmod, mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { contractDigest } from "../src/contract-core.js"
import { digestSource } from "../src/language/digest.js"
import { graphEngineeringDigest } from "../src/integrations/graph-engineering.js"
import { executeCliAction, planCliAction } from "../src/cli-host.js"
import { temporary } from "./fixtures.js"

const pin = (text: string) => digestSource(text)
const sign = (graph: any) => {
  graph.identity.topology_sha256 = graphEngineeringDigest(graph.topology)
  const machine = structuredClone(graph.lifecycle); delete machine.machine_sha256
  graph.lifecycle.machine_sha256 = graphEngineeringDigest(machine)
  graph.identity.lifecycle_sha256 = graphEngineeringDigest(graph.lifecycle)
  graph.identity.loop_policy_sha256 = graphEngineeringDigest(graph.loop)
  graph.identity.effect_policy_sha256 = graphEngineeringDigest(graph.effects)
  const unsigned = structuredClone(graph); delete unsigned.identity.graphspec_sha256
  graph.identity.graphspec_sha256 = graphEngineeringDigest(unsigned)
}

const setup = async (t: Parameters<typeof temporary>[0], mode: "normal" | "result-conflict" = "normal") => {
  const base = await temporary(t), workspace = join(base, "workspace")
  await mkdir(workspace)
  const executable = join(workspace, "runner")
  const marker = join(workspace, "marker")
  const normal = `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nprintf '{"ok":true}'\n`
  const conflict = "#!/bin/sh\nprintf child > \"$USL_TEST_RECEIPT/result.json\"\nprintf '{\"ok\":true}'\n"
  await writeFile(executable, mode === "normal" ? normal : conflict)
  await chmod(executable, 0o700)
  const support = join(workspace, "support.txt"); await writeFile(support, "pinned support\n")
  const graph: any = { apiVersion: "symposium.graphspec/v0alpha1", kind: "GraphSpec", metadata: { graph_id: "boundaries", graph_version: "1" }, authority: {}, identity: { canonicalizer: "jcs-like-json-v1;graphspec_sha256-omitted" }, topology: { entry_nodes: ["run"], nodes: [{ id: "run", type: "code" }], edges: [] }, lifecycle: { machine_sha256: "" }, loop: {}, effects: {}, evidence: {} }
  sign(graph)
  const graphText = JSON.stringify(graph), graphFile = join(workspace, "graph.json"); await writeFile(graphFile, graphText)
  const bindings = { schema: "usl-resource-bindings/v1", resources: [
    { id: "graph", representations: [{ id: "graph-local", relation: "working-copy", kind: "workspace", workspace: "ws", path: "graph.json" }] },
    { id: "support", representations: [{ id: "support-local", relation: "working-copy", kind: "workspace", workspace: "ws", path: "support.txt" }] },
    { id: "cwd", representations: [{ id: "cwd-local", relation: "working-copy", kind: "workspace", workspace: "ws", path: "." }] },
  ] }
  const bindingsFile = join(base, "bindings.json"); await writeFile(bindingsFile, JSON.stringify(bindings))
  const descriptor: any = { schema: "usl-capability/v1", id: "run", version: "1", connection: "boundary", nativeOperation: "runner", sourceDigest: `sha256:${"a".repeat(64)}`,
    kind: "ACTION", effect: "WRITE", meanings: ["urn:boundary:run"], requiredScopes: ["run"], input: { types: ["urn:boundary:Input"], schema: true },
    output: { types: ["urn:boundary:Output"], schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } }, mapping: { completeness: "COMPLETE", losses: [], unsupported: [] } }
  const policy = { connection: descriptor.connection, capabilityId: descriptor.id, descriptorDigest: contractDigest(descriptor), sourceDigest: descriptor.sourceDigest,
    allowedEffects: ["WRITE"], allowedScopes: ["run"], allowLossy: false, maxInputBytes: 4096, maxOutputBytes: 4096, timeoutMs: 2_000 }
  const config: any = { schema: "usl-cli-host/v1", bindings: "bindings.json", workspaces: { ws: workspace }, maxSourceBytes: 65_536,
    actions: [{ id: "run", descriptor, policy, graph: { source: { resource: "graph", representation: "graph-local" }, sourceDigest: pin(graphText), graphId: "boundaries", graphspecDigest: graph.identity.graphspec_sha256, node: "run", scope: "ENTRY_NODE_ONLY" },
      cwd: { resource: "cwd", representation: "cwd-local" }, command: { executable: { path: executable }, args: [], envAllowlist: mode === "result-conflict" ? ["USL_TEST_RECEIPT"] : [] },
      pins: [{ source: { resource: "support", representation: "support-local" }, digest: pin("pinned support\n") }] }] }
  const configFile = join(base, "host.json"); await writeFile(configFile, JSON.stringify(config))
  const request = { descriptorDigest: policy.descriptorDigest, sourceDigest: descriptor.sourceDigest, input: { types: ["urn:boundary:Input"], value: {} } }
  return { base, executable, marker, configFile, request }
}

test("an executable byte change with the same size and mtime invalidates a prior plan", async t => {
  const f = await setup(t)
  const fixed = new Date("2024-01-01T00:00:00.000Z")
  await utimes(f.executable, fixed, fixed)
  const before = await stat(f.executable), plan: any = await planCliAction(f.configFile, "run", f.request)
  const original = await readFile(f.executable, "utf8")
  const changed = original.replace("printf ran", "printf bad")
  assert.equal(Buffer.byteLength(changed), Buffer.byteLength(original))
  await writeFile(f.executable, changed); await chmod(f.executable, 0o700); await utimes(f.executable, fixed, fixed)
  const after = await stat(f.executable), current: any = await planCliAction(f.configFile, "run", f.request)
  assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs)
  assert.equal(current.status, "READY"); assert.notEqual(current.planDigest, plan.planDigest)
})

test("a pre-aborted request does not create an attempt or run the child", async t => {
  const f = await setup(t), plan: any = await planCliAction(f.configFile, "run", f.request)
  const controller = new AbortController(); controller.abort()
  const receipt: any = await executeCliAction(f.configFile, "run", f.request, plan.planDigest, join(f.base, "receipt"), { signal: controller.signal })
  assert.equal(receipt.status, "REJECTED"); assert.equal(receipt.attempts, 0); assert.equal(receipt.reason, "ABORTED")
  await assert.rejects(readFile(f.marker)); await assert.rejects(readFile(join(f.base, "receipt", "intent.json")))
})

test("a post-effect result receipt collision returns a structured indeterminate outcome with durable intent", async t => {
  const f = await setup(t, "result-conflict"), receiptDir = join(f.base, "receipt")
  const previous = process.env.USL_TEST_RECEIPT
  process.env.USL_TEST_RECEIPT = receiptDir
  try {
    const plan: any = await planCliAction(f.configFile, "run", f.request)
    const receipt: any = await executeCliAction(f.configFile, "run", f.request, plan.planDigest, receiptDir)
    assert.equal(receipt.status, "INDETERMINATE"); assert.equal(receipt.reason, "RECEIPT_WRITE_FAILED"); assert.equal(receipt.receiptPersisted, false)
    const intent: any = JSON.parse(await readFile(join(receiptDir, "intent.json"), "utf8"))
    assert.equal(intent.attempt, receipt.attempt); assert.equal(intent.intentDigest, receipt.intentDigest)
    assert.equal(await readFile(join(receiptDir, "result.json"), "utf8"), "child")
  } finally {
    if (previous === undefined) delete process.env.USL_TEST_RECEIPT
    else process.env.USL_TEST_RECEIPT = previous
  }
})
