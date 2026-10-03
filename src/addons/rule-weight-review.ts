/**
 * Optional, pure handoff checker for an externally run HSWM W review.
 * This records a bounded candidate review; it never learns, invokes HSWM, or applies a policy.
 */
import { createHash } from "node:crypto"
import { z } from "zod"
import { contractDigest, contractHash, contractIri, contractSnapshot, contractText, freezeContract } from "../contract-core.js"
import { parseRulePolicy, type RuleEvaluationContext } from "./rule-policy.js"
import { proposeRuleWeights, type RuleWeightEvidenceHost } from "./rule-weight-evidence.js"

const rawHash = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`
const hswmDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")
const raw = z.string().superRefine((value, context) => {
  if (Buffer.byteLength(value, "utf8") > 2 * 1024 * 1024) context.addIssue({ code: "custom", message: "raw artifact byte budget exceeded" })
})
const artifactPaths = z.strictObject({ dataset: contractText, report: contractText, baselineSource: contractText, candidateSource: contractText })
const artifactHashes = z.strictObject({ dataset: contractHash, report: contractHash, baselineSource: contractHash, candidateSource: contractHash })
const mappingSchema = z.strictObject({
  contextUid: contractText, contextRevision: contractText, baselineActionUid: contractText, candidateActionUid: contractText,
  baselineRuleUid: contractText, candidateRuleUid: contractText, role: z.literal("policy_snapshot"), ordinal: z.literal(0),
})

export const ruleWeightReviewSchema = z.strictObject({
  schema: z.literal("usl-rule-weight-review/v1"), id: contractIri, version: contractText, reviewedAt: z.iso.datetime(),
  recipe: z.strictObject({ policy: z.unknown(), observations: z.unknown(), evidence: z.unknown(), proposalInput: z.unknown() }),
  artifacts: artifactPaths, mapping: mappingSchema,
})
export type RuleWeightReview = z.infer<typeof ruleWeightReviewSchema>

export const ruleWeightReviewHostSchema = z.strictObject({
  expectedHandoffDigest: contractHash, artifactSha256: artifactHashes,
  evaluationContext: z.unknown(), evidenceHost: z.unknown(),
})
export type RuleWeightReviewHost = z.infer<typeof ruleWeightReviewHostSchema>
export type RuleWeightReviewArtifacts = { readonly dataset: string; readonly report: string; readonly baselineSource: string; readonly candidateSource: string }

const own = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
const string = (value: unknown, label: string) => {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`)
  return value
}
const list = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}
const one = <T>(values: readonly T[], label: string): T => {
  if (values.length !== 1) throw new Error(`expected exactly one ${label}`)
  return values[0]!
}
const parseJson = (text: string, label: string): unknown => {
  try { return JSON.parse(text) } catch { throw new Error(`${label} is not JSON`) }
}
const exactPolicy = (source: unknown, expected: unknown, label: string) => {
  const parsed = parseRulePolicy(source)
  if (contractDigest(parsed) !== contractDigest(expected)) throw new Error(`${label} policy source does not match pinned snapshot`)
  return parsed
}
const action = (graph: Record<string, unknown>, uid: string, ruleUid: string, label: string) => {
  const item = one(list(graph.actions, "dataset graph actions").filter(value => own(value, "action").uid === uid), `${label} action`)
  const members = list(own(item, "action").members, `${label} action members`)
  if (members.length !== 1) throw new Error(`${label} action must contain exactly one policy snapshot member`)
  const member = own(members[0], `${label} action member`)
  if (member.ruleUid !== ruleUid || member.role !== "policy_snapshot" || member.ordinal !== 0) throw new Error(`${label} action role mapping mismatch`)
}
const rule = (graph: Record<string, unknown>, uid: string, policy: { readonly version: string }, source: string, label: string) => {
  const item = one(list(graph.rules, "dataset graph rules").filter(value => own(value, "rule").uid === uid), `${label} rule`)
  const record = own(item, `${label} rule`), evidenceId = string(record.evidenceId, `${label} evidence ID`)
  if (record.revision !== policy.version || record.bytes !== Buffer.byteLength(source, "utf8") || !evidenceId) throw new Error(`${label} rule revision or byte length mismatch`)
  return evidenceId
}

