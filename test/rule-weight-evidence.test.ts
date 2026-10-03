import assert from "node:assert/strict"
import { test } from "node:test"
import { contractDigest } from "../src/contract-core.js"
import { evaluateRulePolicy } from "../src/addons/rule-policy.js"
import { parseRuleWeightEvidence, proposeRuleWeights } from "../src/addons/rule-weight-evidence.js"
import { dashboardContext, dashboardPolicy, dashboardTarget, observeDashboardTarget } from "../examples/rule-policy-fixture.js"

const hash = (letter: string) => `sha256:${letter.repeat(64)}`
const setup = () => {
  const policy = structuredClone(dashboardPolicy())
  const observations = observeDashboardTarget(policy, JSON.stringify(dashboardTarget), "2026-10-02T00:00:00Z")
  const evaluationContext = dashboardContext(observations)
  const evaluation = evaluateRulePolicy(policy, observations, evaluationContext)
  const context = { id: "urn:test:weight-context", version: "1", digest: hash("a") }
  const action = { id: "urn:test:weight-action", version: "1", digest: hash("b"), participants: [
    { role: "owner", ordinal: 0, source: { id: "urn:test:owner", version: "1", digest: hash("c") } },
    { role: "target", ordinal: 1, source: { id: "urn:test:external-task", version: "1", digest: hash("d") } },
  ] }
  const evidence = {
    schema: "usl-rule-weight-evidence/v1" as const, id: "urn:test:weight-evidence", version: "1", context, action,
    independentUnit: "urn:test:unit:one", selectionProbability: 0.5, observedAt: "2026-10-03T00:00:00Z",
    evaluationDigest: evaluation.digest,
    outcome: { metric: { id: "urn:test:metric:task-value", version: "1", direction: "MAXIMIZE" as const }, value: 7,
      source: { resource: "urn:test:external-outcome", digest: hash("e") }, evaluator: { id: "urn:test:outcome-evaluator", version: "1" }, basis: "EXTERNAL_TASK_MEASUREMENT" as const },
    costs: [{ kind: "review-hours", amount: 1, unit: "hour" }], evidenceClass: "SYNTHETIC" as const,
  }
  const host = { expectedEvidenceDigest: contractDigest(evidence), expectedContext: structuredClone(context), expectedAction: structuredClone(action),
    registeredOutcomeMetric: structuredClone(evidence.outcome.metric), registeredOutcomeEvaluator: structuredClone(evidence.outcome.evaluator) }
  const proposal = { schema: "usl-rule-weight-proposal/v1" as const, id: "urn:test:weight-proposal", version: "1", createdAt: "2026-10-03T01:00:00Z",
    basePolicyDigest: contractDigest(policy), evidenceDigest: contractDigest(evidence), nextPolicyVersion: "2", scope: policy.scope, context,
    method: "OWNER_PROPOSED" as const, rationale: "Owner proposes a bounded future review candidate.",
    changes: [{ rule: policy.rules[1]!.id, ruleVersion: policy.rules[1]!.version, fromWeight: policy.rules[1]!.weight, toWeight: 0.7 }], }
  return { policy, observations, evaluationContext, evaluation, evidence, host, proposal }
}

test("external outcome evidence yields an immutable, unapplied candidate only", () => {
  const s = setup()
  assert.deepEqual(parseRuleWeightEvidence(s.evidence, s.policy, s.observations, s.evaluationContext, s.host), s.evidence)
  const result = proposeRuleWeights(s.policy, s.evidence, s.observations, s.evaluationContext, s.host, s.proposal)
  assert.equal(result.disposition, "PROPOSED_NOT_APPLIED"); assert.equal(result.effectiveness, "NOT_ESTABLISHED")
  assert.equal(result.canonicalW, "NOT_CLAIMED"); assert.deepEqual(result.hswmIntegration, { status: "NOT_CONNECTED", relation: "CANDIDATE_INPUT_ONLY" })
  assert.equal(result.basePolicy.rules[1]!.weight, 0.8); assert.equal(result.candidatePolicy.rules[1]!.weight, 0.7)
  assert.equal(result.evidenceId, s.evidence.id); assert.equal(result.proposalCreatedAt, s.proposal.createdAt); assert.equal(result.proposalMethod, "OWNER_PROPOSED")
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.candidatePolicy.rules))
})

test("host pins reject stale or tampered external evidence and action bindings", () => {
  const mutations: Array<{ mutate: (s: ReturnType<typeof setup>) => void, expected: RegExp, mirror?: "action" }> = [
    { mutate: s => { s.evidence.evaluationDigest = hash("f") }, expected: /stale rule evaluation/ },
    { mutate: s => { s.evidence.action.participants[0]!.ordinal = 8 }, expected: /context\/action pin/ },
    { mutate: s => { s.evidence.outcome.metric.version = "2" }, expected: /unregistered outcome metric/ },
    { mutate: s => { s.evidence.observedAt = "2026-10-01T00:00:00Z" }, expected: /outcome predates/ },
  ]
  for (const { mutate, expected } of mutations) {
    const s = setup(); mutate(s); s.host.expectedEvidenceDigest = contractDigest(s.evidence)
    assert.throws(() => parseRuleWeightEvidence(s.evidence, s.policy, s.observations, s.evaluationContext, s.host), expected)
  }
  const s = setup(); s.evidence.action.participants.push(structuredClone(s.evidence.action.participants[0]!)); s.host.expectedAction = structuredClone(s.evidence.action); s.host.expectedEvidenceDigest = contractDigest(s.evidence)
  assert.throws(() => parseRuleWeightEvidence(s.evidence, s.policy, s.observations, s.evaluationContext, s.host), /duplicate action participant/)
})

