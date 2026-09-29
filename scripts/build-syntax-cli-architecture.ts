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
type CompressionSource = { id: string; title: string; url: string; technique: string; scope: string; limitation: string; checkedAt: string }
type CompressionBenchmark = { schema: string; scope: string; validationStatus: string; environment: { encodings: string[]; memory: string }; inputs: { digest: string; benchmarkScriptDigest: string; tokenScriptDigest: string; requirementsDigest: string }; fixtures: unknown[] }
const workPlan = JSON.parse(await read("research/architecture/hswm-like.plan.json")) as WorkPlan
const compressionSources = JSON.parse(await read("research/compression/sources.json")) as CompressionSource[]
const compressionBenchmark = JSON.parse(await read("research/compression/benchmark-results.json")) as CompressionBenchmark
if (catalog.schema !== "usl-syntax-cli-architecture-catalog/v1" || catalog.authority !== "SECONDARY_AI" || !/^[a-f0-9]{40}$/.test(catalog.sourceCommit) ||
  !catalog.sourcePins || !catalog.proposalPlacement || !Array.isArray(catalog.userStatements) || !Array.isArray(catalog.implemented) || !Array.isArray(catalog.proposals)) throw new Error("invalid syntax-cli architecture catalog")
for (const statement of catalog.userStatements) if (!/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/.test(statement.id) || statement.status !== "USER_PRIMARY" || !statement.text.trim()) throw new Error("invalid user statement")
for (const item of catalog.implemented) if (!Array.isArray(item) || item.length !== 3 || !item[0].startsWith("feature:") || !item[1].trim() || !Array.isArray(item[2]) || item[2].some(path => typeof path !== "string" || !path.startsWith("src/"))) throw new Error("invalid implemented feature")
for (const item of catalog.proposals) if (!Array.isArray(item) || item.length !== 3 || !item[0].startsWith("proposal:") || item.slice(1).some(value => !value.trim())) throw new Error("invalid proposal")
for (const [id] of catalog.proposals) if (!["ADDON_RESPONSIBILITY", "MINIMAL_BINDING_CLI"].includes(catalog.proposalPlacement[id] ?? "")) throw new Error(`invalid proposal placement: ${id}`)
if (workPlan.schema !== "usl-hswm-like-work-plan/v1" || workPlan.authority !== "SECONDARY_AI" || workPlan.status !== "PLANNED" || workPlan.userRequest.id !== "user:hswm-plan" || workPlan.userRequest.authority !== "USER_PRIMARY" || !workPlan.userRequest.text.trim()) throw new Error("invalid HSWM-like work plan")
if (compressionSources.length < 4 || compressionSources.some(source => !/^[a-z0-9-]+$/.test(source.id) || !source.title.trim() || !/^https:\/\//.test(source.url) || !source.technique.trim() || !source.scope.trim() || !source.limitation.trim() || !/^\d{4}-\d\d-\d\d$/.test(source.checkedAt))) throw new Error("invalid compression source")
if (compressionBenchmark.schema !== "usl-compression-benchmark-results/v1" || compressionBenchmark.scope !== "OFFLINE_PAYLOAD_MEASUREMENT_NOT_RUNTIME_MEMORY_OR_BILLED_USAGE" || compressionBenchmark.validationStatus !== "FIXTURE_ROUNDTRIPS_PASSED" || !compressionBenchmark.environment.encodings.length || !compressionBenchmark.environment.memory.includes("HEAP_NOT_MEASURED") || ![compressionBenchmark.inputs.digest, compressionBenchmark.inputs.benchmarkScriptDigest, compressionBenchmark.inputs.tokenScriptDigest, compressionBenchmark.inputs.requirementsDigest].every(value => /^sha256:[a-f0-9]{64}$/.test(value)) || !compressionBenchmark.fixtures.length) throw new Error("invalid compression benchmark")
const taskIds = new Set<string>()
for (const task of workPlan.tasks) {
  if (!/^task:P\d\d$/.test(task.id) || taskIds.has(task.id) || !Number.isSafeInteger(task.order) || task.order < 1 || !task.title.trim() || task.status !== "PLANNED" || task.implementation !== "NOT_STARTED" || task.proofStatus !== "NOT_PROVEN" || !task.deliverables.length || task.deliverables.some(path => !/^(src|test|docs|schemas|examples|lean)\//.test(path)) || !task.acceptance.length || task.acceptance.some(item => !item.trim())) throw new Error(`invalid planned task: ${task.id}`)
  taskIds.add(task.id)
}
const commit = catalog.sourceCommit
const prefix = "urn:usl:syntax-cli:"
const location = (path: string) => `git://github.com/gj3447/USL@${commit}:${path}`
const publicLocation = (path: string) => `https://github.com/gj3447/USL/blob/master/${path}`
const graph: ResourceGraph = { schema: "usl-resource-graph/v1", resources: [], meanings: [], links: [], provenance: { sources: ["source:catalog", "source:generator", "source:hswm-plan", "source:compression-sources", "artifact:compression-benchmark"], activity: "activity:architecture", agent: "agent:secondary" } }
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
add("source:compression-sources", "Source", publicLocation("research/compression/sources.json"), { path: "research/compression/sources.json", sourceDigest: digestSource(await read("research/compression/sources.json")), authority: "EXTERNAL_RESEARCH_CATALOG", locationStatus: "DECLARED_PUBLIC_LOCATION", remoteObservation: "NOT_PERFORMED" })
add("artifact:compression-benchmark", "BenchmarkArtifact", publicLocation("research/compression/benchmark-results.json"), { path: "research/compression/benchmark-results.json", sourceDigest: digestSource(await read("research/compression/benchmark-results.json")), resultStatus: compressionBenchmark.scope, validationStatus: compressionBenchmark.validationStatus, memory: compressionBenchmark.environment.memory, tokenEncodings: compressionBenchmark.environment.encodings, billing: "NOT_MEASURED", llmQuality: "NOT_MEASURED", remoteExecution: "NOT_PERFORMED" })
add("activity:architecture", ["ArchitectureActivity", "http://www.w3.org/ns/prov#Activity"], publicLocation("research/architecture/syntax-cli.catalog.json"), { status: "DECLARED", scope: "CURRENT_IMPLEMENTATION_AND_PROPOSAL_SEPARATION", runtimeTests: "NOT_CLAIMED" })
add("agent:secondary", ["Agent", "http://www.w3.org/ns/prov#Agent"], publicLocation("research/architecture/syntax-cli.catalog.json"), { authority: "SECONDARY_AI", ratification: "NOT_CLAIMED" })
add("subject:usl", "ArchitectureSubject", "git://github.com/gj3447/USL", { name: "USL", role: "LANGUAGE_AND_CLI_BINDING_LAYER" })
for (const statement of catalog.userStatements) add(statement.id, "UserStatement", publicLocation("research/architecture/syntax-cli.catalog.json"), { status: statement.status, text: statement.text, authority: "USER_PRIMARY", locationStatus: "DECLARED_PUBLIC_LOCATION", remoteObservation: "NOT_PERFORMED" })
add(workPlan.userRequest.id, "UserStatement", publicLocation("research/architecture/hswm-like.plan.json"), { status: "USER_PRIMARY", text: workPlan.userRequest.text, authority: workPlan.userRequest.authority, locationStatus: "DECLARED_PUBLIC_LOCATION", remoteObservation: "NOT_PERFORMED" })
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
  add(task.id, "Task", publicLocation("research/architecture/hswm-like.plan.json"), { ...task, authority: "SECONDARY_AI", sourceStatus: "PLANNED_WORK" })
  const criterion = `criterion:${task.id.slice("task:".length)}`
  add(criterion, "AcceptanceCriterion", publicLocation("research/architecture/hswm-like.plan.json"), { task: task.id, checks: task.acceptance, status: "PLANNED_NOT_EXECUTED" })
  for (const requirement of task.requirements) link("planned_work", { task: task.id, criterion, requirement }, { authority: "SECONDARY_AI", status: "PLANNED_WORKTRACE" })
  for (const prerequisite of task.dependsOn) link("task_depends_on", { task: task.id, prerequisite }, { authority: "SECONDARY_AI", status: "PLANNED_DEPENDENCY" })
  for (const proposal of task.proposals) link("advances", { task: task.id, proposal }, { authority: "SECONDARY_AI", status: "PLANNED_WORKTRACE" })
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
const outputs: Record<string, string> = {
  "research/architecture/syntax-cli.graph.json": raw,
  "research/architecture/syntax-cli.graph.jsonld": JSON.stringify(jsonld, null, 2) + "\n",
  "research/architecture/syntax-cli.profile.json": JSON.stringify(profile, null, 2) + "\n",
  "research/architecture/syntax-cli.shacl.ttl": shapes,
}
for (const [path, value] of Object.entries(outputs)) { if (check) { if (await read(path) !== value) throw new Error(`generated artifact differs: ${path}`) } else await writeFile(resolve(root, path), value) }
console.log(JSON.stringify({ resources: graph.resources.length, links: graph.links.length, profile: report.status, sourceCommit: commit, mode: check ? "CHECKED" : "BUILT" }))
