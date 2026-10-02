/** Deterministic declarations and synthetic examples; never a historical test-pass receipt. */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Either } from "effect"
import { z } from "zod"
import { contractDigest } from "../src/contract-core.js"
import { parseDomainProfile } from "../src/domain-profile.js"
import { rulePolicySchema, ruleObservationsSchema, evaluateRulePolicy, readRulePolicyBinding } from "../src/addons/rule-policy.js"
import { resourceGraphJsonLd, adaptResourceGraph } from "../src/integrations/resource-graph.js"
import { digestSource } from "../src/language/digest.js"
import { configurationId, dashboardBindingGraph, dashboardContext, dashboardTarget, observeDashboardTarget } from "../examples/rule-policy-fixture.js"

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), check = process.argv.includes("--check")
if (process.argv.slice(2).some(arg => arg !== "--check")) throw new Error("usage: build-rule-policy.ts [--check]")
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"
const graph = dashboardBindingGraph(), policy = readRulePolicyBinding(graph, configurationId), rawTarget = json(dashboardTarget)
const observations = observeDashboardTarget(policy, rawTarget, "2026-10-02T00:00:00Z") // Explicit synthetic fixture clock.
const report = evaluateRulePolicy(policy, observations, dashboardContext(observations))
const addon = "urn:usl:addon:", status = "urn:usl:status:", rp = "urn:usl:rule-policy:"
const roles = (entries: Record<string, string>) => Object.entries(entries).map(([role, type]) => ({ role, required: true, types: [type], metadata: [] }))
const meaning = (id: string, entries: Record<string, string>) => ({ id, allowExtraRoles: false, roles: roles(entries) })
const profile = parseDomainProfile({ schema: "usl-domain-profile/v1", id: rp + "binding-profile", version: "1", closedMeanings: true, meanings: [
  meaning(addon + "applies_binding_rule", { rule: addon + "BindingRule", target: addon + "BindingTarget", configuration: addon + "BindingConfiguration", consumer: addon + "Program" }),
  meaning(rp + "evaluated_policy", { configuration: addon + "BindingConfiguration", target: addon + "BindingTarget", consumer: addon + "Program", result: rp + "Evaluation" }),
  meaning(rp + "realized_by", { task: status + "Task", feature: status + "Feature" }),
  meaning(status + "implemented_by", { feature: status + "Feature", artifact: status + "Artifact" }),
  meaning(status + "tested_by", { feature: status + "Feature", evidence: status + "TestEvidence" }),
  meaning(status + "bounded_by", { feature: status + "Feature", limitation: status + "Limitation" }),
  meaning(status + "informed_by", { task: status + "Task", source: status + "ExternalSource" }),
] })
const outputs: Record<string, string> = {
  "examples/fixtures/rule-policy/graph.json": json(graph),
  "examples/fixtures/rule-policy/policy.json": json(policy),
  "examples/fixtures/rule-policy/target.json": rawTarget,
  "examples/fixtures/rule-policy/observations.json": json(observations),
  "examples/fixtures/rule-policy/report.json": json(report),
  "research/rule-policy/profile.json": json(profile),
  "schemas/rule-policy/policy.schema.json": json(z.toJSONSchema(rulePolicySchema)),
  "schemas/rule-policy/observations.schema.json": json(z.toJSONSchema(ruleObservationsSchema)),
}

// A documented typed RDF projection of this addon, not an arbitrary JSON-LD importer.
outputs["examples/fixtures/rule-policy/policy.jsonld"] = json({
  "@context": { rp, xsd: "http://www.w3.org/2001/XMLSchema#" },
  "@graph": [{ "@id": policy.id, "@type": "rp:Policy", "rp:version": policy.version,
    "rp:target": { "@id": policy.target }, "rp:consumer": { "@id": policy.consumer }, "rp:scope": policy.scope,
    "rp:conflictPolicy": policy.conflictPolicy, "rp:scoring": policy.scoring,
    "rp:rule": policy.rules.map(rule => ({ "@id": rule.id })) },
  ...policy.rules.map(rule => ({ "@id": rule.id, "@type": "rp:Rule", "rp:version": rule.version,
    "rp:description": rule.description, "rp:requirement": rule.requirement, "rp:severity": rule.severity,
    "rp:onViolation": rule.onViolation, "rp:weight": { "@value": rule.weight, "@type": "xsd:double" },
    "rp:evaluator": { "@id": rule.evaluator.id }, "rp:evaluatorVersion": rule.evaluator.version }))],
})