test("an evaluation report, its raw target, or its digest cannot be recycled as outcome evidence", () => {
  for (const change of [
    (s: ReturnType<typeof setup>) => { s.evidence.outcome.source.digest = s.evaluation.digest },
    (s: ReturnType<typeof setup>) => { s.evidence.outcome.source.digest = s.evaluation.targetDigest },
    (s: ReturnType<typeof setup>) => { s.evidence.outcome.source.digest = s.evaluation.observationsDigest },
    (s: ReturnType<typeof setup>) => { s.evidence.outcome.source.digest = s.evaluation.policyDigest },
    (s: ReturnType<typeof setup>) => { s.evidence.outcome.source.digest = s.evaluation.contextDigest },
    (s: ReturnType<typeof setup>) => { s.evidence.outcome.source.resource = s.evaluation.target },
  ]) {
    const s = setup(); change(s); s.host.expectedEvidenceDigest = contractDigest(s.evidence)
    assert.throws(() => parseRuleWeightEvidence(s.evidence, s.policy, s.observations, s.evaluationContext, s.host), /outcome source/)
  }
})

test("proposal refuses hard-rule relaxation, stale policy pins, duplicates and no-op weights", () => {
  const mutations = [
    (s: ReturnType<typeof setup>) => { s.proposal.changes[0]!.rule = s.policy.rules[0]!.id; s.proposal.changes[0]!.ruleVersion = s.policy.rules[0]!.version; s.proposal.changes[0]!.fromWeight = 0; s.proposal.changes[0]!.toWeight = 0.3 },
    (s: ReturnType<typeof setup>) => { s.proposal.basePolicyDigest = hash("f") },
    (s: ReturnType<typeof setup>) => { s.proposal.changes[0]!.toWeight = s.proposal.changes[0]!.fromWeight },
    (s: ReturnType<typeof setup>) => { s.proposal.changes.push(structuredClone(s.proposal.changes[0]!)) },
  ]
  for (const mutate of mutations) { const s = setup(); mutate(s); assert.throws(() => proposeRuleWeights(s.policy, s.evidence, s.observations, s.evaluationContext, s.host, s.proposal)) }
})

test("blocked or incomplete evaluations cannot produce a future weight candidate", () => {
  for (const defect of ["blocked", "incomplete"] as const) {
    const s = setup()
    if (defect === "blocked") { s.observations.observations[0]!.status = "FAIL"; s.observations.observations[0]!.violation = 1 }
    else s.observations.observations.pop()
    const evaluation = evaluateRulePolicy(s.policy, s.observations, s.evaluationContext)
    s.evidence.evaluationDigest = evaluation.digest; s.host.expectedEvidenceDigest = contractDigest(s.evidence); s.proposal.evidenceDigest = contractDigest(s.evidence)
    assert.throws(() => proposeRuleWeights(s.policy, s.evidence, s.observations, s.evaluationContext, s.host, s.proposal), /eligible complete/)
  }
})

test("unknown selection probability remains permitted but establishes no effectiveness", () => {
  const s = setup(); (s.evidence as { selectionProbability: number | null }).selectionProbability = null; s.host.expectedEvidenceDigest = contractDigest(s.evidence); s.proposal.evidenceDigest = contractDigest(s.evidence)
  const result = proposeRuleWeights(s.policy, s.evidence, s.observations, s.evaluationContext, s.host, s.proposal)
  assert.equal(result.effectiveness, "NOT_ESTABLISHED")
})

test("proposal bounds, version, scope, context and outcome time are independently enforced", () => {
  const mutations = [
    (s: ReturnType<typeof setup>) => { s.proposal.changes[0]!.toWeight = 0 },
    (s: ReturnType<typeof setup>) => { s.proposal.changes[0]!.toWeight = 1.1 },
    (s: ReturnType<typeof setup>) => { s.proposal.nextPolicyVersion = s.policy.version },
    (s: ReturnType<typeof setup>) => { s.proposal.scope = "other-scope" },
    (s: ReturnType<typeof setup>) => { s.proposal.context.version = "2" },
    (s: ReturnType<typeof setup>) => { s.proposal.createdAt = "2026-10-02T00:00:00Z" },
  ]
  for (const mutate of mutations) { const s = setup(); mutate(s); assert.throws(() => proposeRuleWeights(s.policy, s.evidence, s.observations, s.evaluationContext, s.host, s.proposal)) }
})
