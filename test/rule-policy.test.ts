import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Either } from "effect"
import { evaluateRulePolicy, parseRulePolicy, readRulePolicyBinding } from "../src/addons/rule-policy.js"
import { contractDigest } from "../src/contract-core.js"
import { bindResourceGraph } from "../src/integrations/resource-bindings.js"
import { adaptResourceGraph } from "../src/integrations/resource-graph.js"
import { parseResourceBindings } from "../src/resource-bindings.js"
import { configurationId, dashboardBindingGraph, dashboardContext, dashboardPolicy, dashboardTarget, observeDashboardTarget } from "../examples/rule-policy-fixture.js"
import { temporary } from "./fixtures.js"

const setup = () => {
  const policy = structuredClone(dashboardPolicy()), target = structuredClone(dashboardTarget)
  const packet = observeDashboardTarget(policy, JSON.stringify(target), "2026-10-02T00:00:00Z")
  return { policy, packet, context: dashboardContext(packet), target }
}

test("real example predicates produce a weighted recommendation penalty after required rules pass", () => {
  const { policy, packet, context } = setup(), report = evaluateRulePolicy(policy, packet, context)
  assert.equal(report.decision, "ELIGIBLE"); assert.equal(report.coverage, "COMPLETE")
  assert.ok(Math.abs(report.penalty! - 0.6) < 1e-12)
  assert.deepEqual(report.results.map(row => row.status), ["PASS", "FAIL", "FAIL"])
  assert.equal(report.execution, "NOT_REQUESTED"); assert.equal(report.authority, "NOT_GRANTED")
  const { digest, ...body } = report
  assert.equal(digest, contractDigest(body)); assert.ok(Object.isFrozen(report.results))
})

test("a dangling memory reference blocks even when every soft rule passes", () => {
  const { policy, target } = setup()
  target.records[0]!.references = ["missing"]
  for (const record of target.records) { record.source = "urn:example:source"; record.tags = ["tag"] }
  const packet = observeDashboardTarget(policy, JSON.stringify(target), "2026-10-02T00:00:00Z")
  const report = evaluateRulePolicy(policy, packet, dashboardContext(packet))
  assert.equal(report.decision, "BLOCKED"); assert.equal(report.penalty, null)
  assert.deepEqual(report.results.map(row => row.status), ["FAIL", "PASS", "PASS"])
})

test("unknown, missing and unsupported required predicates never become a pass", () => {
  for (const defect of ["unknown", "missing", "unsupported"] as const) {
    const { policy, packet, context } = setup()
    if (defect === "unknown") Object.assign(packet.observations[0]!, { status: "UNKNOWN", violation: null, evidence: [] })
    if (defect === "missing") packet.observations.shift()
    if (defect === "unsupported") context.supportedEvaluators = context.supportedEvaluators.slice(1)
    const report = evaluateRulePolicy(policy, packet, context)
    assert.equal(report.decision, "UNDETERMINED"); assert.equal(report.coverage, "INCOMPLETE"); assert.equal(report.penalty, null)
    assert.equal(report.results[0]!.status, { unknown: "UNKNOWN", missing: "NOT_EVALUATED", unsupported: "UNSUPPORTED" }[defect])
  }
})

test("missing soft evidence leaves eligibility separate from incomplete ranking", () => {
  const { policy, packet, context } = setup(); packet.observations.pop()
  const report = evaluateRulePolicy(policy, packet, context)
  assert.equal(report.decision, "ELIGIBLE"); assert.equal(report.coverage, "INCOMPLETE"); assert.equal(report.penalty, null)
})

test("partial evidence remains visible for an UNKNOWN observation without becoming a pass", () => {
  const { policy, packet, context } = setup()
  Object.assign(packet.observations[1]!, { status: "UNKNOWN", violation: null, detail: "Source requires an unavailable owner lookup" })
  const report = evaluateRulePolicy(policy, packet, context)
  assert.equal(report.results[1]!.status, "UNKNOWN")
  assert.deepEqual(report.results[1]!.evidence, packet.observations[1]!.evidence)
  assert.equal(report.penalty, null)
})

test("severity is presentation; WARN, RECORD and PENALIZE retain their declared meanings", () => {
  const { policy, packet, context } = setup()
  policy.rules[0]!.severity = "INFO"
  Object.assign(policy.rules[1]!, { onViolation: "WARN", weight: 0, severity: "VIOLATION" })
  Object.assign(policy.rules[2]!, { requirement: "INFORMATIONAL", onViolation: "RECORD", weight: 0 })
  packet.policyDigest = contractDigest(policy)
  context.expectedPolicyDigest = contractDigest(policy)
  const report = evaluateRulePolicy(policy, packet, context)
  assert.equal(report.decision, "ELIGIBLE"); assert.equal(report.penalty, 0)
  Object.assign(packet.observations[0]!, { status: "FAIL", violation: 1 })
  assert.equal(evaluateRulePolicy(policy, packet, context).decision, "BLOCKED")
})

test("policy contradictions, duplicate IDs, nonfinite weights and unsupported dialects are refused", () => {
  const mutations = [
    (p: any) => { p.rules[0].onViolation = "WARN" },
    (p: any) => { p.rules[1].weight = 0 },
    (p: any) => { p.rules[0].weight = 0.5 },
    (p: any) => { p.rules[1].weight = Infinity },
    (p: any) => { p.rules[1].weight = -1 },
    (p: any) => { p.rules[1].weight = 1.1 },
    (p: any) => { p.rules.push(p.rules[0]) },
    (p: any) => { p.schema = "usl-rule-policy/v2" },
    (p: any) => { p.conflictPolicy = "HIGHEST_WEIGHT_WINS" },
    (p: any) => { p.allowAccess = true },
  ]
  for (const mutate of mutations) { const policy = structuredClone(dashboardPolicy()); mutate(policy); assert.throws(() => parseRulePolicy(policy)) }
})

