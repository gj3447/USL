/** Optional addon contract and pure reference consumer. Never installed by the core adapter. */
import { z } from "zod"
import { Either } from "effect"
import { contractDigest, contractHash, contractIri, contractSnapshot, contractText, freezeContract, uniqueContractIds } from "../contract-core.js"
import { parseResourceGraph } from "../integrations/resource-graph.js"

const evaluatorSchema = z.strictObject({ id: contractIri, version: contractText })
export const rulePolicySchema = z.strictObject({
  schema: z.literal("usl-rule-policy/v1"), id: contractIri, version: contractText,
  target: contractText, consumer: contractText, scope: contractText,
  conflictPolicy: z.literal("REJECT"), scoring: z.literal("WEIGHTED_MEAN_VIOLATION_V1"),
  rules: z.array(z.strictObject({
    id: contractIri, version: contractText, description: contractText,
    requirement: z.enum(["REQUIRED", "RECOMMENDED", "INFORMATIONAL"]),
    severity: z.enum(["VIOLATION", "WARNING", "INFO"]),
    onViolation: z.enum(["BLOCK", "WARN", "PENALIZE", "RECORD"]),
    weight: z.number().min(0).max(1), evaluator: evaluatorSchema,
  })).min(1).max(256),
})
export type RulePolicy = z.infer<typeof rulePolicySchema>

export const parseRulePolicy = (input: unknown): RulePolicy => {
  const policy = rulePolicySchema.parse(contractSnapshot(input))
  uniqueContractIds(policy.rules.map(rule => rule.id), "rule IDs")
  for (const rule of policy.rules) {
    const validAction = rule.requirement === "REQUIRED" ? rule.onViolation === "BLOCK"
      : rule.requirement === "INFORMATIONAL" ? rule.onViolation === "RECORD"
      : rule.onViolation === "WARN" || rule.onViolation === "PENALIZE"
    if (!validAction) throw new Error(`incompatible requirement/onViolation: ${rule.id}`)
    if (rule.onViolation === "PENALIZE" ? rule.weight <= 0 : rule.weight !== 0) throw new Error(`incompatible weight/onViolation: ${rule.id}`)
  }
  return freezeContract(policy)
}

const evidenceSchema = z.strictObject({ resource: contractText, digest: contractHash })
export const ruleObservationsSchema = z.strictObject({
  schema: z.literal("usl-rule-observations/v1"), policyDigest: contractHash,
  target: contractText, targetDigest: contractHash, scope: contractText, observedAt: z.iso.datetime(),
  observations: z.array(z.strictObject({
    rule: contractIri, ruleVersion: contractText, evaluator: evaluatorSchema,
    status: z.enum(["PASS", "FAIL", "UNKNOWN"]), violation: z.number().min(0).max(1).nullable(),
    evidence: z.array(evidenceSchema).max(64), detail: contractText,
  })).max(256),
  conflicts: z.array(z.strictObject({ rules: z.tuple([contractIri, contractIri]), detail: contractText })).max(256),
})
export type RuleObservations = z.infer<typeof ruleObservationsSchema>

/** Supplied directly by the consumer, never inferred from a graph or observation packet. */
const evaluationContextSchema = z.strictObject({
  expectedPolicyDigest: contractHash,
  consumer: contractText, target: contractText, targetDigest: contractHash, scope: contractText,
  supportedEvaluators: z.array(evaluatorSchema).max(256),
})
export type RuleEvaluationContext = z.infer<typeof evaluationContextSchema>
type ResultStatus = "PASS" | "FAIL" | "UNKNOWN" | "UNSUPPORTED" | "NOT_EVALUATED"
const evaluatorKey = (value: z.infer<typeof evaluatorSchema>) => JSON.stringify([value.id, value.version])

/**
 * Classifies owner-reported observations against an explicit snapshot and support set.
 * No IO, predicate execution, truth verification, conflict discovery or access grant.
 */