type Metadata = NonNullable<typeof graph.resources[number]["metadata"]>
const add = (id: string, type: string, locator: string, metadata: Metadata = {}) => graph.resources.push({ id, types: [type], locator, metadata })
const repositoryLocator = (path: string) => `https://github.com/gj3447/USL/blob/master/${path}`
const bindings: { id: string; representations: { id: string; relation: "working-copy"; kind: "workspace"; workspace: string; path: string }[] }[] = []
const bind = (id: string, path: string) => bindings.push({ id, representations: [{ id: `local-${bindings.length}`, relation: "working-copy", kind: "workspace", workspace: "usl", path }] })
const local = async (id: string, type: string, path: string, metadata: Metadata = {}) => {
  const raw = outputs[path] ?? await readFile(resolve(root, path), "utf8")
  add(id, type, repositoryLocator(path), { path, sourceDigest: digestSource(raw), locatorStatus: "MUTABLE_REPOSITORY_ADDRESS_NOT_FETCHED", ...metadata })
  bind(id, path)
}
const link = (meaning: string, entries: Record<string, string>, metadata: Metadata = {}) => graph.links.push({
  id: `trace:${graph.links.length}`, meaning, participants: Object.entries(entries).map(([role, resource]) => ({ role, resource })), metadata,
})
for (const rule of policy.rules) bind(rule.id, "examples/fixtures/rule-policy/policy.json")
bind(configurationId, "examples/fixtures/rule-policy/policy.json")
bind(policy.target, "examples/fixtures/rule-policy/target.json")
bind(policy.consumer, "examples/rule-policy-workflow.ts")
await local("trace:request", status + "ExternalSource", "research/rule-policy/request.json", { authority: "USER_PRIMARY", externalFeedback: "USER_REPORTED_ONLY" })
await local("trace:generator", status + "Artifact", "scripts/build-rule-policy.ts", { authority: "SECONDARY_AI" })
await local("trace:agent", status + "Agent", "research/rule-policy/request.json", { authority: "SECONDARY_AI", ratification: "NOT_CLAIMED" })
graph.resources.find(resource => resource.id === "trace:agent")!.types.push("http://www.w3.org/ns/prov#Agent")
add("trace:activity", "http://www.w3.org/ns/prov#Activity", repositoryLocator("scripts/build-rule-policy.ts"), { scope: "DETERMINISTIC_SOURCE_TRACEABILITY", testExecution: "NOT_CLAIMED" })
add("trace:task", status + "Task", repositoryLocator("docs/RULE_POLICY.md"), { scope: "OPTIONAL_RULE_POLICY_CONTRACT", implementationChoices: "SECONDARY_AI" })
link(status + "informed_by", { task: "trace:task", source: "trace:request" })
const standards = [
  { id: "shacl", url: "https://www.w3.org/TR/2017/REC-shacl-20170720/", status: "W3C_RECOMMENDATION", use: "RDF shape validation; severity alone does not select application enforcement" },
  { id: "shacl12", url: "https://www.w3.org/TR/2026/WD-shacl12-core-20260918/", status: "W3C_WORKING_DRAFT", use: "Design reference for explicit conformance-disallow settings; NOT_IMPLEMENTED" },
  { id: "rdf12", url: "https://www.w3.org/TR/rdf12-concepts/", status: "CANDIDATE_RECOMMENDATION_SNAPSHOT_AT_REVIEW", use: "Version/status tracking only; no RDF 1.2 conformance claim" },
  { id: "prov", url: "https://www.w3.org/TR/prov-o/", status: "W3C_RECOMMENDATION", use: "Existing JSON-LD export preserves entity/activity/agent provenance" },
]
for (const standard of standards) {
  add(`standard:${standard.id}`, status + "ExternalSource", standard.url, { checkedOn: "2026-10-02", publicationStatus: standard.status, application: standard.use })
  link(status + "informed_by", { task: "trace:task", source: `standard:${standard.id}` })
}
const artifacts = ["src/addons/rule-policy.ts", "examples/rule-policy-fixture.ts", "examples/rule-policy-workflow.ts",
  "schemas/rule-policy/policy.shacl.ttl", "schemas/rule-policy/policy.schema.json", "schemas/rule-policy/observations.schema.json", "docs/RULE_POLICY.md"]