const statuses = ["READY_FOR_OWNER_REVIEW", "NO_CHANGE", "UNKNOWN", "MORE_EVIDENCE_OR_REJECT"] as const
type ReviewStatus = "REVIEW_READY" | "KEEP_BASELINE" | "HOLD"
const reviewStatus = (status: unknown): ReviewStatus => {
  if (!(statuses as readonly unknown[]).includes(status)) throw new Error("unknown selected HSWM evaluation status")
  return status === "READY_FOR_OWNER_REVIEW" ? "REVIEW_READY" : status === "NO_CHANGE" ? "KEEP_BASELINE" : "HOLD"
}
const preparedTokens = new WeakSet<object>()
const estimate = (value: unknown, label: string) => {
  const item = own(value, label), numberOrNull = (field: string) => {
    const result = item[field]
    if (result !== null && (typeof result !== "number" || !Number.isFinite(result))) throw new Error(`${label}.${field} must be finite or null`)
    return result
  }
  const interval = item.interval
  if (interval !== null && (!Array.isArray(interval) || interval.length !== 2 || interval.some(item => typeof item !== "number" || !Number.isFinite(item)))) throw new Error(`${label}.interval must be two finite numbers or null`)
  if (!Number.isSafeInteger(item.n) || (item.effectiveSampleSize !== null && (typeof item.effectiveSampleSize !== "number" || !Number.isFinite(item.effectiveSampleSize))) || (item.maxImportanceWeight !== null && (typeof item.maxImportanceWeight !== "number" || !Number.isFinite(item.maxImportanceWeight))) || (item.reason !== null && typeof item.reason !== "string")) throw new Error(`${label} has invalid estimate fields`)
  return freezeContract({ value: numberOrNull("value") as number | null, interval: interval as readonly [number, number] | null,
    n: item.n as number, effectiveSampleSize: item.effectiveSampleSize as number | null, maxImportanceWeight: item.maxImportanceWeight as number | null, reason: item.reason as string | null })
}

