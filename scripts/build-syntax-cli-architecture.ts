/** Build a small, portable graph of current USL syntax/CLI facts and proposed graph work. */
import { readFile, writeFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { Either } from "effect"
import { digestSource } from "../src/language/digest.js"
import { adaptResourceGraph, resourceGraphJsonLd, type ResourceGraph } from "../src/integrations/resource-graph.js"
import { checkResourceGraphProfile, type DomainProfile } from "../src/domain-profile.js"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const check = process.argv.slice(2).includes("--check")
if (process.argv.slice(2).some(arg => arg !== "--check")) throw new Error("usage: build-syntax-cli-architecture.ts [--check]")
const read = (file: string) => readFile(resolve(root, file), "utf8")
const catalog = JSON.parse(await read("research/architecture/syntax-cli.catalog.json")) as { schema: string; authority: string; sourceCommit: string; sourcePins: Record<string, string>; userStatements: Array<{ id: string; status: string; text: string }>; implemented: Array<[string, string, string[]]>; proposals: Array<[string, string, string]>; proposalPlacement: Record<string, string> }
type PlannedTask = { id: string; order: number; title: string; dependsOn: string[]; requirements: string[]; proposals: string[]; deliverables: string[]; acceptance: string[]; hswmAlignment: string; proofTargets: string[]; status: string; implementation: string; proofStatus: string }
type WorkPlan = { schema: string; authority: string; status: string; userRequest: { id: string; text: string; authority: string }; scopeCorrections?: Array<{ id: string; text: string; authority: string }>; tasks: PlannedTask[] }
type CoreCliPlan = { schema: "usl-core-cli-work-plan/v1"; authority: "SECONDARY_AI"; status: "PLANNED"; userRequest: { id: string; text: string; authority: "USER_PRIMARY" }; sourceEvidence: Array<{ path: string; sha256: string; kind: "LOCAL_SNAPSHOT" }>; tasks: PlannedTask[] }
type VerificationReceipt = { schema: "usl-binding-delivery-receipt/v1"; authority: "SECONDARY_AI"; status: "PASS"; generatedAt: string; sourcePins: Record<string, string>; tasks: Array<{ id: string; status: "PASS"; evidence: Array<{ kind: "command"; command: string; exitCode: 0; observed: string } | { kind: "source"; path: string; sha256: string }> }> }
type CompressionSource = { id: string; title: string; url: string; technique: string; scope: string; limitation: string; checkedAt: string }
type CompressionBenchmark = { schema: string; scope: string; validationStatus: string; environment: { encodings: string[]; memory: string }; inputs: { digest: string; benchmarkScriptDigest: string; tokenScriptDigest: string; requirementsDigest: string }; fixtures: unknown[] }
const workPlan = JSON.parse(await read("research/architecture/hswm-like.plan.json")) as WorkPlan
const receiptPath = "research/architecture/binding-delivery.receipt.json"
const receipt = JSON.parse(await read(receiptPath)) as VerificationReceipt
const corePlanPath = "research/architecture/core-cli.plan.json"
const corePlan = JSON.parse(await read(corePlanPath)) as CoreCliPlan
const compressionSources = JSON.parse(await read("research/compression/sources.json")) as CompressionSource[]
const compressionBenchmark = JSON.parse(await read("research/compression/benchmark-results.json")) as CompressionBenchmark
if (catalog.schema !== "usl-syntax-cli-architecture-catalog/v1" || catalog.authority !== "SECONDARY_AI" || !/^[a-f0-9]{40}$/.test(catalog.sourceCommit) ||
  !catalog.sourcePins || !catalog.proposalPlacement || !Array.isArray(catalog.userStatements) || !Array.isArray(catalog.implemented) || !Array.isArray(catalog.proposals)) throw new Error("invalid syntax-cli architecture catalog")
for (const statement of catalog.userStatements) if (!/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/.test(statement.id) || statement.status !== "USER_PRIMARY" || !statement.text.trim()) throw new Error("invalid user statement")
for (const item of catalog.implemented) if (!Array.isArray(item) || item.length !== 3 || !item[0].startsWith("feature:") || !item[1].trim() || !Array.isArray(item[2]) || item[2].some(path => typeof path !== "string" || !path.startsWith("src/"))) throw new Error("invalid implemented feature")
for (const item of catalog.proposals) if (!Array.isArray(item) || item.length !== 3 || !item[0].startsWith("proposal:") || item.slice(1).some(value => !value.trim())) throw new Error("invalid proposal")
for (const [id] of catalog.proposals) if (!["ADDON_RESPONSIBILITY", "MINIMAL_BINDING_CLI"].includes(catalog.proposalPlacement[id] ?? "")) throw new Error(`invalid proposal placement: ${id}`)
if (workPlan.schema !== "usl-hswm-like-work-plan/v1" || workPlan.authority !== "SECONDARY_AI" || workPlan.status !== "COMPLETED" || workPlan.userRequest.id !== "user:hswm-plan" || workPlan.userRequest.authority !== "USER_PRIMARY" || !workPlan.userRequest.text.trim()) throw new Error("invalid HSWM-like work plan")
if (receipt.schema !== "usl-binding-delivery-receipt/v1" || receipt.authority !== "SECONDARY_AI" || receipt.status !== "PASS" || !/^\d{4}-\d\d-\d\d$/.test(receipt.generatedAt) || !receipt.sourcePins || !Array.isArray(receipt.tasks)) throw new Error("invalid binding delivery receipt")
for (const [path, digest] of Object.entries(receipt.sourcePins)) if (!(/^(src|docs|examples|test|scripts|research)\//.test(path) || ["package.json", "package-lock.json", "tsconfig.json"].includes(path)) || !/^sha256:[a-f0-9]{64}$/.test(digest) || digestSource(await read(path)) !== digest) throw new Error(`invalid receipt source pin: ${path}`)
if (corePlan.schema !== "usl-core-cli-work-plan/v1" || corePlan.authority !== "SECONDARY_AI" || corePlan.status !== "PLANNED" || corePlan.userRequest.id !== "user:core-cli-next" || corePlan.userRequest.authority !== "USER_PRIMARY" || !corePlan.userRequest.text.trim() || !corePlan.sourceEvidence.length) throw new Error("invalid core CLI plan")
for (const source of corePlan.sourceEvidence) if (!/^src\//.test(source.path) || !/^[a-f0-9]{64}$/.test(source.sha256) || source.kind !== "LOCAL_SNAPSHOT" || (digestSource(await read(source.path)) ?? "").replace("sha256:", "") !== source.sha256) throw new Error(`invalid core CLI source evidence: ${source.path}`)
if (compressionSources.length < 4 || compressionSources.some(source => !/^[a-z0-9-]+$/.test(source.id) || !source.title.trim() || !/^https:\/\//.test(source.url) || !source.technique.trim() || !source.scope.trim() || !source.limitation.trim() || !/^\d{4}-\d\d-\d\d$/.test(source.checkedAt))) throw new Error("invalid compression source")
if (compressionBenchmark.schema !== "usl-compression-benchmark-results/v1" || compressionBenchmark.scope !== "OFFLINE_PAYLOAD_MEASUREMENT_NOT_RUNTIME_MEMORY_OR_BILLED_USAGE" || compressionBenchmark.validationStatus !== "FIXTURE_ROUNDTRIPS_PASSED" || !compressionBenchmark.environment.encodings.length || !compressionBenchmark.environment.memory.includes("HEAP_NOT_MEASURED") || ![compressionBenchmark.inputs.digest, compressionBenchmark.inputs.benchmarkScriptDigest, compressionBenchmark.inputs.tokenScriptDigest, compressionBenchmark.inputs.requirementsDigest].every(value => /^sha256:[a-f0-9]{64}$/.test(value)) || !compressionBenchmark.fixtures.length) throw new Error("invalid compression benchmark")
const taskIds = new Set<string>()
for (const task of workPlan.tasks) {
  if (!/^task:P\d\d$/.test(task.id) || taskIds.has(task.id) || !Number.isSafeInteger(task.order) || task.order < 1 || !task.title.trim() || task.status !== "COMPLETED" || task.implementation !== "COMPLETE" || task.proofStatus !== "NOT_PROVEN" || !task.deliverables.length || task.deliverables.some(path => !/^(src|test|docs|schemas|examples|lean)\//.test(path)) || !task.acceptance.length || task.acceptance.some(item => !item.trim())) throw new Error(`invalid completed task: ${task.id}`)
  const receiptTask = receipt.tasks.find(item => item.id === task.id)
  if (!receiptTask || receiptTask.status !== "PASS" || !receiptTask.evidence.some(evidence => evidence.kind === "command" && evidence.exitCode === 0 && evidence.command.trim() && evidence.observed.trim()) || !task.deliverables.every(path => receipt.sourcePins[path] !== undefined && receiptTask.evidence.some(evidence => evidence.kind === "source" && evidence.path === path && evidence.sha256 === receipt.sourcePins[path]))) throw new Error(`missing completion evidence: ${task.id}`)
  taskIds.add(task.id)
}
for (const task of corePlan.tasks) {
  if (!/^task:C\d\d$/.test(task.id) || taskIds.has(task.id) || !Number.isSafeInteger(task.order) || task.order < 1 || !task.title.trim() || task.status !== "PLANNED" || task.implementation !== "NOT_STARTED" || task.proofStatus !== "NOT_PROVEN" || !task.deliverables.length || !task.acceptance.length || task.acceptance.some(item => !item.trim())) throw new Error(`invalid core CLI task: ${task.id}`)
  taskIds.add(task.id)
}
const commit = catalog.sourceCommit
const prefix = "urn:usl:syntax-cli:"
const location = (path: string) => `git://github.com/gj3447/USL@${commit}:${path}`
const publicLocation = (path: string) => `https://github.com/gj3447/USL/blob/master/${path}`
const graph: ResourceGraph = { schema: "usl-resource-graph/v1", resources: [], meanings: [], links: [], provenance: { sources: ["source:catalog", "source:generator", "source:hswm-plan", "source:core-cli-plan", "source:binding-delivery-receipt", "source:compression-sources", "artifact:compression-benchmark"], activity: "activity:architecture", agent: "agent:secondary" } }
type Meta = NonNullable<ResourceGraph["resources"][number]["metadata"]>
type LinkMeta = NonNullable<ResourceGraph["links"][number]["metadata"]>
const add = (id: string, type: string | string[], locator: string, metadata: Meta) => { graph.resources.push({ id, types: (Array.isArray(type) ? type : [type]).map(t => t.startsWith("http") ? t : prefix + t), locator, metadata }); return id }
const addFile = async (path: string) => {
  const pinned = catalog.sourcePins[path]
  if (!pinned) throw new Error(`missing catalog source pin: ${path}`)
  const current = digestSource(await read(path))
  const historical = digestSource(execFileSync("git", ["show", `${commit}:${path}`], { cwd: root, encoding: "buffer" }).toString("utf8"))
  if (current !== pinned || historical !== pinned) throw new Error(`source pin mismatch: ${path}`)
  return add(`artifact:${path}`, "Artifact", location(path), { path, sourceDigest: pinned, scope: "LOCAL_CURRENT_AND_LOCAL_GIT_COMMIT_BYTES", remoteObservation: "NOT_PERFORMED" })
}
const rules: Array<[string, Array<[string, string]>]> = [
  ["interpreted_as", [["statement", "UserStatement"], ["feature", "ImplementedFeature"]]],
  ["implemented_by", [["feature", "ImplementedFeature"], ["artifact", "Artifact"]]],
  ["trace", [["statement", "UserStatement"], ["feature", "ImplementedFeature"], ["artifact", "Artifact"]]],
  ["bounded_by", [["feature", "ImplementedFeature"], ["limitation", "Limitation"]]],
  ["addresses", [["proposal", "Proposal"], ["requirement", "UserStatement"]]],
  ["depends_on", [["proposal", "Proposal"], ["prerequisite", "Proposal"]]],
  ["planned_work", [["task", "Task"], ["criterion", "AcceptanceCriterion"], ["requirement", "UserStatement"]]],
  ["completed_by", [["task", "Task"], ["criterion", "AcceptanceCriterion"], ["evidence", "VerificationReceipt"]]],
  ["planned_evidence", [["task", "Task"], ["artifact", "Artifact"]]],
  ["task_depends_on", [["task", "Task"], ["prerequisite", "Task"]]],
  ["advances", [["task", "Task"], ["proposal", "Proposal"]]],
  ["evaluated_by", [["requirement", "UserStatement"], ["technique", "CompressionTechnique"], ["evidence", "Source"]]],
  ["measured_by", [["requirement", "UserStatement"], ["technique", "CompressionTechnique"], ["benchmark", "BenchmarkArtifact"]]],
]
const profile: DomainProfile = { schema: "usl-domain-profile/v1", id: prefix + "profile", version: "1", closedMeanings: true,
  meanings: rules.map(([id, roles]) => ({ id: prefix + id, allowExtraRoles: false, roles: roles.map(([role, type]) => ({ role, required: true, types: [prefix + type], metadata: [] })) })) }
graph.meanings = rules.map(([id]) => ({ id: prefix + id, description: `Architecture trace relation ${id}; declaration only.` }))
const link = (meaning: string, participants: Record<string, string>, metadata: LinkMeta = {}) => graph.links.push({ id: `${meaning}:${Object.values(participants).join(":")}`, meaning: prefix + meaning, participants: Object.entries(participants).map(([role, resource]) => ({ role, resource })), metadata })
add("source:catalog", "Source", publicLocation("research/architecture/syntax-cli.catalog.json"), { path: "research/architecture/syntax-cli.catalog.json", sourceDigest: digestSource(await read("research/architecture/syntax-cli.catalog.json")), authority: "SECONDARY_AI", locationStatus: "DECLARED_PUBLIC_LOCATION", remoteObservation: "NOT_PERFORMED" })
add("source:generator", "Source", publicLocation("scripts/build-syntax-cli-architecture.ts"), { path: "scripts/build-syntax-cli-architecture.ts", sourceDigest: digestSource(await read("scripts/build-syntax-cli-architecture.ts")), scope: "DETERMINISTIC_GENERATOR", locationStatus: "DECLARED_PUBLIC_LOCATION", remoteObservation: "NOT_PERFORMED" })
add("source:hswm-plan", "Source", publicLocation("research/architecture/hswm-like.plan.json"), { path: "research/architecture/hswm-like.plan.json", sourceDigest: digestSource(await read("research/architecture/hswm-like.plan.json")), authority: "SECONDARY_AI", locationStatus: "DECLARED_PUBLIC_LOCATION", remoteObservation: "NOT_PERFORMED" })
add("source:core-cli-plan", "Source", publicLocation(corePlanPath), { path: corePlanPath, sourceDigest: digestSource(await read(corePlanPath)), authority: corePlan.authority, status: corePlan.status, sourceEvidence: corePlan.sourceEvidence, locationStatus: "DECLARED_PUBLIC_LOCATION", remoteObservation: "NOT_PERFORMED" })
add("source:binding-delivery-receipt", "VerificationReceipt", publicLocation(receiptPath), { path: receiptPath, sourceDigest: digestSource(await read(receiptPath)), authority: receipt.authority, status: receipt.status, generatedAt: receipt.generatedAt, sourcePins: receipt.sourcePins, locationStatus: "DECLARED_PUBLIC_LOCATION", remoteObservation: "NOT_PERFORMED" })
add("source:compression-sources", "Source", publicLocation("research/compression/sources.json"), { path: "research/compression/sources.json", sourceDigest: digestSource(await read("research/compression/sources.json")), authority: "EXTERNAL_RESEARCH_CATALOG", locationStatus: "DECLARED_PUBLIC_LOCATION", remoteObservation: "NOT_PERFORMED" })
add("artifact:compression-benchmark", "BenchmarkArtifact", publicLocation("research/compression/benchmark-results.json"), { path: "research/compression/benchmark-results.json", sourceDigest: digestSource(await read("research/compression/benchmark-results.json")), resultStatus: compressionBenchmark.scope, validationStatus: compressionBenchmark.validationStatus, memory: compressionBenchmark.environment.memory, tokenEncodings: compressionBenchmark.environment.encodings, billing: "NOT_MEASURED", llmQuality: "NOT_MEASURED", remoteExecution: "NOT_PERFORMED" })
add("activity:architecture", ["ArchitectureActivity", "http://www.w3.org/ns/prov#Activity"], publicLocation("research/architecture/syntax-cli.catalog.json"), { status: "DECLARED", scope: "CURRENT_IMPLEMENTATION_AND_PROPOSAL_SEPARATION", runtimeTests: "NOT_CLAIMED" })
add("agent:secondary", ["Agent", "http://www.w3.org/ns/prov#Agent"], publicLocation("research/architecture/syntax-cli.catalog.json"), { authority: "SECONDARY_AI", ratification: "NOT_CLAIMED" })
add("subject:usl", "ArchitectureSubject", "git://github.com/gj3447/USL", { name: "USL", role: "LANGUAGE_AND_CLI_BINDING_LAYER" })
for (const statement of catalog.userStatements) add(statement.id, "UserStatement", publicLocation("research/architecture/syntax-cli.catalog.json"), { status: statement.status, text: statement.text, authority: "USER_PRIMARY", locationStatus: "DECLARED_PUBLIC_LOCATION", remoteObservation: "NOT_PERFORMED" })
add(workPlan.userRequest.id, "UserStatement", publicLocation("research/architecture/hswm-like.plan.json"), { status: "USER_PRIMARY", text: workPlan.userRequest.text, authority: workPlan.userRequest.authority, locationStatus: "DECLARED_PUBLIC_LOCATION", remoteObservation: "NOT_PERFORMED" })
add(corePlan.userRequest.id, "UserStatement", publicLocation(corePlanPath), { status: "USER_PRIMARY", text: corePlan.userRequest.text, authority: corePlan.userRequest.authority, locationStatus: "DECLARED_PUBLIC_LOCATION", remoteObservation: "NOT_PERFORMED" })
for (const statement of workPlan.scopeCorrections ?? []) {
  if (!/^user:[a-z][a-z0-9-]*$/.test(statement.id) || statement.authority !== "USER_PRIMARY" || !statement.text.trim()) throw new Error("invalid scope correction")
  add(statement.id, "UserStatement", publicLocation("research/architecture/hswm-like.plan.json"), { status: "USER_PRIMARY", text: statement.text, authority: "USER_PRIMARY", locationStatus: "DECLARED_PUBLIC_LOCATION", remoteObservation: "NOT_PERFORMED" })
}
for (const source of compressionSources) {
  const sourceId = `source:compression:${source.id}`
  const techniqueId = `technique:compression:${source.id}`
  add(sourceId, "Source", source.url, { title: source.title, checkedAt: source.checkedAt, scope: source.scope, limitation: source.limitation, authority: "EXTERNAL_SOURCE", sourceReview: `DOCUMENT_READ_${source.checkedAt}`, remoteObservation: "NOT_PERFORMED_BY_USL_RUNTIME" })
  add(techniqueId, "CompressionTechnique", source.url, { title: source.technique, scope: source.scope, limitation: source.limitation, status: "RESEARCH_REFERENCE_NOT_USL_FEATURE" })
  link("evaluated_by", { requirement: "user:compression-cost", technique: techniqueId, evidence: sourceId }, { authority: "SECONDARY_AI", status: "RESEARCH_TRACE", claimStatus: "MEASUREMENT_REQUIRED" })
}
link("measured_by", { requirement: "user:compression-cost", technique: "technique:compression:openai-token-counting", benchmark: "artifact:compression-benchmark" }, { authority: "SECONDARY_AI", status: "OFFLINE_MEASUREMENT_TRACE", claimStatus: "NO_BILLING_OR_QUALITY_CLAIM" })
const localMeasuredTechniques: Array<{ id: string; title: string; scope: string; baseline: string; lanes: string; implementationStatus: string; limitation: string }> = [
  { id: "source-minification", title: "Lossless fixture source minification", scope: "same compiled plan digest for source fixtures", baseline: "source-original", lanes: "source-original -> source-minified", implementationStatus: "BENCHMARK_EXPERIMENT_NOT_USL_RUNTIME_FEATURE", limitation: "Comments and whitespace are removed only where the benchmark scanner preserves compilation; no new core syntax is adopted." },
  { id: "compact-full", title: "Existing compact FULL context projection", scope: "scoped AgentContext transport projection with reconstructible paths and target witness", baseline: "context-minified", lanes: "context-minified -> compact-full", implementationStatus: "IMPLEMENTED_CURRENT_USL_FEATURE", limitation: "It is not a lossless serialization of the entire source graph or an actual heap measurement." },
  { id: "dictionary-table", title: "Dictionary/table JSON experiment", scope: "exact JSON roundtrip; standalone lane includes a decoder guide", baseline: "context-minified", lanes: "dictionary-table-data-needs-decoder; dictionary-table-standalone", implementationStatus: "BENCHMARK_EXPERIMENT_NOT_USL_RUNTIME_FEATURE", limitation: "No model quality result exists; the standalone decoder overhead is included and it is not adopted into USL." },
  { id: "compact-unchanged", title: "Existing digest-pinned UNCHANGED packet", scope: "conditional response only when receiver retains matching prior FULL context", baseline: "compact-full", lanes: "compact-full -> compact-unchanged-requires-prior-full", implementationStatus: "IMPLEMENTED_CURRENT_USL_FEATURE", limitation: "It is not provider prompt caching and cannot replace FULL for a receiver without prior context." },
  { id: "binary-transport", title: "gzip/brotli binary transport comparison", scope: "compressed bytes and base64 text counts for each payload lane", baseline: "each text payload lane", lanes: "gzipBytes; brotliBytes; gzipBase64Bytes; brotliBase64Bytes", implementationStatus: "BENCHMARK_TRANSPORT_COMPARISON_NOT_USL_RUNTIME_FEATURE", limitation: "A decoder is required; base64 token counts do not establish lower prompt tokens or model comprehension." },
]
for (const technique of localMeasuredTechniques) {
  const techniqueId = `technique:compression:${technique.id}`
  add(techniqueId, "CompressionTechnique", publicLocation("research/compression/benchmark-results.json"), { title: technique.title, scope: technique.scope, baseline: technique.baseline, lanes: technique.lanes, implementationStatus: technique.implementationStatus, limitation: technique.limitation, status: "LOCAL_OFFLINE_MEASUREMENT" })
  link("measured_by", { requirement: "user:compression-cost", technique: techniqueId, benchmark: "artifact:compression-benchmark" }, { authority: "SECONDARY_AI", status: "OFFLINE_MEASUREMENT_TRACE", claimStatus: "NO_BILLING_OR_QUALITY_CLAIM" })
}
const artifacts = new Map<string, string>()
for (const [feature, title, paths] of catalog.implemented) {
  add(feature, "ImplementedFeature", location("README.md"), { title, status: "IMPLEMENTED_CURRENT_SOURCE", semanticTruth: "NOT_EVALUATED", runtimeTests: "NOT_CLAIMED" })
  for (const path of paths) { const id = artifacts.get(path) ?? await addFile(path); artifacts.set(path, id); link("implemented_by", { feature, artifact: id }) }
  link("interpreted_as", { statement: "user:syntax-cli", feature }, { authority: "SECONDARY_AI", status: "INTERPRETATION" })
}
const limitations: Array<[string, string, string]> = [
  ["limitation:weights", "Semantic weight adjustment is not implemented.", "feature:hyperedge"],
  ["limitation:m-map", "No persistent or derived M-map index is implemented.", "feature:navigation"],
  ["limitation:hierarchy", "No typed parent/child hierarchy or ancestry query is implemented.", "feature:navigation"],
  ["limitation:cli-consolidation", "Existing CLI commands work; only minimal binding usage and help cleanup are in scope.", "feature:cli"],
]
for (const [id, detail, feature] of limitations) { const addon = ["limitation:weights", "limitation:m-map", "limitation:hierarchy"].includes(id); add(id, "Limitation", location("README.md"), { detail: addon ? `${detail} It is an addon responsibility, not a missing USL core feature.` : detail, status: addon ? "SCOPE_BOUNDARY" : "CURRENT_GAP" }); link("bounded_by", { feature, limitation: id }) }
for (const [id, title, detail] of catalog.proposals) { add(id, "Proposal", publicLocation("research/architecture/syntax-cli.catalog.json"), { title, detail, placement: catalog.proposalPlacement[id]!, status: "PROPOSED", authority: "SECONDARY_AI", implementation: "NOT_STARTED" }); link("addresses", { proposal: id, requirement: "user:weighted-hypergraph" }, { authority: "SECONDARY_AI", status: "INTERPRETATION" }) }
link("addresses", { proposal: "proposal:graph-cli", requirement: "user:syntax-cli" }, { authority: "SECONDARY_AI", status: "INTERPRETATION" })
// This three-role edge is intentionally retained as the canonical n-ary trace.
link("trace", { statement: "user:syntax-cli", feature: "feature:hyperedge", artifact: artifacts.get("src/language/compiler.ts")! }, { authority: "SECONDARY_AI", status: "TRACEABILITY" })
for (const task of workPlan.tasks) {
  add(task.id, "Task", publicLocation("research/architecture/hswm-like.plan.json"), { ...task, authority: "SECONDARY_AI", sourceStatus: "COMPLETED_WORK" })
  const criterion = `criterion:${task.id.slice("task:".length)}`
  add(criterion, "AcceptanceCriterion", publicLocation("research/architecture/hswm-like.plan.json"), { task: task.id, checks: task.acceptance, status: "PASS_RECORDED" })
  for (const requirement of task.requirements) link("planned_work", { task: task.id, criterion, requirement }, { authority: "SECONDARY_AI", status: "COMPLETED_WORKTRACE" })
  link("completed_by", { task: task.id, criterion, evidence: "source:binding-delivery-receipt" }, { authority: "SECONDARY_AI", status: "PASS_RECORDED", proofStatus: task.proofStatus })
  for (const prerequisite of task.dependsOn) link("task_depends_on", { task: task.id, prerequisite }, { authority: "SECONDARY_AI", status: "COMPLETED_DEPENDENCY" })
  for (const proposal of task.proposals) link("advances", { task: task.id, proposal }, { authority: "SECONDARY_AI", status: "COMPLETED_WORKTRACE" })
}
const coreArtifacts = corePlan.sourceEvidence.map(source => add(`artifact:core-cli:${source.path}`, "Artifact", publicLocation(source.path), { path: source.path, sourceDigest: `sha256:${source.sha256}`, scope: source.kind, remoteObservation: "NOT_PERFORMED" }))
for (const task of corePlan.tasks) {
  add(task.id, "Task", publicLocation(corePlanPath), { ...task, authority: "SECONDARY_AI", sourceStatus: "PLANNED_CORE_CLI_WORK" })
  const criterion = `criterion:${task.id.slice("task:".length)}`
  add(criterion, "AcceptanceCriterion", publicLocation(corePlanPath), { task: task.id, checks: task.acceptance, status: "PLANNED_NOT_EXECUTED" })
  link("planned_work", { task: task.id, criterion, requirement: corePlan.userRequest.id }, { authority: "SECONDARY_AI", status: "PLANNED_WORKTRACE" })
  for (const prerequisite of task.dependsOn) link("task_depends_on", { task: task.id, prerequisite }, { authority: "SECONDARY_AI", status: "PLANNED_DEPENDENCY" })
  for (const artifact of coreArtifacts) link("planned_evidence", { task: task.id, artifact }, { authority: "SECONDARY_AI", status: "LOCAL_SNAPSHOT_EVIDENCE" })
}
const raw = JSON.stringify(graph, null, 2) + "\n"
const report = checkResourceGraphProfile(graph, profile)
if (report.status !== "CONFORMS") throw new Error(JSON.stringify(report.issues))
Either.getOrThrow(adaptResourceGraph(raw, { namespace: "usl.syntax.cli.architecture", profile }))
const jsonld = Either.getOrThrow(resourceGraphJsonLd(raw, { namespace: "usl.syntax.cli.architecture", profile }))
const shapes = ["@prefix usl: <urn:usl:vocab:> .", "@prefix arc: <urn:usl:syntax-cli:> .", "@prefix sh: <http://www.w3.org/ns/shacl#> .", "",
  `arc:ArchitectureRoleShape a sh:NodeShape ; sh:targetClass usl:Link ; sh:or ( ${rules.map(([id]) => `arc:${id}Shape`).join(" ")} ) .`, "",
  ...rules.map(([id, roles]) => [`arc:${id}Shape a sh:NodeShape ;`, `  sh:property [ sh:path (usl:meaning usl:nativeId) ; sh:hasValue ${JSON.stringify(prefix + id)} ] ;`,
    `  sh:property [ sh:path (usl:participant usl:role) ; sh:in ( ${roles.map(([role]) => JSON.stringify(role)).join(" ")} ) ] ;`,
    ...roles.map(([role, type]) => `  sh:property [ sh:path usl:participant ; sh:qualifiedMinCount 1 ; sh:qualifiedMaxCount 1 ; sh:qualifiedValueShape [ sh:property [ sh:path usl:role ; sh:hasValue ${JSON.stringify(role)} ] ; sh:property [ sh:path usl:resource ; sh:class arc:${type} ] ] ] ;`),
  ].join("\n").replace(/;$/, ".")), ""].join("\n")
// Human-readable projection of the same task nodes and dependency links.
const taskNodes = graph.resources.filter(resource => resource.types.includes(prefix + "Task"))
const taskNodeById = new Map(taskNodes.map(task => [task.id, task]))
const dependencies = graph.links.filter(edge => edge.meaning === prefix + "task_depends_on").map(edge => ({
  task: edge.participants.find(participant => participant.role === "task")!.resource,
  prerequisite: edge.participants.find(participant => participant.role === "prerequisite")!.resource,
}))
const prerequisites = (id: string) => dependencies.filter(edge => edge.task === id).map(edge => edge.prerequisite)
const ready = taskNodes.filter(task => task.metadata?.status === "PLANNED" &&
  prerequisites(task.id).every(id => taskNodeById.get(id)?.metadata?.status === "COMPLETED"))
const md = (value: unknown) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ")
const short = (id: string) => id.replace(/^task:/, "")
const relationIds = new Set(["planned_work", "completed_by", "task_depends_on", "planned_evidence", "measured_by"])
const overview = [
  "# USL 표준 그래프 엔지니어링 현황", "",
  "이 문서는 기존 작업 그래프에서 자동 생성한 **SECONDARY_AI 현황 뷰**다. 사용자 원문은 그래프의 USER_PRIMARY 자원에 보존한다.", "",
  "## 1. 역할과 경계", "",
  "| 층 | 책임 |",
  "|---|---|",
  "| USL 문법 | Resource·Meaning·이름 있는 Participant·Link·출처를 보존하는 단순 바인딩 |",
  "| core CLI / SDK | 선언·구조 검사·연결 탐색·명시적 표현 선택·compact 문맥 전달 |",
  "| 선택 profile | 사용자가 선택한 역할 타입·필수 metadata 검사 |",
  "| 소비자 프로그램 / 애드온 | 가중치 해석·갱신, 계층 알고리즘, M 색인, HSWM 규칙과 실행 |", "",
  "자원의 ID와 로컬 경로·GitHub·고정 revision 표현을 구분한다. 경로 이동은 workspace mapping으로 처리하며, 여러 표현은 명시적으로 선택한다.", "",
  "## 2. 작업 상태와 선행 관계", "",
  "아래 화살표는 **선행 작업 → 후속 작업**이다. 저장된 task_depends_on 관계는 task → prerequisite 방향이며, 그림은 읽기 편하게 그 반대로 표시한다.", "",
  "```mermaid", "flowchart LR",
  ...taskNodes.map(task => `  ${short(task.id)}["${short(task.id)} · ${task.metadata?.status === "COMPLETED" ? "완료" : "계획"}"]`),
  ...dependencies.map(edge => `  ${short(edge.prerequisite)} --> ${short(edge.task)}`),
  "```", "",
  "| 작업 | 내용 | 상태 | 선행 작업 | 검증 / 증명 |",
  "|---|---|---|---|---|",
  ...taskNodes.map(task => `| ${short(task.id)} | ${md(task.metadata?.title)} | ${md(task.metadata?.status)} | ${prerequisites(task.id).map(short).join(", ") || "없음"} | ${task.metadata?.status === "COMPLETED" ? "로컬 PASS 기록" : "구현 전"} / ${md(task.metadata?.proofStatus)} |`), "",
  `**현재 선행 조건이 충족된 미완료 작업: ${ready.map(task => short(task.id)).join(", ") || "없음"}.** 이는 작업 순서 판정이며 외부 실행 권한을 부여하지 않는다.`, "",
  "C02·C03·C04 사이의 추가 선행 관계는 선언되어 있지 않다. 실제 작업 시 겹치는 파일의 변경을 조정한다.", "",
  "## 3. 관계의 타입과 역할", "",
  "| 관계 | 이름 있는 역할과 대상 타입 | 뜻 |",
  "|---|---|---|",
  ...rules.filter(([id]) => relationIds.has(id)).map(([id, roles]) => {
    const descriptions: Record<string, string> = {
      planned_work: "작업·수용 기준·사용자 요구의 추적",
      completed_by: "작업·수용 기준·실제 검증 기록의 연결",
      task_depends_on: "작업의 선행 조건; 이 관계의 작업 그래프만 순환 금지",
      planned_evidence: "계획 판단에 참고한 현재 소스; 미래 구현 완료 근거와 구분",
      measured_by: "압축 요구·기법·오프라인 측정 결과의 연결",
    }
    return `| ${id} | ${roles.map(([role, type]) => `${role}: ${type}`).join(" / ")} | ${descriptions[id]} |`
  }), "",
  "각 연결 안에서 표의 역할은 정확히 하나씩 필요하고 추가 역할은 허용하지 않는다. 한 작업에는 요구사항이나 선행 작업별로 여러 연결이 붙을 수 있다. 수용 기준과 완료 근거는 별도 자원으로 보존한다.", "",
  "## 4. 근거와 검증 범위", "",
  `- P01~P03은 [검증 기록](../${receiptPath})의 ${receipt.generatedAt} 로컬 명령 PASS와 파일 digest로 연결되어 있다. 이 요약의 재생성은 그 테스트 명령을 재실행하지 않는다.`,
  "- JSON-LD/RDF 교환 표현과 PROV-O 출처 관계, SHACL 역할·타입·카디널리티 검사를 사용한다. USL 어휘와 task 상태 규약은 프로젝트 소유다.",
  "- 별도 검증기가 현재 파일 digest, 완료 근거 연결, 작업 상태와 선행 관계의 순환 여부를 확인한다. 명령 기록은 서명된 실행 증명이나 원격 상태 관측이 아니다.",
  "- P01~P03의 완료는 기초 계약·예제·유한 CLI 검증의 완료다. graph-cli 제안 전체나 C01~C04의 완료를 뜻하지 않는다.",
  "- 기존 [Lean 모델의 증명 범위](LEAN4_INTEGRATION.md)와 이번 작업의 NOT_PROVEN을 구분한다. CLI 외부 효과·토큰 비용에 새 증명을 추가하지 않았다.",
  "- [압축 측정](COMPACT_SYNTAX_RESEARCH.md)은 bytes와 encoding별 tokens를 구분한다. 실제 heap·API 청구액·모델 품질은 미측정이다.", "",
  "## 5. 탐색과 재현", "",
  "| 확인할 질문 | 읽을 자료 |",
  "|---|---|",
  "| 코어와 프로그램의 책임은? | [아키텍처](SYNTAX_CLI_GRAPH_ARCHITECTURE.md) |",
  "| 무엇을 완료했나? | [P01~P03](HSWM_LIKE_EXECUTION_PLAN.md) · [애드온 예제](ADDON_BINDING.md) |",
  "| 다음 변경 파일과 완료 조건은? | [C01~C04 계획](CORE_CLI_PLAN.md) |",
  "| 기계가 읽는 원본은? | [resource graph](../research/architecture/syntax-cli.graph.json) · [JSON-LD](../research/architecture/syntax-cli.graph.jsonld) · [profile](../research/architecture/syntax-cli.profile.json) · [SHACL](../research/architecture/syntax-cli.shacl.ttl) |", "",
  "```sh",
  "node --import tsx scripts/build-syntax-cli-architecture.ts --check",
  "python3 scripts/validate-syntax-cli-architecture.py",
  "```", "",
  "SHACL 검사는 scripts/requirements-standards.txt를 설치한 Python 환경을 사용한다. 원본 catalog/plan 수정 후 generator를 --check 없이 실행하면 그래프와 이 문서를 함께 갱신한다.", "",
  `그래프 digest: \`${digestSource(raw)}\`.`, "",
].join("\n")
const outputs: Record<string, string> = {
  "research/architecture/syntax-cli.graph.json": raw,
  "research/architecture/syntax-cli.graph.jsonld": JSON.stringify(jsonld, null, 2) + "\n",
  "research/architecture/syntax-cli.profile.json": JSON.stringify(profile, null, 2) + "\n",
  "research/architecture/syntax-cli.shacl.ttl": shapes,
  "docs/GRAPH_ENGINEERING_STATUS.md": overview,
}
for (const [path, value] of Object.entries(outputs)) { if (check) { if (await read(path) !== value) throw new Error(`generated artifact differs: ${path}`) } else await writeFile(resolve(root, path), value) }
console.log(JSON.stringify({ resources: graph.resources.length, links: graph.links.length, profile: report.status, sourceCommit: commit, mode: check ? "CHECKED" : "BUILT" }))
