/** Dated review snapshot. This builds traceability; it never reruns tests or proves runtime code. */
import { readFile, writeFile } from "node:fs/promises"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Either } from "effect"
import { digestSource } from "../src/language/digest.js"
import { parseResourceGraph, resourceGraphJsonLd, type ResourceGraph } from "../src/integrations/resource-graph.js"
import { checkResourceGraphProfile, type DomainProfile } from "../src/domain-profile.js"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const base = "01239ca94abab374cca0a7240c4fb31235fb221a"
const check = process.argv.includes("--check")
if (process.argv.slice(2).some(arg => arg !== "--check")) throw new Error("usage: build-current-state.ts [--check]")
const read = (file: string) => readFile(resolve(root, file), "utf8")
const run = promisify(execFile)
// The receipt is host-reported. Matching files cannot authenticate its execution,
// but must not let a changed test suite inherit the old reviewed-commit claim.
const subjectPaths = ["src", "test", "lean", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json", "scripts/build-engineering-review.ts"]
await run("git", ["diff", "--quiet", base, "--", ...subjectPaths], { cwd: root })
const untracked = await run("git", ["ls-files", "--others", "--exclude-standard", "--", ...subjectPaths], { cwd: root })
if (untracked.stdout.trim()) throw new Error("unreviewed source/test files exist; create fresh execution evidence")
const previous = JSON.parse(await read("research/engineering/receipt.json")) as { sourceRoot: string }
const prefix = "urn:usl:status:"
const location = (file: string) => `${previous.sourceRoot}/${file}`
const graph: ResourceGraph = { schema: "usl-resource-graph/v1", resources: [], meanings: [], links: [],
  provenance: { sources: ["review:document", "review:generator"], activity: "review:activity", agent: "review:agent" } }
type Metadata = NonNullable<ResourceGraph["resources"][number]["metadata"]>
const add = (id: string, type: string, locator: string, metadata: Metadata) => {
  if (graph.resources.some(r => r.id === id)) return id
  graph.resources.push({ id, types: [prefix + type], locator, metadata }); return id
}
const file = async (id: string, type: string, path: string, metadata: Metadata = {}, pinned = false) => {
  const raw = await read(path)
  if (pinned) {
    const historical = await run("git", ["show", `${base}:${path}`], { cwd: root, maxBuffer: 2 * 1024 * 1024 })
    if (raw !== historical.stdout) throw new Error(`reviewed implementation changed: ${path}; create fresh evidence and update this review`)
  }
  return add(id, type, location(path), { path, sourceDigest: digestSource(raw), ...(pinned ? { reviewedCommit: base } : {}), ...metadata })
}
const rules: Array<[string, Array<[string, string]>]> = [
  ["implemented_by", [["feature", "Feature"], ["artifact", "Artifact"]]],
  ["tested_by", [["feature", "Feature"], ["evidence", "TestEvidence"]]],
  ["modeled_by", [["feature", "Feature"], ["model", "FormalModel"]]],
  ["defined_by", [["model", "FormalModel"], ["artifact", "Artifact"]]],
  ["proved_by", [["model", "FormalModel"], ["evidence", "FormalEvidence"]]],
  ["compared_by", [["model", "FormalModel"], ["evidence", "ComparisonEvidence"]]],
  ["bounded_by", [["feature", "Feature"], ["limitation", "Limitation"]]],
  ["addressed_by", [["limitation", "Limitation"], ["task", "Task"]]],
  ["depends_on", [["task", "Task"], ["prerequisite", "Task"]]],
  ["informed_by", [["task", "Task"], ["source", "ExternalSource"]]],
  ["structurally_checked_by", [["artifact", "Artifact"], ["evidence", "StructuralEvidence"]]],
]
const profile: DomainProfile = { schema: "usl-domain-profile/v1", id: prefix + "profile", version: "1", closedMeanings: true,
  meanings: rules.map(([name, roles]) => ({ id: prefix + name, allowExtraRoles: false,
    roles: roles.map(([role, type]) => ({ role, required: true, types: [prefix + type], metadata: [] })) })) }
graph.meanings = rules.map(([name]) => ({ id: prefix + name,
  description: `Dated review relation ${name}; declared traceability only, no new execution, authority or runtime proof.` }))
const link = (name: string, participants: Record<string, string>) => graph.links.push({
  id: `${name}:${Object.values(participants).join(":")}`, meaning: prefix + name,
  participants: Object.entries(participants).map(([role, resource]) => ({ role, resource })) })

await file("review:document", "Source", "docs/CURRENT_STATE_AND_NEXT_STEPS.md", { authority: "SECONDARY_AI", reviewedCommit: base })
await file("review:generator", "Source", "scripts/build-current-state.ts")
add("review:activity", "ReviewActivity", location("docs/CURRENT_STATE_AND_NEXT_STEPS.md"), {
  reviewedAt: "2026-09-28", reviewedCommit: base, scope: "REPOSITORY_REVIEW", workflowExecution: "NOT_EXECUTED", internationalCertification: "NOT_CLAIMED" })
add("review:agent", "Agent", location("docs/CURRENT_STATE_AND_NEXT_STEPS.md"), { authority: "SECONDARY_AI", ratification: "NOT_CLAIMED" })
await file("evidence:typescript", "TestEvidence", "audit/current-state-2026-09-28-tests.log", {
  command: "npm test", tests: 282, passed: 282, failed: 0, verification: "HOST_REPORTED_LOCAL_TESTS",
  scope: "FINITE_TEST_CASES_AT_REVIEWED_COMMIT", executionBinding: "HOST_ASSERTION_WITH_CODE_COMPARISON_AND_LOG_DIGEST", signed: false })
const testLog = await read("audit/current-state-2026-09-28-tests.log")
if (!testLog.includes("ℹ tests 282") || !testLog.includes("ℹ pass 282") || !testLog.includes("ℹ fail 0")) throw new Error("test log differs from review evidence")
await file("evidence:lean", "FormalEvidence", "audit/LEAN_SCOPE_2026-09-28.md", {
  scope: "LEAN_ABSTRACT_GRAPH_MODEL_ONLY", theorems: 37, toolchain: "4.33.1", runtimeRefinement: "NOT_ESTABLISHED",
  cliHostCoverage: "NOT_ESTABLISHED", allowedAxioms: ["propext", "Classical.choice", "Quot.sound"],
  proofExecution: "HOST_REPORTED_LEAN_KERNEL_AND_AXIOM_AUDIT", independentChecker: "NOT_RUN" })
await file("evidence:comparison", "ComparisonEvidence", "test/lean4.integration.ts", {
  cases: 383, scope: "FINITE_TS_LEAN_COMPARISONS", refinementProof: "NOT_ESTABLISHED", runEvidence: "evidence:lean" }, true)
await file("model:lean", "FormalModel", "lean/Examples/ProofAudit.lean", { scope: "LEAN_ABSTRACT_GRAPH_MODEL_ONLY" }, true)
link("proved_by", { model: "model:lean", evidence: "evidence:lean" })
link("compared_by", { model: "model:lean", evidence: "evidence:comparison" })

const features = [
  { id: "graph", title: "의미 그래프·역할·탐색·읽기 범위", files: ["src/integrations/resource-graph.ts", "src/language/navigation.ts", "src/language/runtime.ts"],
    gap: "Lean 모델 일부와 유한 대조만 있으며 TS 전체 refinement와 외부 의미의 참은 미증명", tasks: ["T1"] },
  { id: "bindings", title: "stable resource ID·명시적 복수 표현·경로 이동", files: ["src/resource-bindings.ts", "src/integrations/resource-bindings.ts"],
    gap: "Git repository/worktree/dirty 자동 attestation과 binding Lean 모델 없음", tasks: ["T3"] },
  { id: "capability", title: "기능 발견·호스트 정책·schema와 source pin", files: ["src/capabilities.ts", "src/capability-catalog.ts"],
    gap: "실제 owner 인가·정책 revision/위임/철회 근거는 호스트 의존", tasks: ["T6"] },
  { id: "cli", title: "GraphSpec entry에 결속한 단일 CLI 실행", files: ["src/cli-host.ts", "src/cli-host-command.ts", "src/cli-process.ts"],
    gap: "intent-only 자동 복구·operation 중복 식별·effect reconciliation·Lean 상태 모델 미구현", tasks: ["T1", "T2"] },
  { id: "geip", title: "GEIP GraphSpec 문서·digest·entry 제약", files: ["src/integrations/graph-engineering.ts", "examples/fixtures/cli/graphspec.json"],
    gap: "로컬 draft 구조 검사와 entry node만 제공; 전체 lifecycle/gate/loop 집행 없음", tasks: ["T4"] },
  { id: "integration", title: "SDK·CLI·MCP와 지침의 연결", files: ["src/application.ts", "src/mcp.ts", "src/integrations/capability-inventory.ts"],
    gap: "범용 원격 driver와 실제 여러 단계 업무의 복구 포함 완주 미구현", tasks: ["T5"] },
  { id: "observation", title: "filesystem·Git·HTTP 관측 예산", files: ["src/bounded-read.ts", "src/resolve.ts"],
    gap: "OS IO 의미론·프로세스 취소·외부 서비스의 전체 동작은 Lean 증명 범위 밖", tasks: ["T1"] },
]
for (const f of features) {
  const id = add(`feature:${f.id}`, "Feature", location("docs/CURRENT_STATE_AND_NEXT_STEPS.md"), {
    title: f.title, implementationStatus: "IMPLEMENTED_AT_REVIEWED_COMMIT", reviewedCommit: base,
    leanCoverage: f.id === "graph" ? "PARTIAL_ABSTRACT_MODEL" : "NOT_ESTABLISHED" })
  for (const path of f.files) {
    const artifact = await file(`artifact:${path}`, "Artifact", path, {}, true)
    link("implemented_by", { feature: id, artifact })
  }
  link("tested_by", { feature: id, evidence: "evidence:typescript" })
  add(`gap:${f.id}`, "Limitation", location("docs/CURRENT_STATE_AND_NEXT_STEPS.md"), { detail: f.gap })
  link("bounded_by", { feature: id, limitation: `gap:${f.id}` })
  for (const task of f.tasks) link("addressed_by", { limitation: `gap:${f.id}`, task: `task:${task}` })
}
link("modeled_by", { feature: "feature:graph", model: "model:lean" })
for (const path of ["lean/Usl/Core.lean", "lean/Usl/Verification.lean", "lean/Usl/Contracts.lean", "lean/Examples/Conformance.lean", "lean/lean-toolchain"]) {
  const artifact = await file(`artifact:${path}`, "Artifact", path, {}, true)
  link("defined_by", { model: "model:lean", artifact })
}
await file("evidence:geip", "StructuralEvidence", "examples/fixtures/cli/graphspec-validation.json", {
  scope: "GEIP_DOCUMENT_STRUCTURE_ONLY", runtimeConformance: "NOT_ESTABLISHED" }, true)
const geip = JSON.parse(await read("examples/fixtures/cli/graphspec-validation.json")) as { subject: { graphspec_sha256: string } }
if (digestSource(await read("examples/fixtures/cli/graphspec.json")) !== `sha256:${geip.subject.graphspec_sha256}`) throw new Error("GEIP evidence/subject pin mismatch")
link("structurally_checked_by", { artifact: "artifact:examples/fixtures/cli/graphspec.json", evidence: "evidence:geip" })

const tasks: Array<[string, string, string, string[], string]> = [
  ["T1", "P0", "실행 상태 계약과 Lean 모델", [], "Intent-before-spawn, mismatch-before-start, no automatic retry; finite TS traces kept separate from proof"],
  ["T2", "P0", "조회·복구와 logical operation 중복 처리", ["T1"], "Crash/restart matrix; owner APPLIED/NOT_APPLIED/UNKNOWN evidence; stable key + semantic intent hash; collision rejection"],
  ["T3", "P1", "Git identity 관측과 binding 모델", [], "Repo/worktree/commit/dirty provenance; explicit fork/mirror policy; relocation cases and Lean selection/ID preservation model"],
  ["T4", "P1", "최소 READ-only GraphSpec DAG", ["T1", "T2"], "2-3 nodes, typed data edges, dependency and failure propagation, step/time budgets; unsupported gate/loop rejection"],
  ["T5", "P2", "실제 프로그램 하나를 동일 host 계약으로 이관", ["T3", "T4"], "Discover/context/plan/run/inspect/reconcile on one real task; thin skill/MCP facade"],
  ["T6", "P2", "소유자·정책 revision과 provenance 신뢰 범위", ["T2"], "Owner/revision evidence and trust policy; signatures only where required; no automatic SLSA/in-toto claim"],
]
for (const [id, priority, title, dependencies, acceptance] of tasks) {
  add(`task:${id}`, "Task", location("docs/CURRENT_STATE_AND_NEXT_STEPS.md"), { priority, title, acceptance,
    status: "PROPOSED", authority: "SECONDARY_AI", execution: "NOT_EXECUTED" })
  for (const prerequisite of dependencies) link("depends_on", { task: `task:${id}`, prerequisite: `task:${prerequisite}` })
}
const sources = [
  ["prov", "https://www.w3.org/TR/prov-o/", "T3"],
  ["lean", "https://lean-lang.org/doc/reference/latest/ValidatingProofs/", "T1"],
  ["idempotency", "https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/", "T2"],
  ["slsa", "https://slsa.dev/spec/v1.2/build-requirements", "T6"],
  ["mcp", "https://modelcontextprotocol.io/specification/2025-11-25/server", "T5"],
] as const
for (const [id, url, task] of sources) {
  add(`external:${id}`, "ExternalSource", url, { consultedAt: "2026-09-28", application: "DESIGN_INFERENCE_NOT_CERTIFICATION" })
  link("informed_by", { task: `task:${task}`, source: `external:${id}` })
}
await file("review:direction", "Source", "research/engineering/DIRECTION_REVIEW_2026-09-28.md")
await file("review:engineering", "Source", "research/engineering/receipt.json", { scope: "12_CONTROLS_25_CHECKS_ONLY", cliReplay: "NOT_INCLUDED", leanReplay: "NOT_INCLUDED" })
await file("artifact:ci", "Artifact", ".github/workflows/verify.yml", { remoteExecution: "NOT_OBSERVED" }, true)

const raw = JSON.stringify(graph, null, 2) + "\n"
Either.getOrThrow(parseResourceGraph(raw))
const validation = checkResourceGraphProfile(graph, profile)
if (validation.status !== "CONFORMS") throw new Error(JSON.stringify(validation.issues))
const jsonld = Either.getOrThrow(resourceGraphJsonLd(raw, { namespace: "usl.status", profile }))
const shapes = ["@prefix usl: <urn:usl:vocab:> .", "@prefix st: <urn:usl:status:> .", "@prefix sh: <http://www.w3.org/ns/shacl#> .", "",
  `st:RoleShape a sh:NodeShape ; sh:targetClass usl:Link ; sh:or ( ${rules.map(([name]) => `st:${name}Shape`).join(" ")} ) .`,
  ...rules.map(([name, roles]) => [
    `st:${name}Shape a sh:NodeShape ;`,
    `sh:property [ sh:path (usl:meaning usl:nativeId) ; sh:hasValue "${prefix}${name}" ] ;`,
    `sh:property [ sh:path (usl:participant usl:role) ; sh:in ( ${roles.map(([role]) => JSON.stringify(role)).join(" ")} ) ] ;`,
    ...roles.map(([role, type]) => `sh:property [ sh:path usl:participant ; sh:qualifiedMinCount 1 ; sh:qualifiedMaxCount 1 ; sh:qualifiedValueShape [ sh:property [ sh:path usl:role ; sh:hasValue "${role}" ] ; sh:property [ sh:path usl:resource ; sh:class st:${type} ] ] ] ;`),
  ].join("\n").replace(/;$/, ".")), "",
].join("\n")
const outputs = { "research/engineering/current-state.graph.json": raw,
  "research/engineering/current-state.graph.jsonld": JSON.stringify(jsonld, null, 2) + "\n",
  "research/engineering/current-state.profile.json": JSON.stringify(profile, null, 2) + "\n",
  "schemas/current-state.shacl.ttl": shapes }
for (const [path, value] of Object.entries(outputs)) {
  if (check) { if (await read(path) !== value) throw new Error(`review artifact differs: ${path}`) }
  else await writeFile(resolve(root, path), value)
}
console.log(JSON.stringify({ reviewedCommit: base, features: features.length, tasks: tasks.length, resources: graph.resources.length,
  links: graph.links.length, profile: validation.status, mode: check ? "PINS_AND_ARTIFACTS_CHECKED" : "SNAPSHOT_BUILT", testsReplayed: false }))