export const evaluateRulePolicy = (input: unknown, observationsInput: unknown, contextInput: RuleEvaluationContext) => {
  const policy = parseRulePolicy(input), packet = ruleObservationsSchema.parse(contractSnapshot(observationsInput))
  const context = evaluationContextSchema.parse(contractSnapshot(contextInput)), policyDigest = contractDigest(policy)
  if (packet.policyDigest !== policyDigest || context.expectedPolicyDigest !== policyDigest) throw new Error("stale or unregistered rule policy digest")
  if (policy.consumer !== context.consumer || policy.target !== context.target || policy.scope !== context.scope
    || packet.target !== context.target || packet.targetDigest !== context.targetDigest || packet.scope !== context.scope) {
    throw new Error("rule evaluation context/snapshot mismatch")
  }
  uniqueContractIds(packet.observations.map(row => row.rule), "observations")
  uniqueContractIds(context.supportedEvaluators.map(evaluatorKey), "supported evaluators")
  const rules = new Map(policy.rules.map(rule => [rule.id, rule]))
  for (const row of packet.observations) {
    const rule = rules.get(row.rule)
    if (!rule || row.ruleVersion !== rule.version || evaluatorKey(row.evaluator) !== evaluatorKey(rule.evaluator)) throw new Error("observation rule/evaluator binding mismatch")
    if (row.status === "PASS" ? row.violation !== 0 : row.status === "FAIL" ? row.violation === null || row.violation <= 0 : row.violation !== null) {
      throw new Error("observation status/violation mismatch")
    }
    // A known outcome needs evidence from the evaluated target snapshot, even for absence checks.
    if (row.status !== "UNKNOWN" && !row.evidence.some(item => item.resource === context.target && item.digest === context.targetDigest)) {
      throw new Error("known observation lacks target snapshot evidence")
    }
  }
  const conflictKeys = packet.conflicts.map(conflict => {
    const [one, two] = conflict.rules
    if (one === two || !rules.has(one) || !rules.has(two)) throw new Error("invalid conflict rule references")
    return JSON.stringify([...conflict.rules].sort())
  })
  uniqueContractIds(conflictKeys, "conflicts")
  const supported = new Set(context.supportedEvaluators.map(evaluatorKey))
  const observations = new Map(packet.observations.map(row => [row.rule, row]))
  const results = policy.rules.map(rule => {
    const row = observations.get(rule.id)
    const status: ResultStatus = !supported.has(evaluatorKey(rule.evaluator)) ? "UNSUPPORTED" : row?.status ?? "NOT_EVALUATED"
    const known = status === "PASS" || status === "FAIL"
    return { rule: rule.id, ruleVersion: rule.version, requirement: rule.requirement, severity: rule.severity,
      onViolation: rule.onViolation, weight: rule.weight, evaluator: rule.evaluator, status,
      violation: known ? row!.violation : null, evidence: row?.evidence ?? [],
      detail: status === "UNSUPPORTED" ? "Consumer does not support this evaluator version"
        : row?.detail ?? "No observation supplied",
    }
  })
  const unknown = (row: typeof results[number]) => row.status !== "PASS" && row.status !== "FAIL"
  const blocked = results.some(row => row.requirement === "REQUIRED" && row.status === "FAIL")
  const hardUnknown = results.some(row => row.requirement === "REQUIRED" && unknown(row))
  const decision = packet.conflicts.length ? "CONFLICT" as const : blocked ? "BLOCKED" as const
    : hardUnknown ? "UNDETERMINED" as const : "ELIGIBLE" as const
  const coverage = results.some(unknown) ? "INCOMPLETE" as const : "COMPLETE" as const
  const scored = results.filter(row => row.onViolation === "PENALIZE"), totalWeight = scored.reduce((sum, row) => sum + row.weight, 0)
  // Unknowns never improve a rank; hard violations cannot be offset by soft scores.
  const penalty = decision !== "ELIGIBLE" || coverage !== "COMPLETE" ? null
    : totalWeight === 0 ? 0 : scored.reduce((sum, row) => sum + row.weight * row.violation!, 0) / totalWeight
  const body = { schema: "usl-rule-evaluation/v1" as const, policyId: policy.id, policyVersion: policy.version, policyDigest,
    observationsDigest: contractDigest(packet), contextDigest: contractDigest(context),
    target: context.target, targetDigest: context.targetDigest, scope: context.scope, consumer: context.consumer,
    observedAt: packet.observedAt, decision, coverage, penalty, results, conflicts: packet.conflicts,
    evidenceTrust: "CONSUMER_REPORTED" as const, execution: "NOT_REQUESTED" as const, authority: "NOT_GRANTED" as const }
  return freezeContract({ ...body, digest: contractDigest(body) })
}
export type RuleEvaluation = ReturnType<typeof evaluateRulePolicy>

/** Extract only one explicitly selected addon configuration and verify all its binding roles. */
export const readRulePolicyBinding = (input: unknown, configurationId: string): RulePolicy => {
  const graph = Either.getOrThrowWith(parseResourceGraph(JSON.stringify(contractSnapshot(input))), error => new Error(error.detail))
  const resources = new Map(graph.resources.map(resource => [resource.id, resource]))
  const configuration = resources.get(configurationId)
  if (!configuration?.types.includes("urn:usl:addon:BindingConfiguration")) throw new Error("unknown rule policy configuration")
  const policy = parseRulePolicy(configuration.metadata?.policy)
  const expected = new Map(policy.rules.map(rule => [rule.id, rule])), seen = new Set<string>()
  for (const link of graph.links.filter(link => link.meaning === "urn:usl:addon:applies_binding_rule"
    && link.participants.some(participant => participant.role === "configuration" && participant.resource === configurationId))) {
    const roles = new Map(link.participants.map(participant => [participant.role, participant.resource]))
    const id = roles.get("rule"), rule = id === undefined ? undefined : expected.get(id)
    if (roles.size !== 4 || !rule || roles.get("target") !== policy.target || roles.get("consumer") !== policy.consumer || seen.has(rule.id)) {
      throw new Error("rule policy binding roles differ")
    }
    for (const [role, type] of [["rule", "BindingRule"], ["target", "BindingTarget"], ["consumer", "Program"]]) {
      if (!resources.get(roles.get(role!)!)?.types.includes(`urn:usl:addon:${type}`)) throw new Error("rule policy binding type differs")
    }
    const metadata = resources.get(rule.id)!.metadata
    if (metadata?.ruleId !== rule.id || metadata.ruleVersion !== rule.version) throw new Error("rule policy binding version differs")
    seen.add(rule.id)
  }
  if (seen.size !== expected.size) throw new Error("rule policy has missing bindings")
  return policy
}
