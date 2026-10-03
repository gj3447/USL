/** Synthetic local evidence and an explicit coefficient proposal; no HSWM connection. */
import { contractDigest } from "../src/contract-core.js"
import { evaluateRulePolicy } from "../src/addons/rule-policy.js"
import { proposeRuleWeights, type RuleWeightEvidenceHost } from "../src/addons/rule-weight-evidence.js"
import { dashboardPolicy, dashboardTarget, dashboardContext, observeDashboardTarget } from "./rule-policy-fixture.js"

export const ruleWeightEvidenceFixture = () => {
  const policy = dashboardPolicy()
  const observations = observeDashboardTarget(policy, JSON.stringify(dashboardTarget, null, 2) + "\n", "2026-10-03T00:00:00Z")
  const evaluationContext = dashboardContext(observations)
  const evaluation = evaluateRulePolicy(policy, observations, evaluationContext)
  const contextSource = { id: "urn:example:context:dashboard-review", version: "1", task: "review retrieved memory answers", scope: policy.scope }
  const context = { id: contextSource.id, version: contextSource.version, digest: contractDigest(contextSource) }
  const participants = policy.rules.map((rule, ordinal) => ({ role: "rule", ordinal,
    source: { id: rule.id, version: rule.version, digest: contractDigest(rule) } }))
  const actionSource = { id: "urn:example:action:dashboard-curation", version: "1", policyDigest: contractDigest(policy), participants }
  const action = { id: actionSource.id, version: actionSource.version, digest: contractDigest(actionSource), participants }
  // Separate synthetic task observations, not a transform of rule-policy penalty.
  const outcomeSource = { id: "urn:example:outcome-source:answer-review", fixture: "SYNTHETIC",
    independentUnit: "urn:example:unit:review-batch-1", cases: [{ answer: "answer:a", correct: true }, { answer: "answer:b", correct: false }] }
  const metric = { id: "urn:example:metric:answer-correctness", version: "1", direction: "MAXIMIZE" as const }
  const outcomeEvaluator = { id: "urn:example:evaluator:answer-review", version: "1" }
  const evidence = {
    schema: "usl-rule-weight-evidence/v1" as const, id: "urn:example:rule-weight-evidence:dashboard-outcome", version: "1",
    context, action, independentUnit: outcomeSource.independentUnit, selectionProbability: null,
    observedAt: "2026-10-03T00:01:00Z", evaluationDigest: evaluation.digest,
    outcome: { metric, value: outcomeSource.cases.filter(item => item.correct).length / outcomeSource.cases.length,
      source: { resource: outcomeSource.id, digest: contractDigest(outcomeSource) }, evaluator: outcomeEvaluator,
      basis: "EXTERNAL_TASK_MEASUREMENT" as const },
    costs: [{ kind: "review", amount: 2, unit: "synthetic-case" }], evidenceClass: "SYNTHETIC" as const,
  }
  // Example registration pins fixed fixture inputs. Production hosts register independently.
  const host: RuleWeightEvidenceHost = { expectedEvidenceDigest: contractDigest(evidence), expectedContext: context,
    expectedAction: action, registeredOutcomeMetric: metric, registeredOutcomeEvaluator: outcomeEvaluator }
  const proposalInput = {
    schema: "usl-rule-weight-proposal/v1" as const, id: "urn:example:rule-weight-proposal:dashboard-soft-weights", version: "1",
    createdAt: "2026-10-03T00:02:00Z", basePolicyDigest: contractDigest(policy), evidenceDigest: contractDigest(evidence),
    nextPolicyVersion: "2-proposed", scope: policy.scope, context, method: "OWNER_PROPOSED" as const,
    rationale: "Synthetic reviewer asks to emphasize source presence; this single outcome does not establish that the proposed weights improve results.",
    changes: [
      { rule: policy.rules[1]!.id, ruleVersion: "1", fromWeight: 0.8, toWeight: 0.9 },
      { rule: policy.rules[2]!.id, ruleVersion: "1", fromWeight: 0.2, toWeight: 0.1 },
    ],
  }
  const proposal = proposeRuleWeights(policy, evidence, observations, evaluationContext, host, proposalInput)
  return { policy, observations, evaluationContext, evaluation, contextSource, actionSource, outcomeSource, evidence, host, proposalInput, proposal }
}