for (const path of artifacts) await local(`artifact:${path}`, status + "Artifact", path)
await local("test:behavior", status + "TestEvidence", "test/rule-policy.test.ts", { evidenceKind: "TEST_DEFINITION", execution: "NOT_CLAIMED" })
await local("test:standards", status + "TestEvidence", "scripts/validate-rule-policy.py", { evidenceKind: "VALIDATOR_DEFINITION", execution: "NOT_CLAIMED" })
add("feature:rule-policy", status + "Feature", repositoryLocator("docs/RULE_POLICY.md"), { authority: "SECONDARY_AI", scope: "DECLARATION_AND_PURE_REFERENCE_CONSUMER" })
link(rp + "realized_by", { task: "trace:task", feature: "feature:rule-policy" })
for (const path of artifacts) link(status + "implemented_by", { feature: "feature:rule-policy", artifact: `artifact:${path}` })
for (const evidence of ["test:behavior", "test:standards"]) link(status + "tested_by", { feature: "feature:rule-policy", evidence }, { execution: "NOT_CLAIMED" })
add("limitation:scope", status + "Limitation", repositoryLocator("docs/RULE_POLICY.md"), {
  detail: "No live dashboard integration, arbitrary predicate engine, conflict discovery, automatic exceptions, permissions, signed evidence, RDF 1.2 or SHACL 1.2 implementation. Base DomainProfile behavior remains strict.",
})
link(status + "bounded_by", { feature: "feature:rule-policy", limitation: "limitation:scope" })
await local("example:evaluation", rp + "Evaluation", "examples/fixtures/rule-policy/report.json", {
  report, evidenceKind: "SYNTHETIC_EXAMPLE_RESULT", clock: "FIXED_FIXTURE_CLOCK_NOT_EXECUTION_TIME", policyDigest: contractDigest(policy),
})
link(rp + "evaluated_policy", { configuration: configurationId, target: policy.target, consumer: policy.consumer, result: "example:evaluation" },
  { scope: "SYNTHETIC_EXAMPLE", liveDashboardConnection: false })
graph.provenance = { sources: ["trace:request", "trace:generator"], activity: "trace:activity", agent: "trace:agent" }
graph.meanings = profile.meanings.map(m => ({ id: m.id, description: `Declared role binding ${m.id}; see RULE_POLICY.md for domain/range and scope.` }))
const rawGraph = json(graph)
Either.getOrThrow(adaptResourceGraph(rawGraph, { namespace: "usl.rule-policy", profile }))
outputs["research/rule-policy/graph.json"] = rawGraph
outputs["research/rule-policy/graph.jsonld"] = json(Either.getOrThrow(resourceGraphJsonLd(rawGraph, { namespace: "usl.rule-policy", profile })))
outputs["research/rule-policy/bindings.json"] = json({ schema: "usl-resource-bindings/v1", resources: bindings })
outputs["research/rule-policy/selections.json"] = json(bindings.map(binding => ({ resource: binding.id, representation: binding.representations[0]!.id })))
outputs["research/rule-policy/host.json"] = json({ schema: "usl-cli-host/v1", bindings: "bindings.json", workspaces: { usl: "../.." }, maxSourceBytes: 1048576, actions: [] })
for (const [path, value] of Object.entries(outputs)) {
  const absolute = resolve(root, path)
  if (check) { if (await readFile(absolute, "utf8") !== value) throw new Error(`rule policy artifact differs: ${path}`) }
  else { await mkdir(dirname(absolute), { recursive: true }); await writeFile(absolute, value) }
}
console.log(json({ mode: check ? "ARTIFACTS_CHECKED" : "ARTIFACTS_BUILT", resources: graph.resources.length, links: graph.links.length,
  exampleDecision: report.decision, examplePenalty: report.penalty, historicalTestsClaimed: false }))