export const prepareRuleWeightReview = (handoffInput: unknown, hostInput: unknown, artifactsInput: RuleWeightReviewArtifacts) => {
  const handoff = ruleWeightReviewSchema.parse(contractSnapshot(handoffInput, 2 * 1024 * 1024))
  const host = ruleWeightReviewHostSchema.parse(contractSnapshot(hostInput, 1024 * 1024))
  const artifacts = z.strictObject({ dataset: raw, report: raw, baselineSource: raw, candidateSource: raw }).parse(artifactsInput)
  if (contractDigest(handoff) !== host.expectedHandoffDigest) throw new Error("unregistered rule weight review handoff digest")
  for (const key of Object.keys(artifacts) as Array<keyof RuleWeightReviewArtifacts>) {
    if (rawHash(artifacts[key]) !== host.artifactSha256[key]) throw new Error(`artifact hash mismatch: ${key}`)
  }
  const policy = parseRulePolicy(handoff.recipe.policy)
  const proposal = proposeRuleWeights(policy, handoff.recipe.evidence, handoff.recipe.observations,
    host.evaluationContext as RuleEvaluationContext, host.evidenceHost as RuleWeightEvidenceHost, handoff.recipe.proposalInput)
  const baselinePolicy = exactPolicy(parseJson(artifacts.baselineSource, "baseline source"), proposal.basePolicy, "baseline")
  const candidatePolicy = exactPolicy(parseJson(artifacts.candidateSource, "candidate source"), proposal.candidatePolicy, "candidate")
  const dataset = own(parseJson(artifacts.dataset, "dataset"), "dataset")
  if (dataset.schema !== "hswm-w-learning/v1") throw new Error("dataset is not an HSWM W input")
  const graph = own(dataset.graph, "dataset graph"), evidence = list(dataset.evidence, "dataset evidence")
  const context = one(list(graph.contexts, "dataset contexts").filter(value => own(value, "context").uid === handoff.mapping.contextUid), "mapped dataset context")
  const contextRecord = own(context, "mapped dataset context")
  if (contextRecord.revision !== handoff.mapping.contextRevision || handoff.mapping.contextUid !== proposal.context.id || handoff.mapping.contextRevision !== proposal.context.version) throw new Error("context mapping mismatch")
  const allowed = list(contextRecord.allowedActions, "context allowed actions")
  if (!allowed.includes(handoff.mapping.baselineActionUid) || !allowed.includes(handoff.mapping.candidateActionUid) || !list(contextRecord.requiredRoles, "context required roles").includes("policy_snapshot")) throw new Error("context does not admit role-preserving policy snapshots")
  const placement = one(list(graph.placements, "dataset placements").filter(value => own(value, "placement").contextUid === handoff.mapping.contextUid), "mapped baseline placement")
  if (own(placement, "placement").actionUid !== handoff.mapping.baselineActionUid) throw new Error("dataset baseline placement mismatch")
  const baselineEvidenceId = rule(graph, handoff.mapping.baselineRuleUid, baselinePolicy, artifacts.baselineSource, "baseline")
  const candidateEvidenceId = rule(graph, handoff.mapping.candidateRuleUid, candidatePolicy, artifacts.candidateSource, "candidate")
  for (const [id, source, label] of [[baselineEvidenceId, artifacts.baselineSource, "baseline"], [candidateEvidenceId, artifacts.candidateSource, "candidate"]] as const) {
    const entry = one(evidence.filter(value => own(value, "dataset evidence").id === id), `${label} source evidence`)
    if (own(entry, "dataset evidence").sha256 !== rawHash(source).slice("sha256:".length)) throw new Error(`${label} source evidence hash mismatch`)
  }
  action(graph, handoff.mapping.baselineActionUid, handoff.mapping.baselineRuleUid, "baseline")
  action(graph, handoff.mapping.candidateActionUid, handoff.mapping.candidateRuleUid, "candidate")
  const report = own(parseJson(artifacts.report, "report"), "report")
  if (report.schema !== "hswm-w-report/v1" || report.inputUid !== dataset.uid || report.inputRevision !== dataset.revision || report.inputDigest !== hswmDigest(dataset)) throw new Error("report does not bind this dataset")
  const policyReport = own(report.policy, "report policy")
  const selectedPolicy = one(list(policyReport.contexts, "report policy contexts").filter(value => own(value, "report policy context").contextUid === handoff.mapping.contextUid), "mapped report policy")
  const selectedPolicyRecord = own(selectedPolicy, "report policy context")
  if (selectedPolicyRecord.contextRevision !== handoff.mapping.contextRevision || selectedPolicyRecord.baselineActionUid !== handoff.mapping.baselineActionUid
    || ![handoff.mapping.baselineActionUid, handoff.mapping.candidateActionUid].includes(selectedPolicyRecord.chosenActionUid as string)
    || !["LEARNED_CANDIDATE", "UNKNOWN_KEEP_BASELINE"].includes(selectedPolicyRecord.status as string)) throw new Error("report policy mapping mismatch")
  const evaluation = one(list(report.evaluations, "report evaluations").filter(value => own(value, "evaluation").contextUid === handoff.mapping.contextUid), "mapped evaluation")
  const evaluationRecord = own(evaluation, "evaluation")
  if (evaluationRecord.policyUid !== selectedPolicyRecord.uid) throw new Error("evaluation policy binding mismatch")
  const status = reviewStatus(evaluationRecord.status), chosenActionUid = selectedPolicyRecord.chosenActionUid as string
  const consistent = evaluationRecord.status === "READY_FOR_OWNER_REVIEW" || evaluationRecord.status === "MORE_EVIDENCE_OR_REJECT"
    ? chosenActionUid === handoff.mapping.candidateActionUid && selectedPolicyRecord.status === "LEARNED_CANDIDATE"
    : evaluationRecord.status === "NO_CHANGE"
      ? chosenActionUid === handoff.mapping.baselineActionUid && selectedPolicyRecord.status === "LEARNED_CANDIDATE"
      : chosenActionUid === handoff.mapping.candidateActionUid ? selectedPolicyRecord.status === "LEARNED_CANDIDATE"
        : selectedPolicyRecord.status === "UNKNOWN_KEEP_BASELINE"
  if (!consistent) throw new Error("report status/chosen action mismatch")
  const selectedProposal = one(list(report.proposals, "report proposals").filter(value => own(value, "proposal").contextUid === handoff.mapping.contextUid), "mapped proposal")
  const selectedProposalRecord = own(selectedProposal, "proposal")
  const readSet = own(selectedProposalRecord.readSet, "proposal read set"), before = own(selectedProposalRecord.before, "proposal before"), after = own(selectedProposalRecord.after, "proposal after"), rollback = own(selectedProposalRecord.rollback, "proposal rollback")
  if (selectedProposalRecord.status !== evaluationRecord.status || readSet.policyUid !== selectedPolicyRecord.uid || readSet.evaluationUid !== evaluationRecord.uid
    || readSet.graphUid !== graph.uid || readSet.contextRevision !== handoff.mapping.contextRevision
    || selectedProposalRecord.expectedGraphRevision !== graph.revision || selectedProposalRecord.expectedGraphDigest !== hswmDigest(graph)
    || before.contextUid !== handoff.mapping.contextUid || after.contextUid !== handoff.mapping.contextUid || rollback.contextUid !== handoff.mapping.contextUid
    || before.actionUid !== handoff.mapping.baselineActionUid || rollback.actionUid !== handoff.mapping.baselineActionUid || after.actionUid !== chosenActionUid) throw new Error("proposal/evaluation binding mismatch")
  if (contractDigest(before) !== contractDigest(placement) || after.uid !== before.uid || contractDigest(rollback) !== contractDigest(before)) throw new Error("proposal before/after/rollback does not bind the dataset placement")
  const nodes = list(own(report.graph, "report graph").nodes, "report graph nodes"), edges = list(own(report.graph, "report graph").edges, "report graph edges")
  const node = (uid: unknown, type: string, label: string) => one(nodes.filter(value => { const record = own(value, "report graph node"); return record.uid === uid && record.type === type }), label)
  const exactEdge = (from: unknown, to: unknown, predicate: string, label: string) => one(edges.filter(edge => { const value = own(edge, "report graph edge"); return value.from === from && value.to === to && value.predicate === predicate }), label)
  const contextNode = node(handoff.mapping.contextUid, "Context", "context graph node"), policyNode = node(selectedPolicyRecord.uid, "ActivationPolicy", "policy graph node"), evaluationNode = node(evaluationRecord.uid, "PolicyEvaluation", "evaluation graph node"), proposalNode = node(selectedProposalRecord.uid, "PlacementProposal", "proposal graph node")
  if (contractDigest(own(contextNode, "context graph node").payload) !== contractDigest(contextRecord) || contractDigest(own(policyNode, "policy graph node").payload) !== contractDigest(selectedPolicyRecord) || contractDigest(own(evaluationNode, "evaluation graph node").payload) !== contractDigest(evaluationRecord) || contractDigest(own(proposalNode, "proposal graph node").payload) !== contractDigest(selectedProposalRecord)) throw new Error("typed HSWM graph payload mismatch")
  const assessment = one(nodes.filter(value => own(value, "report graph node").type === "WeightAssessment" && edges.some(edge => { const record = own(edge, "report graph edge"); return record.from === selectedPolicyRecord.uid && record.to === own(value, "report graph node").uid && record.predicate === "LEARNED_FROM" })), "weight assessment")
  const assessmentUid = own(assessment, "weight assessment").uid
  const expectedAssessmentPayload = { weights: selectedPolicyRecord.weights, trainDigest: policyReport.trainDigest, datasetUid: dataset.uid, datasetRevision: dataset.revision }
  if (contractDigest(own(assessment, "weight assessment").payload) !== contractDigest(expectedAssessmentPayload)) throw new Error("weight assessment payload mismatch")
  exactEdge(assessmentUid, handoff.mapping.contextUid, "ASSESSES", "assessment/context edge")
  exactEdge(selectedPolicyRecord.uid, assessmentUid, "LEARNED_FROM", "policy/assessment edge")
  exactEdge(evaluationRecord.uid, selectedPolicyRecord.uid, "EVALUATES", "evaluation/policy edge")
  exactEdge(selectedProposalRecord.uid, evaluationRecord.uid, "JUSTIFIED_BY", "proposal/evaluation edge")
  const learnerEstimates = freezeContract({ utilityDelta: estimate(evaluationRecord.utilityDelta, "utilityDelta"), successDelta: estimate(evaluationRecord.successDelta, "successDelta"), tokenEstimate: estimate(evaluationRecord.tokenEstimate, "tokenEstimate"), baselineTokenEstimate: estimate(evaluationRecord.baselineTokenEstimate, "baselineTokenEstimate") })
  const preparedBody = { schema: "usl-rule-weight-review-prepared/v1" as const, handoff, handoffDigest: contractDigest(handoff), artifacts: Object.fromEntries(Object.entries(artifacts).map(([key, value]) => [key, { raw: value, sha256: rawHash(value) }])),
    proposal, dataset: { uid: dataset.uid, revision: dataset.revision, digest: hswmDigest(dataset), dataKind: dataset.dataKind }, mapping: handoff.mapping,
    selected: { policyUid: selectedPolicyRecord.uid, evaluationUid: evaluationRecord.uid, proposalUid: selectedProposalRecord.uid, placementUid: before.uid, status: evaluationRecord.status, reviewStatus: status, before, after, rollback }, learnerEstimates,
    semantics: { coefficientChanges: proposal.changes, learnedEstimate: "PRESERVED_ONLY_IN_PINNED_HSWM_REPORT; NOT_A_COEFFICIENT", operationalEfficacy: null, execution: "NOT_REQUESTED", authority: "NOT_GRANTED" } }
  const prepared = freezeContract({ ...preparedBody, digest: contractDigest({ handoffDigest: preparedBody.handoffDigest, artifactSha256: Object.fromEntries(Object.entries(artifacts).map(([key, value]) => [key, rawHash(value)])), selected: preparedBody.selected, proposalDigest: proposal.proposalDigest }) })
  preparedTokens.add(prepared)
  return prepared
}

