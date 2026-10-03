import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { contractDigest } from "../src/contract-core.js"
import { completeRuleWeightReview, prepareRuleWeightReview } from "../src/addons/rule-weight-review.js"
import { ruleWeightReviewFixture } from "../examples/rule-weight-review-fixture.js"

const root = join(process.cwd(), "examples/fixtures/rule-weight-review")
const hash = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`
const hswmHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")
const source = async (name: string) => readFile(join(root, name), "utf8")

const setup = async () => {
  const fixture = ruleWeightReviewFixture(), prior = fixture.prior
  const artifacts = { dataset: await source("dataset.json"), report: await source("report.json"), replay: await source("replay.json"),
    baselineSource: await source("baseline-policy.json"), candidateSource: await source("candidate-policy.json") }
  const handoff = { schema: "usl-rule-weight-review/v1" as const, id: "urn:test:rule-weight-review", version: "1", reviewedAt: "2026-10-03T00:31:00Z",
    recipe: { policy: prior.policy, observations: prior.observations, evidence: prior.evidence, proposalInput: prior.proposalInput },
    artifacts: { dataset: "dataset.json", report: "report.json", baselineSource: "baseline-policy.json", candidateSource: "candidate-policy.json" }, mapping: fixture.mapping }
  const host = { expectedHandoffDigest: contractDigest(handoff), artifactSha256: {
    dataset: hash(artifacts.dataset), report: hash(artifacts.report), baselineSource: hash(artifacts.baselineSource), candidateSource: hash(artifacts.candidateSource),
  }, evaluationContext: prior.evaluationContext, evidenceHost: prior.host }
  return { handoff, host, artifacts }
}

test("imports a real synthetic HSWM report as review-only evidence and verifies replay", async () => {
  const s = await setup()
  const { replay, ...artifactInputs } = s.artifacts
  const prepared = prepareRuleWeightReview(s.handoff, s.host, artifactInputs)
  assert.equal(prepared.selected.reviewStatus, "REVIEW_READY")
  assert.equal(prepared.dataset.dataKind, "SYNTHETIC")
  assert.equal(prepared.semantics.learnedEstimate, "PRESERVED_ONLY_IN_PINNED_HSWM_REPORT; NOT_A_COEFFICIENT")
  assert.deepEqual(prepared.semantics.coefficientChanges, prepared.proposal.changes)
  assert.ok(Object.isFrozen(prepared)); assert.equal(prepared.proposal.effectiveness, "NOT_ESTABLISHED")
  const receipt = completeRuleWeightReview(prepared, JSON.parse(replay))
  assert.equal(receipt.reviewStatus, "REVIEW_READY")
  assert.equal(receipt.disposition, "REVIEW_ONLY_NOT_APPLIED")
  assert.equal(receipt.learnedEstimate, "NOT_COPIED_TO_COEFFICIENTS")
  assert.equal(receipt.reportedOperationalEfficacy, null)
})

test("rejects swapped or stale pinned artifact bytes and a role-destroying coalition", async () => {
  const s = await setup()
  const { replay: _replay, ...artifactInputs } = s.artifacts
  assert.throws(() => prepareRuleWeightReview(s.handoff, s.host, { ...artifactInputs, report: s.artifacts.dataset }), /artifact hash mismatch/)
  const dataset = JSON.parse(s.artifacts.dataset)
  dataset.graph.actions[1].members[0].role = "wrong-role"
  const changed = JSON.stringify(dataset, null, 2) + "\n"
  const report = JSON.parse(s.artifacts.report)
  report.inputDigest = createHash("sha256").update(JSON.stringify(dataset), "utf8").digest("hex")
  const changedReport = JSON.stringify(report, null, 2) + "\n"
  const host = { ...s.host, artifactSha256: { ...s.host.artifactSha256, dataset: hash(changed), report: hash(changedReport) } }
  assert.throws(() => prepareRuleWeightReview(s.handoff, host, { ...artifactInputs, dataset: changed, report: changedReport }), /action role mapping mismatch/)
  const staleReport = JSON.parse(s.artifacts.report); staleReport.inputDigest = "0".repeat(64)
  const staleText = JSON.stringify(staleReport, null, 2) + "\n"
  const staleHost = { ...s.host, artifactSha256: { ...s.host.artifactSha256, report: hash(staleText) } }
  assert.throws(() => prepareRuleWeightReview(s.handoff, staleHost, { ...artifactInputs, report: staleText }), /report does not bind this dataset/)
})

test("does not permit hard-rule relaxation or an unverified selected replay", async () => {
  const s = await setup()
  const { replay: replayText, ...artifactInputs } = s.artifacts
  const hard: any = structuredClone(s.handoff)
  hard.recipe.proposalInput.changes[0].rule = hard.recipe.policy.rules[0].id
  hard.recipe.proposalInput.changes[0].ruleVersion = hard.recipe.policy.rules[0].version
  hard.recipe.proposalInput.changes[0].fromWeight = 0
  hard.recipe.proposalInput.changes[0].toWeight = 0.4
  const hardHost = { ...s.host, expectedHandoffDigest: contractDigest(hard) }
  assert.throws(() => prepareRuleWeightReview(hard, hardHost, artifactInputs), /invalid rule weight change/)
  const prepared = prepareRuleWeightReview(s.handoff, s.host, artifactInputs)
  const replay = JSON.parse(replayText)
  replay.replays[0].rollbackVerified = false
  assert.throws(() => completeRuleWeightReview(prepared, replay), /verified local rollback/)
})

test("requires the same-process prepared token and a graph-preserving replay", async () => {
  const s = await setup(), { replay: replayText, ...artifactInputs } = s.artifacts
  const prepared = prepareRuleWeightReview(s.handoff, s.host, artifactInputs)
  assert.throws(() => completeRuleWeightReview(structuredClone(prepared), JSON.parse(replayText)), /not created by this runtime/)
  const replay = JSON.parse(replayText)
  replay.replays[0].graph.rules[0].bytes += 1
  replay.replays[0].afterDigest = hswmHash(replay.replays[0].graph)
  assert.throws(() => completeRuleWeightReview(prepared, replay), /immutable graph content/)
})

test("keeps baseline for a structurally valid NO_CHANGE report and records caller-declared time", async () => {
  const s = await setup(), { replay: _replay, ...artifactInputs } = s.artifacts
  const report = JSON.parse(s.artifacts.report), policy = report.policy.contexts[0], evaluation = report.evaluations[0], proposal = report.proposals[0]
  policy.chosenActionUid = s.handoff.mapping.baselineActionUid
  evaluation.status = "NO_CHANGE"; proposal.status = "NO_CHANGE"; proposal.after.actionUid = s.handoff.mapping.baselineActionUid
  for (const node of report.graph.nodes) {
    if (node.uid === policy.uid) node.payload = policy
    if (node.uid === evaluation.uid) node.payload = evaluation
    if (node.uid === proposal.uid) node.payload = proposal
  }
  const reportText = JSON.stringify(report, null, 2) + "\n"
  const host = { ...s.host, artifactSha256: { ...s.host.artifactSha256, report: hash(reportText) } }
  const prepared = prepareRuleWeightReview(s.handoff, host, { ...artifactInputs, report: reportText })
  assert.equal(prepared.selected.reviewStatus, "KEEP_BASELINE")
  const receipt = completeRuleWeightReview(prepared, { scope: "INDEPENDENT_LOCAL_COPIES", replays: [], held: [{ uid: prepared.selected.proposalUid, status: "NO_CHANGE" }] })
  assert.equal(receipt.timeSource, "CALLER_DECLARED")
  assert.deepEqual(receipt.learnerEstimates.utilityDelta, prepared.learnerEstimates.utilityDelta)
})

test("pins the assessment payload and proposal placement to the dataset", async () => {
  const s = await setup(), { replay: _replay, ...artifactInputs } = s.artifacts
  const assessmentReport = JSON.parse(s.artifacts.report)
  const assessment = assessmentReport.graph.nodes.find((node: any) => node.type === "WeightAssessment")
  assessment.payload.trainDigest = "forged"
  const assessmentText = JSON.stringify(assessmentReport, null, 2) + "\n"
  const assessmentHost = { ...s.host, artifactSha256: { ...s.host.artifactSha256, report: hash(assessmentText) } }
  assert.throws(() => prepareRuleWeightReview(s.handoff, assessmentHost, { ...artifactInputs, report: assessmentText }), /weight assessment payload mismatch/)

  const proposalReport = JSON.parse(s.artifacts.report), proposal = proposalReport.proposals[0]
  proposal.before.uid = "urn:test:missing-placement"; proposal.rollback.uid = "urn:test:missing-placement"
  const proposalNode = proposalReport.graph.nodes.find((node: any) => node.uid === proposal.uid); proposalNode.payload = proposal
  const proposalText = JSON.stringify(proposalReport, null, 2) + "\n"
  const proposalHost = { ...s.host, artifactSha256: { ...s.host.artifactSha256, report: hash(proposalText) } }
  assert.throws(() => prepareRuleWeightReview(s.handoff, proposalHost, { ...artifactInputs, report: proposalText }), /does not bind the dataset placement/)
})
