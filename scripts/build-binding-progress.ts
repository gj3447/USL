/**
 * Current increment traceability.  Unlike the dated current-state review, this
 * records source definitions only: it neither reruns nor claims any tests.
 */
import { readFile, writeFile } from "node:fs/promises"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { Either } from "effect"
import { digestSource } from "../src/language/digest.js"
import { adaptResourceGraph, parseResourceGraph, resourceGraphJsonLd, type ResourceGraph } from "../src/integrations/resource-graph.js"
import { checkResourceGraphProfile, parseDomainProfile, type DomainProfile } from "../src/domain-profile.js"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const check = process.argv.includes("--check")
if (process.argv.slice(2).some(arg => arg !== "--check")) throw new Error("usage: build-binding-progress.ts [--check]")
const read = (path: string) => readFile(resolve(root, path), "utf8")
const receipt = JSON.parse(await read("research/engineering/receipt.json")) as { sourceRoot?: unknown }
if (typeof receipt.sourceRoot !== "string" || !/^file:\/\/[^/]+\/.+/.test(receipt.sourceRoot)) throw new Error("engineering receipt lacks a recorded file sourceRoot")
const sourceRoot = receipt.sourceRoot.replace(/\/+$/, "")
// This is a recorded host locator, never an inference from this process cwd.
// A moved checkout must use the normal explicit representation binding flow.
const location = (path: string) => `${sourceRoot}/${path}`
const prefix = "urn:usl:status:"
const profile = parseDomainProfile(JSON.parse(await read("research/engineering/current-state.profile.json"))) as DomainProfile
const graph: ResourceGraph = { schema: "usl-resource-graph/v1", resources: [], meanings: [], links: [],
  provenance: { sources: ["progress:generator"], activity: "progress:activity", agent: "progress:agent" } }
graph.meanings = profile.meanings.map(meaning => ({ id: meaning.id,
  description: `Current binding-progress traceability relation ${meaning.id}; structural declaration only.` }))
type Metadata = NonNullable<ResourceGraph["resources"][number]["metadata"]>
const add = (id: string, type: string, path: string, metadata: Metadata = {}) => {
  if (graph.resources.some(resource => resource.id === id)) return id
  graph.resources.push({ id, types: [prefix + type], locator: location(path), metadata }); return id
}
const source = async (id: string, type: string, path: string, metadata: Metadata = {}) =>
  add(id, type, path, { path, sourceDigest: digestSource(await read(path)), ...metadata })
const link = (meaning: string, participants: Record<string, string>, metadata: Metadata = {}) => graph.links.push({
  id: `${meaning}:${Object.values(participants).join(":")}`, meaning: prefix + meaning,
  participants: Object.entries(participants).map(([role, resource]) => ({ role, resource })), ...(Object.keys(metadata).length ? { metadata } : {}),
})

await source("progress:generator", "Source", "scripts/build-binding-progress.ts", { scope: "DETERMINISTIC_SOURCE_TRACEABILITY_ONLY" })
add("progress:activity", "ReviewActivity", "research/engineering/binding-progress.graph.json", {
  scope: "CURRENT_INCREMENT_SOURCE_DEFINITIONS", testExecution: "NOT_CLAIMED", runtimeRefinement: "NOT_ESTABLISHED",
  remoteIdentityVerification: "NOT_ESTABLISHED", exactlyOnceExecution: "NOT_ESTABLISHED", sourceRoot,
  sourceRootStatus: "RECORDED_HOST_LOCATOR_REBIND_ON_RELOCATION",
})
add("progress:agent", "Agent", "research/engineering/binding-progress.graph.json", { authority: "SECONDARY_AI", ratification: "NOT_CLAIMED" })

const artifacts = [
  "src/resource-bindings.ts", "src/integrations/resource-bindings.ts", "src/binding-inspection.ts",
  "src/attempt-state.ts", "src/cli-operation.ts", "src/cli-recovery.ts", "src/cli-host.ts",
] as const
for (const path of artifacts) await source(`artifact:${path}`, "Artifact", path)
const tests = [
  "test/binding-inspection.test.ts", "test/attempt-state.test.ts", "test/cli-operation.test.ts", "test/cli-recovery.test.ts", "test/cli-host.test.ts",
] as const
for (const path of tests) await source(`test-definition:${path}`, "TestEvidence", path, {
  evidenceKind: "TEST_DEFINITION", execution: "NOT_CLAIMED", finiteCoverage: "NOT_CLAIMED",
})
for (const path of ["lean/Usl/Attempt.lean", "lean/Usl/Bindings.lean"] as const) await source(`model:${path}`, "FormalModel", path, {
  scope: path.endsWith("Attempt.lean") ? "PURE_ATTEMPT_STATE_MACHINE" : "PURE_BINDING_SELECTION_AND_REBINDING",
  runtimeRefinement: "NOT_ESTABLISHED", proofExecution: "NOT_CLAIMED",
})
for (const path of ["lean/Usl/Attempt.lean", "lean/Usl/Bindings.lean"] as const) await source(`artifact:${path}`, "Artifact", path,
  { role: "LEAN_MODEL_SOURCE", runtimeRefinement: "NOT_ESTABLISHED" })