export const completeRuleWeightReview = (prepared: ReturnType<typeof prepareRuleWeightReview>, replayInput: unknown) => {
  if (!preparedTokens.has(prepared)) throw new Error("prepared review was not created by this runtime")
  const replay = z.strictObject({ scope: z.literal("INDEPENDENT_LOCAL_COPIES"), replays: z.array(z.unknown()), held: z.array(z.unknown()) }).parse(contractSnapshot(replayInput, 2 * 1024 * 1024))
  const same = (item: unknown) => own(item, "replay entry").proposalUid === prepared.selected.proposalUid || own(item, "replay entry").uid === prepared.selected.proposalUid
  const replays = replay.replays.filter(same), held = replay.held.filter(same)
  if (prepared.selected.status === "READY_FOR_OWNER_REVIEW") {
    const entry = one(replays, "selected replay")
    const record = own(entry, "selected replay"), replayGraph = own(record.graph, "selected replay graph"), dataset = own(parseJson(prepared.artifacts.dataset!.raw, "prepared dataset"), "prepared dataset"), baseGraph = own(dataset.graph, "prepared dataset graph")
    if (held.length || record.scope !== "LOCAL_COPY_ONLY" || record.rollbackVerified !== true || record.originalRulesUnchanged !== true || record.unchangedOtherPlacements !== true || record.beforeDigest !== hswmDigest(baseGraph) || record.restoredDigest !== hswmDigest(baseGraph) || record.afterDigest !== hswmDigest(replayGraph)) throw new Error("selected replay lacks verified local rollback")
    if (replayGraph.uid !== baseGraph.uid || contractDigest(replayGraph.rules) !== contractDigest(baseGraph.rules) || contractDigest(replayGraph.actions) !== contractDigest(baseGraph.actions) || contractDigest(replayGraph.contexts) !== contractDigest(baseGraph.contexts)) throw new Error("selected replay changed immutable graph content")
    const beforePlacements = list(baseGraph.placements, "base placements"), afterPlacements = list(replayGraph.placements, "replay placements")
    if (beforePlacements.length !== afterPlacements.length) throw new Error("selected replay changed placement cardinality")
    const selectedBasePlacements = beforePlacements.filter(value => own(value, "base placement").uid === prepared.selected.placementUid)
    if (selectedBasePlacements.length !== 1 || contractDigest(selectedBasePlacements[0]) !== contractDigest(prepared.selected.before)) throw new Error("selected base placement is missing or stale")
    for (const beforePlacement of beforePlacements) {
      const base = own(beforePlacement, "base placement"), afterPlacement = one(afterPlacements.filter(value => own(value, "replay placement").uid === base.uid), "replay placement")
      if (base.uid === prepared.selected.placementUid ? contractDigest(afterPlacement) !== contractDigest(prepared.selected.after) : contractDigest(afterPlacement) !== contractDigest(base)) throw new Error("selected replay changed an unexpected placement")
    }
  } else {
    const entry = one(held, "selected held proposal")
    if (replays.length || own(entry, "selected held proposal").status !== prepared.selected.status) throw new Error("selected non-ready proposal replay mismatch")
  }
  const body = { schema: "usl-rule-weight-review-receipt/v1" as const, preparedDigest: prepared.digest, handoffId: prepared.handoff.id, handoffVersion: prepared.handoff.version,
    reviewedAt: prepared.handoff.reviewedAt, timeSource: "CALLER_DECLARED" as const, reviewStatus: prepared.selected.reviewStatus, selected: prepared.selected,
    coefficientChanges: prepared.proposal.changes, learnerEstimates: prepared.learnerEstimates, learnedEstimate: "NOT_COPIED_TO_COEFFICIENTS", dataKind: prepared.dataset.dataKind,
    reportedOperationalEfficacy: null, replay: { source: "HOST_REPORTED", digest: contractDigest(replay), scope: replay.scope },
    disposition: "REVIEW_ONLY_NOT_APPLIED", execution: "NOT_REQUESTED", authority: "NOT_GRANTED" }
  return freezeContract({ ...body, digest: contractDigest(body) })
}
