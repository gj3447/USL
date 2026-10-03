/** Deterministic trace of a synthetic proposal and archived offline learner review; no live apply. */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Either } from "effect"
import { contractDigest } from "../src/contract-core.js"
import { parseDomainProfile } from "../src/domain-profile.js"
import { resourceGraphJsonLd, adaptResourceGraph } from "../src/integrations/resource-graph.js"
import { digestSource } from "../src/language/digest.js"
import { ruleWeightEvidenceFixture } from "../examples/rule-weight-evidence-fixture.js"
import { ruleWeightEvidenceSchema, ruleWeightEvidenceHostSchema, ruleWeightProposalSchema } from "../src/addons/rule-weight-evidence.js"
import { z } from "zod"

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), check = process.argv.includes("--check")
if (process.argv.slice(2).some(arg => arg !== "--check")) throw new Error("usage: build-rule-weight-evidence.ts [--check]")
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"
const status = "urn:usl:status:", addon = "urn:usl:addon:", rp = "urn:usl:rule-policy:", rw = "urn:usl:rule-weight-evidence:"
const fixture = ruleWeightEvidenceFixture()
const { policy, observations, evaluationContext, evaluation, evidence, host, proposalInput, proposal } = fixture
const reviewFolder = "examples/fixtures/rule-weight-review"
const reviewFiles = Object.fromEntries(await Promise.all(["dataset", "report", "replay", "review"].map(async name => [name, await readFile(resolve(root, reviewFolder, `${name}.json`), "utf8")])) )
const learnerDataset = JSON.parse(reviewFiles.dataset!), learnerReport = JSON.parse(reviewFiles.report!), learnerReview = JSON.parse(reviewFiles.review!)
const learnerIds = { dataset: "trace:learner:dataset", report: "trace:learner:report", replay: "trace:learner:replay", review: "trace:learner:review" }
const output: Record<string, string> = {}
const graph = { schema: "usl-resource-graph/v1" as const, resources: [] as { id: string; types: string[]; locator: string; metadata?: Record<string, unknown> }[], meanings: [] as { id: string; description: string }[], links: [] as { id: string; meaning: string; participants: { role: string; resource: string }[]; metadata?: Record<string, unknown> }[], provenance: { sources: ["trace:request", "trace:generator"], activity: "trace:activity", agent: "trace:agent" } }
const roles = (entries: Record<string, string>) => Object.entries(entries).map(([role, type]) => ({ role, required: true, types: [type], metadata: [] }))
const meaning = (id: string, entries: Record<string, string>) => ({ id, allowExtraRoles: false, roles: roles(entries) })
const profile = parseDomainProfile({ schema: "usl-domain-profile/v1", id: rw + "binding-profile", version: "1", closedMeanings: true, meanings: [
  meaning(addon + "applies_binding_rule", { rule: addon + "BindingRule", target: addon + "BindingTarget", configuration: addon + "BindingConfiguration", consumer: addon + "Program" }),
  meaning(rw + "contextual_weight", { rule: rw + "Rule", configuration: addon + "BindingConfiguration", context: rw + "Context", weight: rw + "WeightAssignment" }),
  meaning(rp + "evaluated_policy", { configuration: addon + "BindingConfiguration", target: addon + "BindingTarget", consumer: addon + "Program", result: rp + "Evaluation" }),
  meaning(rw + "records_evidence", { evidence: rw + "Evidence", evaluation: rw + "Evaluation", context: rw + "Context", action: rw + "Action", outcome: rw + "Outcome" }),
  meaning(rw + "proposed_revision", { baseline: rw + "PolicySnapshot", candidate: rw + "PolicySnapshot", context: rw + "Context", evidence: rw + "Evidence", proposal: rw + "WeightRevisionProposal" }),
  meaning(rw + "candidate_input_to", { signal: rw + "Evidence", wConcept: rw + "HSWM_W_Concept" }),
  meaning(rw + "reviewed_with_learner", { proposal: rw + "WeightRevisionProposal", context: rw + "Context", dataset: rw + "LearningDataset", report: rw + "LearnerReport", replay: rw + "ReplayObservation", review: rw + "LearnerReview" }),
  meaning(rp + "realized_by", { task: status + "Task", feature: status + "Feature" }),
  meaning(status + "informed_by", { task: status + "Task", source: status + "ExternalSource" }),
  meaning(status + "implemented_by", { feature: status + "Feature", artifact: status + "Artifact" }),
  meaning(status + "tested_by", { feature: status + "Feature", evidence: status + "TestEvidence" }),
  meaning(status + "bounded_by", { feature: status + "Feature", limitation: status + "Limitation" }),
] })
const repo = (path: string) => `https://github.com/gj3447/USL/blob/master/${path}`
const add = (id: string, types: string[], locator: string, metadata: Record<string, unknown> = {}) => graph.resources.push({ id, types, locator, metadata })
const link = (meaning: string, participants: Record<string, string>, metadata: Record<string, unknown> = {}) => graph.links.push({ id: `trace:${graph.links.length}`, meaning, participants: Object.entries(participants).map(([role, resource]) => ({ role, resource })), metadata })
const bindings: { id: string; representations: { id: string; relation: "working-copy"; kind: "workspace"; workspace: string; path: string }[] }[] = []
const bind = (id: string, path: string) => bindings.push({ id, representations: [{ id: `local-${bindings.length}`, relation: "working-copy", kind: "workspace", workspace: "usl", path }] })
const local = async (id: string, types: string[], path: string, metadata: Record<string, unknown> = {}) => {
  const raw = output[path] ?? await readFile(resolve(root, path), "utf8")
  add(id, types, repo(path), { path, sourceDigest: digestSource(raw), locatorStatus: "MUTABLE_REPOSITORY_ADDRESS_NOT_FETCHED", ...metadata }); bind(id, path)
}