const features = [
  { id: "binding-inspection", title: "명시적 표현의 경계 있는 로컬 binding 관찰", artifacts: ["src/resource-bindings.ts", "src/integrations/resource-bindings.ts", "src/binding-inspection.ts"], tests: ["test/binding-inspection.test.ts"], models: ["lean/Usl/Bindings.lean"],
    task: "T3", gap: "원격 origin 후보는 비밀값을 제거한 관찰일 뿐이며 GitHub·fork·mirror의 동일성이나 원격 commit 신뢰를 검증하지 않는다." },
  { id: "attempt-state", title: "intent 저장 뒤 실행 허용과 시작 전 거부 상태 계약", artifacts: ["src/attempt-state.ts", "src/cli-host.ts"], tests: ["test/attempt-state.test.ts", "test/cli-host.test.ts"], models: ["lean/Usl/Attempt.lean"],
    task: "T1", gap: "Lean은 순수 상태 전이만 모델링하며 TypeScript, 파일 시스템, subprocess와의 refinement 증명은 없다." },
  { id: "operation-reservation", title: "logical operation 예약과 중복 실행 거절", artifacts: ["src/cli-operation.ts", "src/cli-host.ts"], tests: ["test/cli-operation.test.ts", "test/cli-host.test.ts"], models: [],
    task: "T2", gap: "예약은 현재 host 저장소 범위다. 외부 효과의 exactly-once 보장이나 분산 owner 간 동일 operation 합의는 제공하지 않는다." },
  { id: "recovery", title: "불명확 attempt의 명시적 owner reconciliation", artifacts: ["src/cli-recovery.ts", "src/cli-host.ts"], tests: ["test/cli-recovery.test.ts", "test/cli-host.test.ts"], models: [],
    task: "T2", gap: "reconciler의 외부 관찰은 owner가 제공하는 best effort evidence이며 원격 효과·네트워크·crash recovery 전체를 형식 증명하지 않는다." },
] as const
for (const feature of features) {
  add(`feature:${feature.id}`, "Feature", "research/engineering/binding-progress.graph.json", {
    title: feature.title, implementationStatus: "CURRENT_INCREMENT_IMPLEMENTED", historicalTask: feature.task,
    historicalAcceptance: "PARTIAL_PROGRESS_ONLY", testExecution: "NOT_CLAIMED",
  })
  for (const path of feature.artifacts) link("implemented_by", { feature: `feature:${feature.id}`, artifact: `artifact:${path}` })
  for (const path of feature.tests) link("tested_by", { feature: `feature:${feature.id}`, evidence: `test-definition:${path}` },
    { relationScope: "TEST_DEFINITION_ONLY", execution: "NOT_CLAIMED" })
  for (const path of feature.models) link("modeled_by", { feature: `feature:${feature.id}`, model: `model:${path}` },
    feature.id === "binding-inspection"
      ? { relationScope: "SELECTION_AND_STABLE_ID_PRESERVATION_ONLY", gitObservation: "NOT_MODELED", runtimeRefinement: "NOT_ESTABLISHED" }
      : { relationScope: "PURE_ATTEMPT_STATE_ONLY", runtimeRefinement: "NOT_ESTABLISHED" })
  add(`gap:${feature.id}`, "Limitation", "research/engineering/binding-progress.graph.json", { detail: feature.gap })
  link("bounded_by", { feature: `feature:${feature.id}`, limitation: `gap:${feature.id}` })
  add(`historical-task:${feature.task}`, "Task", "docs/CURRENT_STATE_AND_NEXT_STEPS.md", {
    id: feature.task, status: "PARTIALLY_ADDRESSED_BY_CURRENT_INCREMENT", acceptanceComplete: false,
    source: "HISTORICAL_CURRENT_STATE_GRAPH", execution: "NOT_CLAIMED",
  })
  link("addressed_by", { limitation: `gap:${feature.id}`, task: `historical-task:${feature.task}` },
    { progress: "PARTIAL_ONLY", acceptanceComplete: false })
}
for (const [model, artifact] of [
  ["lean/Usl/Attempt.lean", "lean/Usl/Attempt.lean"], ["lean/Usl/Bindings.lean", "lean/Usl/Bindings.lean"],
] as const) link("defined_by", { model: `model:${model}`, artifact: `artifact:${artifact}` },
  { relationship: "FORMAL_MODEL_DEFINED_IN_SOURCE", runtimeRefinement: "NOT_ESTABLISHED" })

const raw = JSON.stringify(graph, null, 2) + "\n"
Either.getOrThrowWith(parseResourceGraph(raw), error => new Error(error.detail))
const validation = checkResourceGraphProfile(graph, profile)
if (validation.status !== "CONFORMS") throw new Error(JSON.stringify(validation.issues))
Either.getOrThrow(adaptResourceGraph(raw, { namespace: "usl.binding.progress", profile }))
const jsonld = Either.getOrThrow(resourceGraphJsonLd(raw, { namespace: "usl.binding.progress", profile }))
const outputs = {
  "research/engineering/binding-progress.graph.json": raw,
  "research/engineering/binding-progress.graph.jsonld": JSON.stringify(jsonld, null, 2) + "\n",
}
for (const [path, value] of Object.entries(outputs)) {
  if (check) { if (await read(path) !== value) throw new Error(`binding progress artifact differs: ${path}`) }
  else await writeFile(resolve(root, path), value)
}
console.log(JSON.stringify({ features: features.length, artifacts: artifacts.length, testDefinitions: tests.length, models: 2,
  links: graph.links.length, profile: validation.status, mode: check ? "PINS_AND_ARTIFACTS_CHECKED" : "SOURCE_TRACEABILITY_BUILT",
  testsReplayed: false, runtimeRefinement: "NOT_ESTABLISHED" }))
