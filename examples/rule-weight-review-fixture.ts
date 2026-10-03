/** Deterministic synthetic retrieval experiment. No model or operational workload is used. */
import { contractDigest } from "../src/contract-core.js"
import { digestSource } from "../src/language/digest.js"
import { evaluateRulePolicy, type RulePolicy } from "../src/addons/rule-policy.js"
import { dashboardContext, observeDashboardTarget } from "./rule-policy-fixture.js"
import { ruleWeightEvidenceFixture } from "./rule-weight-evidence-fixture.js"

const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"
const clock = "2026-10-03T00:30:00Z" // Fixture time, not an execution timestamp.

export const ruleWeightReviewFixture = () => {
  const prior = ruleWeightEvidenceFixture(), policies = [prior.policy, prior.proposal.candidatePolicy]
  const files: Record<string, string> = { "baseline-policy.json": json(policies[0]), "candidate-policy.json": json(policies[1]) }
  const actions = ["urn:example:w:baseline-action", "urn:example:w:candidate-action"]
  const ruleIds = policies.map(policy => `urn:example:policy-snapshot:${contractDigest(policy).slice(7)}`)
  const policyPaths = ["baseline-policy.json", "candidate-policy.json"]
  const contextUid = prior.evidence.context.id
  const experiment = { schema: "usl-synthetic-policy-experiment/v1", dataKind: "SYNTHETIC",
    seed: 20261003, trainUnits: 128, holdoutUnits: 512, choices: actions, loggingProbabilities: [0.5, 0.5],
    task: "Choose an answer from two memory bundles using the policy penalty; compare its ID to a separately specified gold answer.",
    scenarios: ["source-sensitive: answer A has one missing source among five records; gold answer B has sources but no tags", "neutral: gold answer A satisfies both rules; answer B violates both"],
    scope: "AUTHORED_SYNTHETIC_TASKS_ONLY", independence: "DECLARED_SYNTHETIC_UNITS_NOT_AUTHENTICATED_OPERATIONAL_INDEPENDENCE" }
  files["protocol.json"] = json(experiment)
  let state = experiment.seed
  const choose = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) < 0x80000000 ? 0 : 1 }
  const score = (policy: RulePolicy, sourceMissing: number, tagsMissing: number) => {
    const raw = json({ schema: "dashboard-memory-example/v1", records: Array.from({ length: 5 }, (_, i) => ({
      id: `memory:${i}`, references: [], source: i < sourceMissing ? null : `urn:example:source:${i}`, tags: i < tagsMissing ? [] : ["tag"],
    })) })
    const observations = observeDashboardTarget(policy, raw, "2026-10-03T00:20:00Z")
    const context = { ...dashboardContext(observations), expectedPolicyDigest: contractDigest(policy) }
    const evaluation = evaluateRulePolicy(policy, observations, context)
    if (evaluation.decision !== "ELIGIBLE" || evaluation.penalty === null) throw new Error("synthetic choice lacks a complete eligible evaluation")
    return evaluation.penalty
  }
  // Task definitions and thresholds are fixed before the outcome loop; gold does not depend on selected action.
  const templates = [
    { gold: "answer:B", options: [[1, 0], [0, 5]] },
    { gold: "answer:A", options: [[0, 0], [5, 5]] },
  ]
  const scores = policies.map(policy => templates.map(task => task.options.map(([source, tags]) => score(policy, source!, tags!))))
  const outcomes: { unitUid: string; split: string; scenario: number; actionUid: string; selectedAnswer: string; expectedAnswer: string; correct: boolean }[] = []
  const episodes = Array.from({ length: experiment.trainUnits + experiment.holdoutUnits }, (_, index) => {
    const selected = choose(), scenario = index % templates.length, optionScores = scores[selected]![scenario]!
    const selectedAnswer = optionScores[0]! <= optionScores[1]! ? "answer:A" : "answer:B"
    const expectedAnswer = templates[scenario]!.gold, correct = selectedAnswer === expectedAnswer
    const unitUid = `urn:example:w:unit:${index}`, split = index < experiment.trainUnits ? "train" : "holdout"
    outcomes.push({ unitUid, split, scenario, actionUid: actions[selected]!, selectedAnswer, expectedAnswer, correct })
    return { uid: `urn:example:w:episode:${index}`, unitUid, split, contextUid,
      eventTime: "2026-10-03T00:20:00Z", chosenActionUid: actions[selected],
      probabilities: actions.map(actionUid => ({ actionUid, probability: 0.5 })),
      loaded: [{ ruleUid: ruleIds[selected], revision: policies[selected]!.version,
        bytesRead: Buffer.byteLength(files[policyPaths[selected]!]!, "utf8") }],
      success: correct, tokens: 0, latencyMs: 0 } // No LLM tokens; latency is a synthetic fixture value.
  })
  files["outcomes.json"] = json({ schema: "usl-synthetic-policy-outcomes/v1", experiment, scores, outcomes })
  const evidenceEntry = (id: string, path: string, description: string) => ({ id, path,
    sha256: digestSource(files[path]!).slice(7), method: "STRUCTURAL_CHECK", observedAt: clock, description })
  const dataset = { schema: "hswm-w-learning/v1", uid: "urn:example:usl-policy-learning", revision: "1",
    recordedAt: clock, actor: "urn:example:usl-fixture-generator", dataKind: "SYNTHETIC",
    protocol: { uid: "urn:example:w:protocol", revision: "1", evidenceId: "protocol", fixedBeforeOutcomes: true,
      independentUnits: true, randomizedLogging: true, selector: "urn:example:selector:policy-minimum-penalty",
      outcomeEvaluator: "urn:example:evaluator:gold-answer-equality", environmentRevision: "synthetic-memory-choice-v1", tokenizerRevision: "NO_LLM_TOKENS" },
    config: { tokenCostWeight: 0, maxTokens: 1, minTrainChosen: 16, minHoldoutChosen: 64,
      minPropensity: 0.25, alpha: 0.05, minimumGain: 0.05, successNonInferiorityMargin: 0 },
    evidence: [evidenceEntry("baseline-policy", policyPaths[0]!, "Exact USL baseline policy source snapshot"),
      evidenceEntry("candidate-policy", policyPaths[1]!, "Exact USL proposed policy source snapshot"),
      evidenceEntry("protocol", "protocol.json", "Predeclared synthetic task generator configuration; not authenticated operational protocol"),
      evidenceEntry("outcomes", "outcomes.json", "Synthetic answer selection and independent gold-ID comparison; never penalty relabelled as reward")],
    graph: { uid: "urn:example:w:policy-placement-graph", revision: "1",
      rules: ruleIds.map((uid, i) => ({ uid, revision: policies[i]!.version, evidenceId: i === 0 ? "baseline-policy" : "candidate-policy", bytes: Buffer.byteLength(files[policyPaths[i]!]!, "utf8") })),
      actions: actions.map((uid, i) => ({ uid, revision: "1", members: [{ ruleUid: ruleIds[i], role: "policy_snapshot", ordinal: 0 }] })),
      contexts: [{ uid: contextUid, revision: prior.evidence.context.version, allowedActions: actions,
        requiredRules: [], requiredRoles: ["policy_snapshot"], maxActiveRules: 1, maxBytes: 8192 }],
      placements: [{ uid: "urn:example:w:policy-placement", revision: "1", contextUid, actionUid: actions[0] }] },
    episodes, interactions: [] }
  files["dataset.json"] = json(dataset)
  return { prior, files, dataset, mapping: { contextUid, contextRevision: prior.evidence.context.version,
    baselineActionUid: actions[0]!, candidateActionUid: actions[1]!, baselineRuleUid: ruleIds[0]!, candidateRuleUid: ruleIds[1]!, role: "policy_snapshot" as const, ordinal: 0 as const } }
}