output["examples/fixtures/rule-weight-evidence/fixture.json"] = json({ policy, observations, evaluationContext, evaluation, contextSource: fixture.contextSource, actionSource: fixture.actionSource, outcomeSource: fixture.outcomeSource, evidence, host, proposalInput, proposal })
output["schemas/rule-weight-evidence/evidence.schema.json"] = json(z.toJSONSchema(ruleWeightEvidenceSchema))
output["schemas/rule-weight-evidence/host.schema.json"] = json(z.toJSONSchema(ruleWeightEvidenceHostSchema))
output["schemas/rule-weight-evidence/proposal.schema.json"] = json(z.toJSONSchema(ruleWeightProposalSchema))
const contextId = evidence.context.id, actionId = evidence.action.id, evidenceId = evidence.id, outcomeId = `${evidence.id}:outcome`
const proposalId = proposalInput.id, evaluationId = `trace:evaluation:${evaluation.digest.slice(7, 19)}`
const assignment = proposalInput.changes.map((change, index) => ({ change, baselineId: `trace:weight:${index}:baseline`, candidateId: `trace:weight:${index}:candidate` }))
const policyBaselineId = `trace:policy:${policy.id}:v${policy.version}`, policyCandidateId = `trace:policy:${proposal.candidatePolicy.id}:v${proposal.candidatePolicy.version}`
const configurationBaselineId = "example:dashboard-rule-configuration:baseline", configurationCandidateId = "example:dashboard-rule-configuration:candidate", targetId = policy.target, consumerId = policy.consumer
for (const rule of policy.rules) {
  add(rule.id, [addon + "BindingRule", rw + "Rule"], repo("examples/fixtures/rule-policy/policy.json"), { version: rule.version, requirement: rule.requirement, onViolation: rule.onViolation, gate: rule.requirement === "REQUIRED" ? "HARD" : "NOT_HARD", coefficientRole: rule.onViolation === "PENALIZE" ? "SOFT_WEIGHT_ELIGIBLE" : "NONE" })
  bind(rule.id, "examples/fixtures/rule-policy/policy.json")
}
add(policyBaselineId, [rw + "PolicySnapshot"], repo("examples/fixtures/rule-weight-evidence/fixture.json"), { policyId: policy.id, policyVersion: policy.version, digest: contractDigest(policy), snapshotState: "BASELINE" }); bind(policyBaselineId, "examples/fixtures/rule-weight-evidence/fixture.json")
add(policyCandidateId, [rw + "PolicySnapshot"], repo("examples/fixtures/rule-weight-evidence/fixture.json"), { policyId: proposal.candidatePolicy.id, policyVersion: proposal.candidatePolicy.version, digest: proposal.candidatePolicyDigest, snapshotState: "PROPOSED_NOT_APPLIED" }); bind(policyCandidateId, "examples/fixtures/rule-weight-evidence/fixture.json")
add(configurationBaselineId, [addon + "BindingConfiguration"], repo("examples/fixtures/rule-weight-evidence/fixture.json"), { policySnapshot: policyBaselineId, policyId: policy.id, policyVersion: policy.version, policyDigest: contractDigest(policy) }); bind(configurationBaselineId, "examples/fixtures/rule-weight-evidence/fixture.json")
add(configurationCandidateId, [addon + "BindingConfiguration"], repo("examples/fixtures/rule-weight-evidence/fixture.json"), { policySnapshot: policyCandidateId, policyId: proposal.candidatePolicy.id, policyVersion: proposal.candidatePolicy.version, policyDigest: proposal.candidatePolicyDigest, snapshotState: "PROPOSED_NOT_APPLIED" }); bind(configurationCandidateId, "examples/fixtures/rule-weight-evidence/fixture.json")
add(targetId, [addon + "BindingTarget"], repo("examples/fixtures/rule-policy/target.json"), { targetDigest: evaluation.targetDigest }); bind(targetId, "examples/fixtures/rule-policy/target.json")
add(consumerId, [addon + "Program"], repo("examples/rule-weight-evidence-fixture.ts"), { role: "SYNTHETIC_REFERENCE_CONSUMER" }); bind(consumerId, "examples/rule-weight-evidence-fixture.ts")
add(contextId, [rw + "Context"], repo("examples/fixtures/rule-weight-evidence/fixture.json"), { version: evidence.context.version, digest: evidence.context.digest, identityKind: "CONTEXT_SNAPSHOT" }); bind(contextId, "examples/fixtures/rule-weight-evidence/fixture.json")
add(actionId, [rw + "Action"], repo("examples/fixtures/rule-weight-evidence/fixture.json"), { version: evidence.action.version, digest: evidence.action.digest, participants: evidence.action.participants, identityKind: "ACTION_SNAPSHOT" }); bind(actionId, "examples/fixtures/rule-weight-evidence/fixture.json")
add(evaluationId, [rw + "Evaluation", rp + "Evaluation"], repo("examples/fixtures/rule-weight-evidence/fixture.json"), { evaluationDigest: evaluation.digest, forPolicy: policyBaselineId, target: targetId, consumer: consumerId, decision: evaluation.decision, coverage: evaluation.coverage, observedAt: evaluation.observedAt, resultKind: "SYNTHETIC_RULE_EVALUATION" }); bind(evaluationId, "examples/fixtures/rule-weight-evidence/fixture.json")
add(evidenceId, [rw + "Evidence"], repo("examples/fixtures/rule-weight-evidence/fixture.json"), { version: evidence.version, digest: contractDigest(evidence), context: contextId, action: actionId, evaluationDigest: evidence.evaluationDigest, evidenceClass: evidence.evidenceClass }); bind(evidenceId, "examples/fixtures/rule-weight-evidence/fixture.json")
add(outcomeId, [rw + "Outcome"], repo("examples/fixtures/rule-weight-evidence/fixture.json"), { metric: evidence.outcome.metric, value: evidence.outcome.value, sourceResource: evidence.outcome.source.resource, sourceDigest: evidence.outcome.source.digest, evaluator: evidence.outcome.evaluator, basis: evidence.outcome.basis, evidenceClass: evidence.evidenceClass, observedAt: evidence.observedAt, independentUnit: evidence.independentUnit, selectionProbability: evidence.selectionProbability, costs: evidence.costs, outcomeTruth: "NOT_ESTABLISHED" }); bind(outcomeId, "examples/fixtures/rule-weight-evidence/fixture.json")
for (const item of assignment) {
  add(item.baselineId, [rw + "WeightAssignment"], repo("examples/fixtures/rule-weight-evidence/fixture.json"), { forRule: item.change.rule, forConfiguration: configurationBaselineId, forPolicy: policyBaselineId, inContext: contextId, weight: item.change.fromWeight, ruleVersion: item.change.ruleVersion, policyVersion: policy.version, policyDigest: contractDigest(policy), assignmentState: "BASELINE_POLICY_VALUE" }); bind(item.baselineId, "examples/fixtures/rule-weight-evidence/fixture.json")
  add(item.candidateId, [rw + "WeightAssignment"], repo("examples/fixtures/rule-weight-evidence/fixture.json"), { forRule: item.change.rule, forConfiguration: configurationCandidateId, forPolicy: policyCandidateId, inContext: contextId, weight: item.change.toWeight, ruleVersion: item.change.ruleVersion, policyVersion: proposal.candidatePolicy.version, policyDigest: proposal.candidatePolicyDigest, assignmentState: "PROPOSED_NOT_APPLIED" }); bind(item.candidateId, "examples/fixtures/rule-weight-evidence/fixture.json")
}
add(proposalId, [rw + "WeightRevisionProposal"], repo("examples/fixtures/rule-weight-evidence/fixture.json"), { version: proposalInput.version, digest: proposal.proposalDigest, basePolicyDigest: proposal.basePolicyDigest, evidenceDigest: proposal.evidenceDigest, method: proposalInput.method, disposition: proposal.disposition, effectiveness: proposal.effectiveness, authority: proposal.authority, execution: proposal.execution }); bind(proposalId, "examples/fixtures/rule-weight-evidence/fixture.json")
const wId = "urn:usl:hswm:w-concept"
add(wId, [rw + "HSWM_W_Concept"], repo("docs/RULE_WEIGHT_EVIDENCE.md"), { canonicalMapping: "NOT_CONNECTED", relation: "CANDIDATE_INPUT_ONLY", canonicalW: "NOT_CLAIMED", interpretation: "SECONDARY_AI" }); bind(wId, "docs/RULE_WEIGHT_EVIDENCE.md")
for (const rule of policy.rules) link(addon + "applies_binding_rule", { rule: rule.id, target: targetId, configuration: configurationBaselineId, consumer: consumerId }, { scope: "SYNTHETIC_FIXTURE", policySnapshot: policyBaselineId })
for (const item of assignment) {
  link(rw + "contextual_weight", { rule: item.change.rule, configuration: configurationBaselineId, context: contextId, weight: item.baselineId }, { weightKind: "SOFT_COEFFICIENT", requirementGateSeparate: true, policySnapshot: policyBaselineId })
  link(rw + "contextual_weight", { rule: item.change.rule, configuration: configurationCandidateId, context: contextId, weight: item.candidateId }, { weightKind: "SOFT_COEFFICIENT", proposalState: "PROPOSED_NOT_APPLIED", policySnapshot: policyCandidateId })
}
link(rp + "evaluated_policy", { configuration: configurationBaselineId, target: targetId, consumer: consumerId, result: evaluationId }, { policySnapshot: policyBaselineId, scope: "SYNTHETIC_FIXTURE" })
link(rw + "records_evidence", { evidence: evidenceId, evaluation: evaluationId, context: contextId, action: actionId, outcome: outcomeId }, { evidenceClass: evidence.evidenceClass, outcomeTruth: "NOT_ESTABLISHED" })
link(rw + "proposed_revision", { baseline: policyBaselineId, candidate: policyCandidateId, context: contextId, evidence: evidenceId, proposal: proposalId }, { status: "OWNER_REVIEW_REQUIRED", effectiveness: "NOT_ESTABLISHED" })
link(rw + "candidate_input_to", { signal: evidenceId, wConcept: wId }, { status: "PROPOSED", canonicalMapping: "NOT_CONNECTED", relationship: "CANDIDATE_INPUT_ONLY", authority: "NOT_GRANTED" })
await local("trace:request", [status + "ExternalSource"], "research/rule-weight-evidence/request.json", { authority: "USER_PRIMARY" })
await local("trace:references", [status + "ExternalSource"], "research/rule-weight-evidence/references.json", { authority: "SECONDARY_AI_SOURCE_REVIEW", sourceScope: "READ_ONLY_LOCAL_SOURCE_INSPECTION" })
await local("trace:generator", [status + "Artifact"], "scripts/build-rule-weight-evidence.ts", { authority: "SECONDARY_AI" })
await local("trace:agent", [status + "Agent", "http://www.w3.org/ns/prov#Agent"], "research/rule-weight-evidence/request.json", { authority: "SECONDARY_AI", ratification: "NOT_CLAIMED" })
add("trace:activity", ["http://www.w3.org/ns/prov#Activity"], repo("scripts/build-rule-weight-evidence.ts"), { scope: "DETERMINISTIC_SOURCE_TRACEABILITY", execution: "NOT_CLAIMED" })
add("trace:task", [status + "Task"], repo("docs/RULE_WEIGHT_EVIDENCE.md"), { scope: "OPTIONAL_OWNER_PROPOSED_WEIGHT_EVIDENCE", interpretation: "SECONDARY_AI" })
link(status + "informed_by", { task: "trace:task", source: "trace:request" })
link(status + "informed_by", { task: "trace:task", source: "trace:references" })
for (const standard of [
  { id: "shacl-2017", url: "https://www.w3.org/TR/2017/REC-shacl-20170720/", use: "Typed RDF shape validation." },
  { id: "prov-o", url: "https://www.w3.org/TR/prov-o/", use: "Entity/activity/agent provenance vocabulary." },
]) { add(`standard:${standard.id}`, [status + "ExternalSource"], standard.url, { checkedOn: "2026-10-03", publicationStatus: "W3C_RECOMMENDATION", application: standard.use }); link(status + "informed_by", { task: "trace:task", source: `standard:${standard.id}` }) }
add("feature:rule-weight-evidence", [status + "Feature"], repo("docs/RULE_WEIGHT_EVIDENCE.md"), { scope: "EVIDENCE_AND_OWNER_REVIEW_ONLY", hswmIntegration: "NOT_CONNECTED" })
link(rp + "realized_by", { task: "trace:task", feature: "feature:rule-weight-evidence" })
for (const path of ["src/addons/rule-weight-evidence.ts", "examples/rule-weight-evidence-fixture.ts", "examples/rule-weight-evidence-workflow.ts", "schemas/rule-weight-evidence/trace.shacl.ttl", "schemas/rule-weight-evidence/evidence.schema.json", "schemas/rule-weight-evidence/host.schema.json", "schemas/rule-weight-evidence/proposal.schema.json", "docs/RULE_WEIGHT_EVIDENCE.md"]) { await local(`artifact:${path}`, [status + "Artifact"], path); link(status + "implemented_by", { feature: "feature:rule-weight-evidence", artifact: `artifact:${path}` }) }
for (const path of ["test/rule-weight-evidence.test.ts", "scripts/validate-rule-weight-evidence.py"]) { await local(`test:${path}`, [status + "TestEvidence"], path, { evidenceKind: "TEST_OR_VALIDATOR_DEFINITION", execution: "NOT_CLAIMED" }); link(status + "tested_by", { feature: "feature:rule-weight-evidence", evidence: `test:${path}` }, { execution: "NOT_CLAIMED" }) }
add("limitation:weight-evidence", [status + "Limitation"], repo("docs/RULE_WEIGHT_EVIDENCE.md"), { detail: "Synthetic evidence only. No learned estimate, holdout claim, live application, HSWM W mapping, HSWM state change, canonical promotion, or authority grant." })
link(status + "bounded_by", { feature: "feature:rule-weight-evidence", limitation: "limitation:weight-evidence" })
// The original proposal remains unapplied. This separate extension records an actual local learner's synthetic review.
for (const [name, type] of [["dataset", "LearningDataset"], ["report", "LearnerReport"], ["replay", "ReplayObservation"], ["review", "LearnerReview"]] as const) {
  await local(learnerIds[name], [rw + type], `${reviewFolder}/${name}.json`, { dataKind: "SYNTHETIC", executionScope: "OFFLINE_LOCAL_COPY_ONLY" })
}
link(rw + "reviewed_with_learner", { proposal: proposalId, context: contextId, ...learnerIds }, { reviewStatus: learnerReview.reviewStatus, disposition: learnerReview.disposition, operationalEfficacy: "NOT_ESTABLISHED", authority: "NOT_GRANTED" })
add("feature:rule-weight-review", [status + "Feature"], repo("docs/RULE_WEIGHT_REVIEW.md"), { scope: "OPTIONAL_OFFLINE_LEARNER_REVIEW", liveHSWM: "NOT_CONNECTED" })
link(rp + "realized_by", { task: "trace:task", feature: "feature:rule-weight-review" })
for (const path of ["src/addons/rule-weight-review.ts", "scripts/rule-weight-review.ts", "scripts/build-rule-weight-review.ts", "examples/rule-weight-review-fixture.ts", "schemas/rule-weight-evidence/review.schema.json", "schemas/rule-weight-evidence/review-host.schema.json", "docs/RULE_WEIGHT_REVIEW.md"]) { await local(`artifact:${path}`, [status + "Artifact"], path); link(status + "implemented_by", { feature: "feature:rule-weight-review", artifact: `artifact:${path}` }) }
for (const path of ["test/rule-weight-review.test.ts", "test/rule-weight-review-cli.test.ts"]) { await local(`test:${path}`, [status + "TestEvidence"], path, { evidenceKind: "TEST_OR_VALIDATOR_DEFINITION", execution: "NOT_CLAIMED" }); link(status + "tested_by", { feature: "feature:rule-weight-review", evidence: `test:${path}` }) }
await local("trace:learner:execution", [status + "TestEvidence", status + "ExecutionReceipt"], "research/rule-weight-evidence/learner-execution.json", { evidenceKind: "OBSERVED_COMMAND_RECEIPT", execution: "OBSERVED_LOCAL_SYNTHETIC", scope: "SYNTHETIC_OFFLINE_LEARNER" })
link(status + "tested_by", { feature: "feature:rule-weight-review", evidence: "trace:learner:execution" }, { execution: "OBSERVED_LOCAL_SYNTHETIC" })
add("limitation:weight-review", [status + "Limitation"], repo("docs/RULE_WEIGHT_REVIEW.md"), { detail: "Synthetic held-out evaluation only. Utility estimates are not rule coefficients or canonical W. No operational efficacy, evaluator authentication, live policy/HSWM apply, or access grant." })
link(status + "bounded_by", { feature: "feature:rule-weight-review", limitation: "limitation:weight-review" })
graph.meanings = profile.meanings.map(item => ({ id: item.id, description: `Declared role contract ${item.id}; graph relationships are declared, not semantic entailments.` }))
const rawGraph = json(graph)
Either.getOrThrow(adaptResourceGraph(rawGraph, { namespace: "usl.rule-weight-evidence", profile }))
output["research/rule-weight-evidence/profile.json"] = json(profile)
output["research/rule-weight-evidence/graph.json"] = rawGraph
output["research/rule-weight-evidence/graph.jsonld"] = json(Either.getOrThrow(resourceGraphJsonLd(rawGraph, { namespace: "usl.rule-weight-evidence", profile })))
output["research/rule-weight-evidence/bindings.json"] = json({ schema: "usl-resource-bindings/v1", resources: bindings })
output["research/rule-weight-evidence/selections.json"] = json(bindings.map(binding => ({ resource: binding.id, representation: binding.representations[0]!.id })))
output["research/rule-weight-evidence/host.json"] = json({ schema: "usl-cli-host/v1", bindings: "bindings.json", workspaces: { usl: "../.." }, maxSourceBytes: 1048576, actions: [] })
// This typed projection carries numeric values and pins needed by SHACL; graph metadata is not a substitute for these triples.
output["examples/fixtures/rule-weight-evidence/trace.jsonld"] = json({ "@context": { rw, rp, xsd: "http://www.w3.org/2001/XMLSchema#" }, "@graph": [
  ...policy.rules.map(rule => ({ "@id": rule.id, "@type": "rw:Rule", "rw:version": rule.version, "rw:requirement": rule.requirement, "rw:onViolation": rule.onViolation })),
  { "@id": policyBaselineId, "@type": "rw:PolicySnapshot", "rw:policyId": { "@id": policy.id }, "rw:policyVersion": policy.version, "rw:digest": contractDigest(policy) },
  { "@id": policyCandidateId, "@type": "rw:PolicySnapshot", "rw:policyId": { "@id": proposal.candidatePolicy.id }, "rw:policyVersion": proposal.candidatePolicy.version, "rw:digest": proposal.candidatePolicyDigest },
  { "@id": contextId, "@type": "rw:Context", "rw:version": evidence.context.version, "rw:digest": evidence.context.digest },
  { "@id": actionId, "@type": "rw:Action", "rw:version": evidence.action.version, "rw:digest": evidence.action.digest, "rw:participant": evidence.action.participants.map(participant => ({ "@type": "rw:ActionParticipant", "rw:role": participant.role, "rw:ordinal": { "@value": participant.ordinal, "@type": "xsd:integer" }, "rw:source": { "@id": participant.source.id }, "rw:sourceVersion": participant.source.version, "rw:sourceDigest": participant.source.digest })) },
  { "@id": evaluationId, "@type": ["rw:Evaluation", "rp:Evaluation"], "rw:evaluationDigest": evaluation.digest, "rw:forPolicy": { "@id": policyBaselineId }, "rw:target": { "@id": `urn:usl:target:${encodeURIComponent(targetId)}` }, "rw:consumer": { "@id": `urn:usl:consumer:${encodeURIComponent(consumerId)}` } },
  { "@id": evidenceId, "@type": "rw:Evidence", "rw:version": evidence.version, "rw:digest": contractDigest(evidence), "rw:recordsEvaluation": { "@id": evaluationId }, "rw:inContext": { "@id": contextId }, "rw:recordsAction": { "@id": actionId }, "rw:recordsOutcome": { "@id": outcomeId } },
  { "@id": outcomeId, "@type": "rw:Outcome", "rw:metric": { "@id": evidence.outcome.metric.id }, "rw:value": { "@value": evidence.outcome.value, "@type": "xsd:double" }, "rw:sourceResource": { "@id": `urn:usl:external:${encodeURIComponent(evidence.outcome.source.resource)}` }, "rw:sourceDigest": evidence.outcome.source.digest, "rw:evidenceClass": evidence.evidenceClass, "rw:observedAt": { "@value": evidence.observedAt, "@type": "xsd:dateTime" } },
  ...assignment.flatMap(item => [
    { "@id": item.baselineId, "@type": "rw:WeightAssignment", "rw:forRule": { "@id": item.change.rule }, "rw:forConfiguration": { "@id": `urn:usl:configuration:${encodeURIComponent(configurationBaselineId)}` }, "rw:forPolicy": { "@id": policyBaselineId }, "rw:inContext": { "@id": contextId }, "rw:weight": { "@value": item.change.fromWeight, "@type": "xsd:double" }, "rw:ruleVersion": item.change.ruleVersion, "rw:policyVersion": policy.version, "rw:policyDigest": contractDigest(policy) },
    { "@id": item.candidateId, "@type": "rw:WeightAssignment", "rw:forRule": { "@id": item.change.rule }, "rw:forConfiguration": { "@id": `urn:usl:configuration:${encodeURIComponent(configurationCandidateId)}` }, "rw:forPolicy": { "@id": policyCandidateId }, "rw:inContext": { "@id": contextId }, "rw:weight": { "@value": item.change.toWeight, "@type": "xsd:double" }, "rw:ruleVersion": item.change.ruleVersion, "rw:policyVersion": proposal.candidatePolicy.version, "rw:policyDigest": proposal.candidatePolicyDigest },
  ]),
  { "@id": proposalId, "@type": "rw:WeightRevisionProposal", "rw:baseline": { "@id": policyBaselineId }, "rw:candidate": { "@id": policyCandidateId }, "rw:inContext": { "@id": contextId }, "rw:evidence": { "@id": evidenceId }, "rw:proposalState": "OWNER_REVIEW_REQUIRED", "rw:effectiveness": "NOT_ESTABLISHED" },
  { "@id": wId, "@type": "rw:HSWM_W_Concept", "rw:canonicalMapping": "NOT_CONNECTED" },
  { "@id": learnerIds.dataset, "@type": "rw:LearningDataset", "rw:digest": digestSource(reviewFiles.dataset!), "rw:inContext": { "@id": contextId }, "rw:inputDigest": `sha256:${learnerReport.inputDigest}`, "rw:dataKind": learnerDataset.dataKind },
  { "@id": learnerIds.report, "@type": "rw:LearnerReport", "rw:digest": digestSource(reviewFiles.report!), "rw:derivedFrom": { "@id": learnerIds.dataset }, "rw:inputDigest": `sha256:${learnerReport.inputDigest}` },
  { "@id": learnerIds.replay, "@type": "rw:ReplayObservation", "rw:digest": digestSource(reviewFiles.replay!), "rw:verifiedReport": { "@id": learnerIds.report }, "rw:scope": "INDEPENDENT_LOCAL_COPIES" },
  { "@id": learnerIds.review, "@type": "rw:LearnerReview", "rw:digest": digestSource(reviewFiles.review!), "rw:reviewsProposal": { "@id": proposalId }, "rw:inContext": { "@id": contextId }, "rw:usesDataset": { "@id": learnerIds.dataset }, "rw:usesReport": { "@id": learnerIds.report }, "rw:usesReplay": { "@id": learnerIds.replay }, "rw:reportDigest": digestSource(reviewFiles.report!), "rw:reviewStatus": learnerReview.reviewStatus, "rw:disposition": learnerReview.disposition, "rw:dataKind": learnerReview.dataKind, "rw:effectiveness": "NOT_ESTABLISHED" },
] })
for (const [path, content] of Object.entries(output)) { const absolute = resolve(root, path); if (check) { if (await readFile(absolute, "utf8") !== content) throw new Error(`rule weight evidence artifact differs: ${path}`) } else { await mkdir(dirname(absolute), { recursive: true }); await writeFile(absolute, content) } }
console.log(json({ mode: check ? "ARTIFACTS_CHECKED" : "ARTIFACTS_BUILT", resources: graph.resources.length, links: graph.links.length, proposal: proposal.disposition, hswm: proposal.hswmIntegration.status, historicalTestsClaimed: false }))