test("snapshot, rule version, consumer, scope and evidence cannot be silently rebound", () => {
  const mutations = [
    (s: ReturnType<typeof setup>) => { s.policy.rules[1]!.weight = 0.9 },
    (s: ReturnType<typeof setup>) => { s.packet.targetDigest = `sha256:${"0".repeat(64)}` },
    (s: ReturnType<typeof setup>) => { s.context.consumer = "someone:else" },
    (s: ReturnType<typeof setup>) => { s.context.scope = "different" },
    (s: ReturnType<typeof setup>) => { s.packet.observations[0]!.ruleVersion = "2" },
    (s: ReturnType<typeof setup>) => { s.packet.observations[0]!.evaluator.version = "2" },
    (s: ReturnType<typeof setup>) => { s.packet.observations[0]!.evidence = [] },
    (s: ReturnType<typeof setup>) => { s.packet.observations[0]!.violation = 1 },
    (s: ReturnType<typeof setup>) => { s.packet.observations.push(s.packet.observations[0]!) },
    (s: ReturnType<typeof setup>) => { s.packet.observations[0]!.rule = "urn:unknown:rule" },
  ]
  for (const mutate of mutations) { const s = setup(); mutate(s); assert.throws(() => evaluateRulePolicy(s.policy, s.packet, s.context)) }
})

test("rewriting both policy and observations cannot replace the consumer's registered policy pin", () => {
  const { policy, packet, context } = setup()
  Object.assign(policy.rules[0]!, { requirement: "INFORMATIONAL", onViolation: "RECORD" })
  packet.policyDigest = contractDigest(policy)
  assert.throws(() => evaluateRulePolicy(policy, packet, context), /unregistered rule policy/)
})

test("explicit conflict blocks ranking; self, unknown and duplicate conflict references are rejected", () => {
  const { policy, packet, context } = setup()
  packet.conflicts = [{ rules: [policy.rules[0]!.id, policy.rules[1]!.id], detail: "Owner reports incompatible requirements" }]
  const report = evaluateRulePolicy(policy, packet, context)
  assert.equal(report.decision, "CONFLICT"); assert.equal(report.penalty, null)
  packet.conflicts.push({ ...packet.conflicts[0]!, rules: [...packet.conflicts[0]!.rules].reverse() as [string, string] })
  assert.throws(() => evaluateRulePolicy(policy, packet, context), /duplicate conflicts/)
  packet.conflicts = [{ rules: [policy.rules[0]!.id, policy.rules[0]!.id], detail: "self" }]
  assert.throws(() => evaluateRulePolicy(policy, packet, context), /invalid conflict/)
  packet.conflicts[0]!.rules[1] = "urn:unknown:rule"
  assert.throws(() => evaluateRulePolicy(policy, packet, context), /invalid conflict/)
})

test("addon selection checks named roles, types, versions and complete bindings without changing core parsing", () => {
  assert.deepEqual(readRulePolicyBinding(dashboardBindingGraph(), configurationId), dashboardPolicy())
  const mutations = [
    (g: ReturnType<typeof dashboardBindingGraph>) => { g.links.pop() },
    (g: ReturnType<typeof dashboardBindingGraph>) => { g.resources[0]!.metadata!.ruleVersion = "2" },
    (g: ReturnType<typeof dashboardBindingGraph>) => { g.resources[0]!.types = ["urn:wrong:type"] },
    (g: ReturnType<typeof dashboardBindingGraph>) => { g.links[0]!.participants[1]!.resource = "example:source" },
    (g: ReturnType<typeof dashboardBindingGraph>) => { g.links.push({ ...g.links[0]!, id: "extra:binding" }) },
  ]
  for (const mutate of mutations) {
    const graph = dashboardBindingGraph(); mutate(graph)
    assert.ok(Either.isRight(adaptResourceGraph(JSON.stringify(graph), { namespace: "test.rule-policy" })))
    assert.throws(() => readRulePolicyBinding(graph, configurationId))
  }
})

test("relocation and a cold JSON handoff preserve rule IDs, weights, scope and version pins", async t => {
  const base = await temporary(t), original = join(base, "original"), moved = join(base, "moved")
  await mkdir(original); await writeFile(join(original, "target.json"), JSON.stringify(dashboardTarget))
  const bindings = parseResourceBindings({ schema: "usl-resource-bindings/v1", resources: [{ id: "example:dashboard-memory", representations: [
    { id: "memory-local", relation: "working-copy", kind: "workspace", workspace: "dashboard", path: "target.json" },
  ] }] })
  const graph = JSON.stringify(dashboardBindingGraph()), selections = [{ resource: "example:dashboard-memory", representation: "memory-local" }]
  const before = await bindResourceGraph(graph, bindings, selections, { workspaces: { dashboard: original } })
  await rename(original, moved)
  const after = await bindResourceGraph(graph, bindings, selections, { workspaces: { dashboard: moved } })
  assert.notEqual(before.bindingReceipt.resultDigest, after.bindingReceipt.resultDigest)
  const policy = readRulePolicyBinding(JSON.parse(JSON.stringify(after.graph)), configurationId)
  assert.deepEqual(policy, readRulePolicyBinding(before.graph, configurationId))
  const packet = observeDashboardTarget(policy, await readFile(join(moved, "target.json"), "utf8"), "2026-10-02T00:00:00Z")
  const cold = JSON.parse(JSON.stringify({ policy, packet }))
  const report = evaluateRulePolicy(cold.policy, cold.packet, dashboardContext(packet))
  assert.equal(report.policyDigest, contractDigest(dashboardPolicy())); assert.equal(report.decision, "ELIGIBLE")
})
