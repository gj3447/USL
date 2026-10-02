/** Synthetic dashboard consumer: no connection to metahumotonic_dashboard. */
import { z } from "zod"
import { contractDigest, uniqueContractIds } from "../src/contract-core.js"
import { digestSource } from "../src/language/digest.js"
import { parseRulePolicy, type RulePolicy, type RuleObservations, type RuleEvaluationContext } from "../src/addons/rule-policy.js"
import type { ResourceGraph } from "../src/integrations/resource-graph.js"

export const configurationId = "example:dashboard-rule-configuration"
export const dashboardTarget: { schema: string; records: { id: string; references: string[]; source: string | null; tags: string[] }[] } = {
  schema: "dashboard-memory-example/v1",
  records: [
    { id: "memory:a", references: [], source: "urn:example:source:a", tags: [] },
    { id: "memory:b", references: ["memory:a"], source: null, tags: [] },
  ],
}
export const dashboardEvaluators = ["references-exist", "sources-present", "tags-present"].map(name => ({ id: `urn:example:dashboard:${name}`, version: "1" }))
export const dashboardPolicy = (): RulePolicy => parseRulePolicy({
  schema: "usl-rule-policy/v1", id: "urn:example:dashboard:memory-policy", version: "1",
  target: "example:dashboard-memory", consumer: "example:dashboard-consumer", scope: "example-memory-quality",
  conflictPolicy: "REJECT", scoring: "WEIGHTED_MEAN_VIOLATION_V1",
  rules: [
    { id: "urn:example:rule:references", version: "1", description: "Every memory reference names an existing record",
      requirement: "REQUIRED", severity: "VIOLATION", onViolation: "BLOCK", weight: 0, evaluator: dashboardEvaluators[0] },
    { id: "urn:example:rule:sources", version: "1", description: "Prefer a declared original source for every record; does not verify the source",
      requirement: "RECOMMENDED", severity: "WARNING", onViolation: "PENALIZE", weight: 0.8, evaluator: dashboardEvaluators[1] },
    { id: "urn:example:rule:tags", version: "1", description: "Prefer at least one tag for every record",
      requirement: "RECOMMENDED", severity: "INFO", onViolation: "PENALIZE", weight: 0.2, evaluator: dashboardEvaluators[2] },
  ],
})

export const dashboardBindingGraph = (): ResourceGraph => {
  const policy = dashboardPolicy()
  return {
    schema: "usl-resource-graph/v1",
    resources: [
      ...policy.rules.map(rule => ({ id: rule.id, types: ["urn:usl:addon:BindingRule"], locator: `https://example.invalid/rules/${rule.id.split(":").at(-1)}`,
        metadata: { ruleId: rule.id, ruleVersion: rule.version } })),
      { id: policy.target, types: ["urn:usl:addon:BindingTarget"], locator: "https://example.invalid/dashboard/memory" },
      { id: configurationId, types: ["urn:usl:addon:BindingConfiguration"], locator: "https://example.invalid/dashboard/policy", metadata: { policy } },
      { id: policy.consumer, types: ["urn:usl:addon:Program"], locator: "https://example.invalid/dashboard/example-consumer" },
      { id: "example:source", types: ["urn:usl:addon:Evidence"], locator: "https://example.invalid/dashboard/source",
        metadata: { authority: "SECONDARY_AI", scope: "SYNTHETIC_EXAMPLE", liveDashboardConnection: false } },
    ],
    meanings: [{ id: "urn:usl:addon:applies_binding_rule", description: "An explicit consumer interprets a versioned rule for one target and configuration; no authority is granted." }],
    links: policy.rules.map((rule, index) => ({ id: `example:rule-binding:${index}`, meaning: "urn:usl:addon:applies_binding_rule",
      participants: [{ role: "rule", resource: rule.id }, { role: "target", resource: policy.target },
        { role: "configuration", resource: configurationId }, { role: "consumer", resource: policy.consumer }] })),
    provenance: { sources: ["example:source"] },
  }
}

const targetSchema = z.strictObject({ schema: z.literal("dashboard-memory-example/v1"), records: z.array(z.strictObject({
  id: z.string().min(1), references: z.array(z.string().min(1)), source: z.string().min(1).nullable(), tags: z.array(z.string().min(1)),
})).min(1).max(1024) })

/** Actual example predicates run here, outside the USL core and optional contract. */
export const observeDashboardTarget = (policy: RulePolicy, raw: string, observedAt: string): RuleObservations => {
  if (Buffer.byteLength(raw, "utf8") > 1024 * 1024) throw new Error("example target exceeds 1 MiB")
  const target = targetSchema.parse(JSON.parse(raw))
  uniqueContractIds(target.records.map(record => record.id), "memory IDs")
  const ids = new Set(target.records.map(record => record.id)), targetDigest = digestSource(raw)
  const checks = new Map<string, number>([
    [dashboardEvaluators[0]!.id, target.records.filter(record => record.references.some(id => !ids.has(id))).length / target.records.length],
    [dashboardEvaluators[1]!.id, target.records.filter(record => record.source === null).length / target.records.length],
    [dashboardEvaluators[2]!.id, target.records.filter(record => record.tags.length === 0).length / target.records.length],
  ])
  return { schema: "usl-rule-observations/v1", policyDigest: contractDigest(policy), target: policy.target, targetDigest,
    scope: policy.scope, observedAt, conflicts: [], observations: policy.rules.map(rule => {
      const violation = rule.evaluator.version === "1" ? checks.get(rule.evaluator.id) : undefined
      return { rule: rule.id, ruleVersion: rule.version, evaluator: rule.evaluator,
        status: violation === undefined ? "UNKNOWN" : violation === 0 ? "PASS" : "FAIL", violation: violation ?? null,
        evidence: violation === undefined ? [] : [{ resource: policy.target, digest: targetDigest }],
        detail: violation === undefined ? "Example predicate unavailable" : "Fraction of records violating this example predicate; source URLs were not fetched",
      }
    }) }
}

export const dashboardContext = (packet: RuleObservations): RuleEvaluationContext => ({
  expectedPolicyDigest: contractDigest(dashboardPolicy()),
  consumer: "example:dashboard-consumer", target: packet.target, targetDigest: packet.targetDigest,
  scope: "example-memory-quality", supportedEvaluators: dashboardEvaluators,
})
