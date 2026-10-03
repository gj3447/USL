/**
 * Optional, pure evidence contract for owner-proposed future rule weights.
 * It neither learns nor installs HSWM W values, and performs no IO.
 */
import { z } from "zod"
import { contractDigest, contractHash, contractIri, contractSnapshot, contractText, freezeContract, uniqueContractIds } from "../contract-core.js"
import { evaluateRulePolicy, parseRulePolicy, type RuleEvaluationContext, type RuleObservations, type RulePolicy } from "./rule-policy.js"

const identitySchema = z.strictObject({ id: contractIri, version: contractText, digest: contractHash })
const metricSchema = z.strictObject({ id: contractIri, version: contractText, direction: z.enum(["MAXIMIZE", "MINIMIZE"]) })
const outcomeEvaluatorSchema = z.strictObject({ id: contractIri, version: contractText })
const actionSchema = z.strictObject({
  ...identitySchema.shape,
  participants: z.array(z.strictObject({ role: contractText, ordinal: z.number().int().min(0), source: identitySchema })).min(1).max(256),
})

export const ruleWeightEvidenceSchema = z.strictObject({
  schema: z.literal("usl-rule-weight-evidence/v1"), id: contractIri, version: contractText,
  context: identitySchema, action: actionSchema, independentUnit: contractText,
  selectionProbability: z.number().gt(0).max(1).nullable(), observedAt: z.iso.datetime(),
  evaluationDigest: contractHash,
  outcome: z.strictObject({
    metric: metricSchema, value: z.number(),
    source: z.strictObject({ resource: contractText, digest: contractHash }),
    evaluator: outcomeEvaluatorSchema, basis: z.literal("EXTERNAL_TASK_MEASUREMENT"),
  }),
  costs: z.array(z.strictObject({ kind: contractText, amount: z.number().min(0), unit: contractText })).max(256),
  evidenceClass: z.enum(["SYNTHETIC", "OWNER_REPORTED"]),
})
export type RuleWeightEvidence = z.infer<typeof ruleWeightEvidenceSchema>

/** Independently registered pins; an evidence packet cannot replace these registrations. */
export const ruleWeightEvidenceHostSchema = z.strictObject({
  expectedEvidenceDigest: contractHash, expectedContext: identitySchema, expectedAction: actionSchema,
  registeredOutcomeMetric: metricSchema, registeredOutcomeEvaluator: outcomeEvaluatorSchema,
})
export type RuleWeightEvidenceHost = z.infer<typeof ruleWeightEvidenceHostSchema>

export const ruleWeightProposalSchema = z.strictObject({
  schema: z.literal("usl-rule-weight-proposal/v1"), id: contractIri, version: contractText, createdAt: z.iso.datetime(),
  basePolicyDigest: contractHash, evidenceDigest: contractHash, nextPolicyVersion: contractText,
  scope: contractText, context: identitySchema, method: z.literal("OWNER_PROPOSED"), rationale: contractText,
  changes: z.array(z.strictObject({ rule: contractIri, ruleVersion: contractText, fromWeight: z.number().min(0).max(1), toWeight: z.number().min(0).max(1) })).min(1).max(256),
})
export type RuleWeightProposal = z.infer<typeof ruleWeightProposalSchema>

const same = (one: unknown, two: unknown): boolean => contractDigest(one) === contractDigest(two)
const atOrAfter = (later: string, earlier: string): boolean => Date.parse(later) >= Date.parse(earlier)

/**
 * Verifies that owner-reported external outcome evidence names this exact completed
 * evaluation. IDs/digests can bind records, but do not establish independence or truth.
 */
export const parseRuleWeightEvidence = (
  input: unknown, policyInput: unknown, observationsInput: unknown,
  evaluationContext: RuleEvaluationContext, hostInput: unknown,
): RuleWeightEvidence => {
  const evidence = ruleWeightEvidenceSchema.parse(contractSnapshot(input))
  const host = ruleWeightEvidenceHostSchema.parse(contractSnapshot(hostInput))
  const policy = parseRulePolicy(policyInput)
  const evaluation = evaluateRulePolicy(policy, observationsInput, evaluationContext)
  if (contractDigest(evidence) !== host.expectedEvidenceDigest) throw new Error("unregistered rule weight evidence digest")
  if (!same(evidence.context, host.expectedContext) || !same(evidence.action, host.expectedAction)) throw new Error("rule weight evidence context/action pin mismatch")
  uniqueContractIds(evidence.action.participants.map(participant => JSON.stringify([participant.role, participant.ordinal])), "action participant roles/ordinals")
  if (!same(evidence.outcome.metric, host.registeredOutcomeMetric) || !same(evidence.outcome.evaluator, host.registeredOutcomeEvaluator)) {
    throw new Error("unregistered outcome metric/evaluator")
  }
  if (evidence.evaluationDigest !== evaluation.digest) throw new Error("stale rule evaluation digest")
  if (!atOrAfter(evidence.observedAt, evaluation.observedAt)) throw new Error("outcome predates rule evaluation")
  // An evaluation report or its raw target snapshot cannot be relabelled as an external outcome.
  if ([evaluation.digest, evaluation.targetDigest, evaluation.observationsDigest, evaluation.policyDigest,
    evaluation.contextDigest].includes(evidence.outcome.source.digest)
    || evidence.outcome.source.resource === evaluation.target || evidence.outcome.source.resource === evaluation.policyId) {
    throw new Error("outcome source reuses rule evaluation or target snapshot")
  }
  return freezeContract(evidence)
}

