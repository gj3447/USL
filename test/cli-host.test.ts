import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, readFile, writeFile, access, cp } from "node:fs/promises"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { contractDigest } from "../src/contract-core.js"
import { digestSource } from "../src/language/digest.js"
import { graphEngineeringDigest } from "../src/integrations/graph-engineering.js"
import { executeCliAction, planCliAction } from "../src/cli-host.js"
import { temporary } from "./fixtures.js"

const exec = promisify(execFile)
const pin = (text: string) => `sha256:${digestSource(text).replace(/^sha256:/, "")}`
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

const setup = async (t: Parameters<typeof temporary>[0], mode = "ok") => {
  const base = await temporary(t), project = join(base, "project"), fixtures = join(project, "fixtures")
  await mkdir(fixtures, { recursive: true })
  const script = join(fixtures, "runner.mjs"), marker = join(fixtures, "marker.txt")
  const code = mode === "bad-json" ? "process.stdout.write('not-json')" : mode === "wrong-schema" ? "process.stdout.write(JSON.stringify({wrong:true}))" : mode === "mutate" ?
    "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[1], 'process.stdout.write(JSON.stringify({ok:true}))'); process.stdout.write(JSON.stringify({ok:true}))" :
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdout.write(JSON.stringify({ok:true}))`
  await writeFile(script, code)
  const graph: any = { apiVersion: "symposium.graphspec/v0alpha1", kind: "GraphSpec", metadata: { graph_id: "cli.fixture", graph_version: "1" }, authority: {}, identity: { canonicalizer: "jcs-like-json-v1;graphspec_sha256-omitted" }, topology: { entry_nodes: ["run"], nodes: [{ id: "run", type: "code" }], edges: [] }, lifecycle: { machine_sha256: "" }, loop: {}, effects: {}, evidence: {} }
  sign(graph); const graphText = JSON.stringify(graph); await writeFile(join(fixtures, "graph.json"), graphText)
  const bindings = { schema: "usl-resource-bindings/v1", resources: [
    { id: "graph", representations: [{ id: "graph-local", relation: "working-copy", kind: "workspace", workspace: "project", path: "fixtures/graph.json" }] },
    { id: "runner", representations: [{ id: "runner-local", relation: "working-copy", kind: "workspace", workspace: "project", path: "fixtures/runner.mjs" }, { id: "runner-github", relation: "snapshot", kind: "locator", locator: "https://github.com/example/runner/blob/main/runner.mjs" }] },
    { id: "cwd", representations: [{ id: "cwd-local", relation: "working-copy", kind: "workspace", workspace: "project", path: "." }] },
  ] }
  await writeFile(join(base, "bindings.json"), JSON.stringify(bindings))
  const descriptor: any = { schema: "usl-capability/v1", id: "run", version: "1", connection: "fixture", nativeOperation: "runner", sourceDigest: pin("descriptor"), kind: "ACTION", effect: "WRITE", meanings: ["urn:fixture:run"], requiredScopes: ["run"], input: { types: ["urn:fixture:Input"], schema: true }, output: { types: ["urn:fixture:Output"], schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } }, mapping: { completeness: "COMPLETE", losses: [], unsupported: [] } }
  const policy = { connection: "fixture", capabilityId: "run", descriptorDigest: contractDigest(descriptor), sourceDigest: descriptor.sourceDigest, allowedEffects: ["WRITE"], allowedScopes: ["run"], allowLossy: false, maxInputBytes: 4096, maxOutputBytes: 4096, timeoutMs: 2000 }
  const config: any = { schema: "usl-cli-host/v1", bindings: "bindings.json", workspaces: { project }, maxSourceBytes: 65536, actions: [{ id: "run", descriptor, policy, graph: { source: { resource: "graph", representation: "graph-local" }, sourceDigest: pin(graphText), graphId: "cli.fixture", graphspecDigest: graph.identity.graphspec_sha256, node: "run", scope: "ENTRY_NODE_ONLY" }, cwd: { resource: "cwd", representation: "cwd-local" }, command: { executable: "node", args: [{ resource: "runner", representation: "runner-local" }], envAllowlist: [] }, pins: [{ source: { resource: "runner", representation: "runner-local" }, digest: pin(code) }] }] }
  const configPath = join(base, "host.json"), request = { descriptorDigest: policy.descriptorDigest, sourceDigest: descriptor.sourceDigest, input: { types: ["urn:fixture:Input"], value: {} } }
  await writeFile(configPath, JSON.stringify(config)); return { base, project, configPath, request, marker, script, config, graph }
}

test("host plan and run reserve durable intent then bind a successful result", async t => {
  const f = await setup(t), plan: any = await planCliAction(f.configPath, "run", f.request)
  assert.equal(plan.status, "READY")
  const receipt: any = await executeCliAction(f.configPath, "run", f.request, plan.planDigest, join(f.base, "receipt"))
  assert.equal(receipt.status, "SUCCEEDED"); assert.equal((await readFile(f.marker, "utf8")), "ran")
  await access(join(f.base, "receipt", "intent.json")); await access(join(f.base, "receipt", "result.json"))
})

test("stale plan and changed pinned source refuse before a subprocess side effect", async t => {
  const f = await setup(t), plan: any = await planCliAction(f.configPath, "run", f.request)
  const stale: any = await executeCliAction(f.configPath, "run", f.request, `sha256:${"0".repeat(64)}`, join(f.base, "stale"))
  assert.equal(stale.status, "REJECTED"); await assert.rejects(readFile(f.marker))
  await writeFile(f.script, "process.stdout.write(JSON.stringify({ok:true}))")
  const changed: any = await planCliAction(f.configPath, "run", f.request)
  assert.equal(changed.status, "REJECTED"); assert.match(changed.issues[0].detail, /source pin differs/)
  assert.notEqual(plan.planDigest, changed.planDigest)
})

test("invalid child output becomes indeterminate after its single attempt", async t => {
  const f = await setup(t, "wrong-schema"), plan: any = await planCliAction(f.configPath, "run", f.request)
  const result: any = await executeCliAction(f.configPath, "run", f.request, plan.planDigest, join(f.base, "bad"))
  assert.equal(result.status, "INDETERMINATE"); assert.equal(result.reason, "OUTPUT_SCHEMA")
})

test("post-execution pin drift is indeterminate, while denied effects never start a child", async t => {
  const mutating = await setup(t, "mutate"), plan: any = await planCliAction(mutating.configPath, "run", mutating.request)
  const drift: any = await executeCliAction(mutating.configPath, "run", mutating.request, plan.planDigest, join(mutating.base, "drift"))
  assert.equal(drift.status, "INDETERMINATE"); assert.equal(drift.reason, "SOURCE_OR_BINDING_CHANGED")
  const denied = await setup(t); denied.config.actions[0].policy.allowedEffects = ["READ"]
  await writeFile(denied.configPath, JSON.stringify(denied.config))
  const rejected: any = await planCliAction(denied.configPath, "run", denied.request)
  assert.equal(rejected.status, "REJECTED"); assert.match(JSON.stringify(rejected.issues), /EFFECT_DENIED/)
  await assert.rejects(readFile(denied.marker))
})

test("GraphSpec dangling edges and incoming entry dependencies refuse planning", async t => {
  for (const mode of ["dangling", "incoming"] as const) {
    const f = await setup(t), graph = structuredClone(f.graph)
    if (mode === "dangling") graph.topology.edges = [{ id: "bad", source: "run", target: "missing" }]
    else { graph.topology.nodes.push({ id: "before", type: "tool" }); graph.topology.edges = [{ id: "needs", source: "before", target: "run" }] }
    sign(graph); const text = JSON.stringify(graph)
    await writeFile(join(f.project, "fixtures", "graph.json"), text)
    f.config.actions[0].graph.sourceDigest = pin(text); f.config.actions[0].graph.graphspecDigest = graph.identity.graphspec_sha256
    await writeFile(f.configPath, JSON.stringify(f.config))
    const rejected: any = await planCliAction(f.configPath, "run", f.request)
    assert.equal(rejected.status, "REJECTED")
    assert.match(rejected.issues[0].detail, mode === "dangling" ? /unknown endpoint/ : /dependencies require/)
  }
})

test("moving a registered workspace preserves binding IDs but invalidates the old plan", async t => {
  const f = await setup(t), oldPlan: any = await planCliAction(f.configPath, "run", f.request)
  const moved = join(f.base, "moved-project"); await cp(f.project, moved, { recursive: true })
  f.config.workspaces.project = moved; await writeFile(f.configPath, JSON.stringify(f.config))
  const newPlan: any = await planCliAction(f.configPath, "run", f.request)
  assert.equal(newPlan.status, "READY"); assert.notEqual(newPlan.planDigest, oldPlan.planDigest)
  assert.equal(newPlan.sources.find((source: any) => source.resource === "runner").representation, "runner-local")
  const stale: any = await executeCliAction(f.configPath, "run", f.request, oldPlan.planDigest, join(f.base, "moved-receipt"))
  assert.equal(stale.status, "REJECTED"); await assert.rejects(readFile(join(moved, "fixtures", "marker.txt")))
})

test("CLI wrapper exposes list, plan and run using registered IDs", async t => {
  const f = await setup(t), root = process.cwd(), cli = join(root, "src", "cli.ts")
  const input = join(f.base, "request.json"); await writeFile(input, JSON.stringify(f.request))
  const listed = await exec(process.execPath, ["--import", "tsx", cli, "cli-list", "--config", f.configPath], { cwd: root })
  assert.equal(JSON.parse(listed.stdout).actions[0].id, "run")
  const planned = await exec(process.execPath, ["--import", "tsx", cli, "cli-plan", "--config", f.configPath, "--action", "run", "--input", input], { cwd: root })
  const plan = JSON.parse(planned.stdout)
  const run = await exec(process.execPath, ["--import", "tsx", cli, "cli-run", "--config", f.configPath, "--action", "run", "--input", input, "--expected-plan", plan.planDigest, "--receipt-dir", join(f.base, "cli-receipt")], { cwd: root })
  assert.equal(JSON.parse(run.stdout).status, "SUCCEEDED")
})