/**
 * Makes an immutable candidate policy from explicit owner deltas. The caller must
 * record/review/apply it elsewhere; this is not canonical HSWM W and changes no state.
 */
export const proposeRuleWeights = (
  policyInput: unknown, evidenceInput: unknown, observationsInput: unknown,
  evaluationContext: RuleEvaluationContext, hostInput: unknown, proposalInput: unknown,
) => {
  const policy = parseRulePolicy(policyInput)
  const evidence = parseRuleWeightEvidence(evidenceInput, policy, observationsInput, evaluationContext, hostInput)
  const evaluation = evaluateRulePolicy(policy, observationsInput, evaluationContext)
  if (evaluation.decision !== "ELIGIBLE" || evaluation.coverage !== "COMPLETE") throw new Error("weight proposal requires eligible complete evaluation")
  const proposal = ruleWeightProposalSchema.parse(contractSnapshot(proposalInput))
  const host = ruleWeightEvidenceHostSchema.parse(contractSnapshot(hostInput))
  const basePolicyDigest = contractDigest(policy), evidenceDigest = contractDigest(evidence)
  if (proposal.basePolicyDigest !== basePolicyDigest || proposal.evidenceDigest !== evidenceDigest || proposal.evidenceDigest !== host.expectedEvidenceDigest) {
    throw new Error("stale policy or evidence proposal pin")
  }
  if (proposal.nextPolicyVersion === policy.version || proposal.scope !== policy.scope || !same(proposal.context, evidence.context)) {
    throw new Error("invalid next policy version, scope or context")
  }
  if (!atOrAfter(proposal.createdAt, evidence.observedAt)) throw new Error("proposal predates outcome evidence")
  uniqueContractIds(proposal.changes.map(change => change.rule), "weight proposal changes")
  const rules = new Map(policy.rules.map(rule => [rule.id, rule]))
  for (const change of proposal.changes) {
    const rule = rules.get(change.rule)
    if (!rule || rule.version !== change.ruleVersion || rule.requirement !== "RECOMMENDED" || rule.onViolation !== "PENALIZE"
      || rule.weight !== change.fromWeight || change.toWeight <= 0 || change.fromWeight === change.toWeight) {
      throw new Error("invalid rule weight change")
    }
  }
  const candidate = structuredClone(policy)
  candidate.version = proposal.nextPolicyVersion
  for (const change of proposal.changes) candidate.rules.find(rule => rule.id === change.rule)!.weight = change.toWeight
  const candidatePolicy = parseRulePolicy(candidate)
  const body = {
    schema: "usl-rule-weight-proposal-result/v1" as const, proposalId: proposal.id, proposalVersion: proposal.version,
    proposalDigest: contractDigest(proposal), proposalCreatedAt: proposal.createdAt, proposalMethod: proposal.method, proposalRationale: proposal.rationale,
    evidenceId: evidence.id, evidenceVersion: evidence.version, basePolicy: policy, basePolicyDigest, candidatePolicy,
    candidatePolicyDigest: contractDigest(candidatePolicy), evidenceDigest, evaluationDigest: evaluation.digest,
    context: evidence.context, action: evidence.action, outcome: evidence.outcome, changes: proposal.changes,
    disposition: "PROPOSED_NOT_APPLIED" as const, effectiveness: "NOT_ESTABLISHED" as const,
    canonicalW: "NOT_CLAIMED" as const, hswmIntegration: { status: "NOT_CONNECTED" as const, relation: "CANDIDATE_INPUT_ONLY" as const },
    execution: "NOT_REQUESTED" as const, authority: "NOT_GRANTED" as const,
  }
  return freezeContract({ ...body, digest: contractDigest(body) })
}
