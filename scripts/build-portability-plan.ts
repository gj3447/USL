/** Build a reviewable plan graph. This does not implement or execute backup/restore. */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Either } from "effect"
import { digestSource } from "../src/language/digest.js"
import { parseDomainProfile } from "../src/domain-profile.js"
import { adaptResourceGraph, resourceGraphJsonLd, type ResourceGraph } from "../src/integrations/resource-graph.js"

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), check = process.argv.includes("--check")
if (process.argv.slice(2).some(arg => arg !== "--check")) throw new Error("usage: build-portability-plan.ts [--check]")
const read = (path: string) => readFile(resolve(root, path), "utf8")
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"
const folder = "research/portability-plan", planPath = `${folder}/plan.json`, rawPlan = await read(planPath)
type Criterion = { id: string; requirement: string; expectation: string; negativeCase: string; execution: string }
type Task = { id: string; title: string; phase: string; dependsOn: string[]; requirements: string[]; status: string; implementation: string; proofStatus: string; owner: string; currentGap: string; plannedOutputs: string[]; reuses: string[]; informedBy: string[]; acceptance: Criterion[] }
type Plan = {
  schema: string; id: string; version: string; authority: string; status: string; recordedOn: string; sourceCommit: string;
  userRequest: { id: string; authority: string; text: string }; motivation: { authority: string; text: string };
  scope: Record<string, unknown>; tasks: Task[]; ordering: string;
  requirements: { id: string; text: string; authority: string; derivedFrom: string }[];
  references: { id: string; title: string; url: string; publicationStatus: string; checkedOn: string; application: string; limit: string }[];
  currentSources: { id: string; path: string; sha256: string; sourceCommit: string; evidenceKind: string; execution: string }[];
  milestones: { id: string; title: string; tasks: string[]; status: string; releaseGate: string }[];
  draftDomainContract: { status: string; namespace: string; types: string[]; typeConstraints: string[]; predicates: { name: string; domain: string; range: string; cardinality: string; meaning: string }[] };
  stateDimensions: Record<string, string[]>; planValidationScope: string; openDecisions: { topic: string; default: string }[];
}
const plan = JSON.parse(rawPlan) as Plan
if (plan.schema !== "usl-portability-work-plan/v1" || plan.authority !== "SECONDARY_AI" || plan.status !== "PLANNED") throw new Error("unexpected portability plan contract")
const ids = plan.tasks.map(t => t.id), seen = new Set<string>(), visiting = new Set<string>()
if (new Set(ids).size !== ids.length) throw new Error("duplicate task ID")
const visit = (id: string) => {
  if (visiting.has(id)) throw new Error("task dependency cycle")
  if (seen.has(id)) return
  const task = plan.tasks.find(t => t.id === id)
  if (!task || task.status !== "PLANNED" || task.implementation !== "NOT_STARTED" || task.proofStatus !== "NOT_PROVEN") throw new Error(`invalid planned task: ${id}`)
  visiting.add(id); task.dependsOn.forEach(visit); visiting.delete(id); seen.add(id)
}
ids.forEach(visit)
for (const source of plan.currentSources) {
  if (digestSource(await read(source.path)) !== source.sha256) throw new Error(`source pin drift: ${source.path}`)
  const committed = execFileSync("git", ["show", `${source.sourceCommit}:${source.path}`], { cwd: root, encoding: "utf8" })
  if (digestSource(committed) !== source.sha256) throw new Error(`source commit mismatch: ${source.path}`)
}

const p = "urn:usl:portability-plan:", status = "urn:usl:status:"
const definitions = [
  { name: "depends_on", roles: { task: "Task", prerequisite: "Task" }, description: "task requires prerequisite; directed task DAG only" },
  { name: "addresses", roles: { task: "Task", requirement: "Requirement" }, description: "planned task addresses an interpreted requirement" },
  { name: "planned_output", roles: { task: "Task", artifact: "PlannedArtifact" }, description: "intended future output, not an implemented artifact" },
  { name: "acceptance_for", roles: { task: "Task", requirement: "Requirement", criterion: "AcceptanceCriterion" }, description: "unexecuted acceptance criterion for this exact task and requirement" },
  { name: "reuses", roles: { task: "Task", source: "Source" }, description: "source definition used for implementation planning, not a test result" },
  { name: "informed_by", roles: { task: "Task", source: "Source" }, description: "source informs a design choice without granting authority or conformance" },
  { name: "scheduled_in", roles: { task: "Task", milestone: "Milestone" }, description: "planned milestone membership" },
]
const profile = parseDomainProfile({ schema: "usl-domain-profile/v1", id: p + "profile", version: "1", closedMeanings: true,
  meanings: definitions.map(({ name, roles }) => ({ id: p + name, allowExtraRoles: false,
    roles: Object.entries(roles).map(([role, type]) => ({ role, required: true, types: [status + type], metadata: [] })) })) })
const graph: ResourceGraph = { schema: "usl-resource-graph/v1", resources: [], meanings: definitions.map(d => ({ id: p + d.name, description: d.description })), links: [],
  provenance: { sources: ["source:portability-plan", "source:portability-generator", plan.userRequest.id], activity: "activity:portability-planning", agent: "agent:portability-planner" } }
const repo = (path: string) => `https://github.com/gj3447/USL/blob/master/${path}`
type Metadata = NonNullable<ResourceGraph["resources"][number]["metadata"]>
const add = (id: string, types: string[], locator: string, metadata: Metadata = {}) => graph.resources.push({ id, types, locator, metadata })
const link = (name: string, values: Record<string, string>) => graph.links.push({ id: `portability-link:${graph.links.length}`, meaning: p + name,
  participants: Object.entries(values).map(([role, resource]) => ({ role, resource })), metadata: { authority: "SECONDARY_AI", planningState: "PROPOSED", execution: "NOT_CLAIMED" } })
add("source:portability-plan", [status + "Source"], repo(planPath), { sourceDigest: digestSource(rawPlan), authority: plan.authority, status: plan.status, locatorStatus: "DECLARED_PUBLIC_LOCATION_NOT_FETCHED" })
add("source:portability-generator", [status + "Source"], repo("scripts/build-portability-plan.ts"), { sourceDigest: digestSource(await read("scripts/build-portability-plan.ts")), scope: "PLAN_ARTIFACT_GENERATION_ONLY" })
add(plan.userRequest.id, [status + "Source"], repo(planPath), { ...plan.userRequest, motivation: plan.motivation, scope: "REQUEST_FOR_WORK_PLAN" })
add("activity:portability-planning", ["http://www.w3.org/ns/prov#Activity", status + "PlanningActivity"], repo(planPath), { runtimeImplementation: "NOT_STARTED", scope: plan.planValidationScope })
add("agent:portability-planner", ["http://www.w3.org/ns/prov#Agent", status + "Agent"], repo(planPath), { authority: "SECONDARY_AI", ratification: "NOT_CLAIMED" })
for (const req of plan.requirements) add(req.id, [status + "Requirement"], repo(planPath), { ...req })
for (const ref of plan.references) add(ref.id, [status + "Source", status + "ExternalSource"], ref.url, { ...ref })
for (const source of plan.currentSources) add(source.id, [status + "Source", status + "Artifact"], `git://github.com/gj3447/USL@${source.sourceCommit}:${source.path}`, { ...source, remoteObservation: "NOT_PERFORMED" })
for (const milestone of plan.milestones) add(milestone.id, [status + "Milestone"], repo(planPath), { ...milestone })
const plannedPaths = [...new Set(plan.tasks.flatMap(t => t.plannedOutputs))]
for (const path of plannedPaths) add(`planned:${path}`, [status + "PlannedArtifact"], repo(planPath) + `#planned-${encodeURIComponent(path)}`, { proposedPath: path, implementation: "NOT_STARTED", existence: "NOT_CLAIMED", locatorRole: "PROPOSAL_DESCRIPTION_ONLY" })
for (const task of plan.tasks) {
  add(task.id, [status + "Task"], repo(planPath), { title: task.title, phase: task.phase, owner: task.owner, status: task.status, implementation: task.implementation, proofStatus: task.proofStatus, currentGap: task.currentGap })
  task.dependsOn.forEach(prerequisite => link("depends_on", { task: task.id, prerequisite }))
  task.requirements.forEach(requirement => link("addresses", { task: task.id, requirement }))
  task.plannedOutputs.forEach(path => link("planned_output", { task: task.id, artifact: `planned:${path}` }))
  task.reuses.forEach(source => link("reuses", { task: task.id, source }))
  task.informedBy.forEach(source => link("informed_by", { task: task.id, source }))
  link("scheduled_in", { task: task.id, milestone: `milestone:${task.phase}` })
  for (const criterion of task.acceptance) { add(criterion.id, [status + "AcceptanceCriterion"], repo(planPath), { ...criterion }); link("acceptance_for", { task: task.id, requirement: criterion.requirement, criterion: criterion.id }) }
}
const rawGraph = json(graph)
Either.getOrThrowWith(adaptResourceGraph(rawGraph, { namespace: "usl.portability.plan", profile }), error => new Error(JSON.stringify(error)))
const graphJsonLd = Either.getOrThrowWith(resourceGraphJsonLd(rawGraph, { namespace: "usl.portability.plan", profile }), error => new Error(JSON.stringify(error)))
const ref = (id: string) => ({ "@id": id })
const trace = { "@context": { p }, "@graph": [
  ...plan.requirements.map(r => ({ "@id": r.id, "@type": "p:Requirement", "p:authority": r.authority })),
  ...plan.milestones.map(m => ({ "@id": m.id, "@type": "p:Milestone", "p:status": m.status })),
  ...plannedPaths.map(path => ({ "@id": `planned:${path}`, "@type": "p:PlannedArtifact", "p:implementation": "NOT_STARTED" })),
  ...plan.tasks.flatMap(t => [{ "@id": t.id, "@type": "p:Task", "p:status": t.status, "p:implementation": t.implementation, "p:proofStatus": t.proofStatus,
    "p:dependsOn": t.dependsOn.map(ref), "p:addresses": t.requirements.map(ref), "p:acceptance": t.acceptance.map(c => ref(c.id)),
    "p:plannedOutput": t.plannedOutputs.map(path => ref(`planned:${path}`)), "p:milestone": ref(`milestone:${t.phase}`) },
    ...t.acceptance.map(c => ({ "@id": c.id, "@type": "p:AcceptanceCriterion", "p:forTask": ref(t.id), "p:forRequirement": ref(c.requirement),
      "p:execution": c.execution, "p:expectation": c.expectation, "p:negativeCase": c.negativeCase }))]),
] }

const short = (id: string) => id.split(":").at(-1)!
const doc = [
  "# USL 기기 이동과 백업 복원 작업 계획", "",
  "다른 컴퓨터와 경로에서 메모리·작업환경을 복원해도 같은 자원과 고정 버전의 연결을 확인하는 작업 계획이다. 먼저 명시한 범위를 검증하고 재바인딩하는 MVP를 만들고, 메모리 조각 재탐색·동시 수정 병합·외부 작업 상태 대조를 후속 단계로 둔다.", "",
  "이 문서는 **최초 계획의 고정 snapshot**이다. 아래 상태는 계획 수립 시점의 `PLANNED / NOT_STARTED / NOT_RUN`을 보존한다. 이후 구현·검증은 [PT01 계약 진행 기록](PORTABLE_TRANSFER.md)과 별도 검증 영수증에서 확인한다. 이 계획 그래프의 검증 범위는 출처 pin·의존성·구조다. 기존 USL 코어의 자원·의미·역할·바인딩 문법을 유지하고 별도 선택형 계약과 CLI 소비 프로그램으로 확장한다.", "",
  `사용자 요청: “${plan.userRequest.text}”`, "",
  "사용자 원문과 AI의 구현 해석은 [기계 판독 계획](../research/portability-plan/plan.json)에 구분했다. 기존의 코어/애드온 경계는 [앞선 작업 계획](../research/architecture/hswm-like.plan.json)을 따른다.", "",
  "## 현재 기반과 추가할 범위", "",
  "현재 [portable bindings](RESOURCE_BINDINGS.md)는 자원 ID와 위치를 분리하고 workspace root 변경을 처리한다. [실행 기록 계약](BINDING_OPERATIONS.md)은 같은 로컬 저장소의 중복 호출을 차단한다. 복원 manifest·다중 기기 revision 병합·분산 외부 효과 보장은 추가 설계가 필요하다. 기준 소스 commit과 파일별 해시는 plan.json에 고정했다.", "",
  "## 구현 순서", "", plan.ordering, "",
  "```mermaid", "flowchart LR", "  PT01[PT01 ID와 버전 계약] --> PT02[PT02 snapshot과 manifest]", "  PT02 --> PT03[PT03 검증과 새 환경 복원]", "  PT03 --> PT04[PT04 MVP 인수검사]", "  PT04 --> PT05[PT05 조각과 그래프 정규화]", "  PT04 --> PT06[PT06 수정과 삭제 병합]", "  PT06 --> PT07[PT07 외부 작업 상태 대조]", "```", "",
  "| 작업 | 범위 | 선행 작업 | 완료 판단 |", "|---|---|---|---|",
  ...plan.tasks.map(t => `| ${short(t.id)} ${t.title} | ${t.phase} | ${t.dependsOn.map(short).join(", ") || "없음"} | 아래 인수기준 ${t.acceptance.length}개와 반례를 실제 실행 |`), "",
  "첫 릴리스는 PT01–PT04다. MVP는 새 복원 목적지를 사용하며 기존 환경과 자동 병합하지 않는다. 현재 owner head·철회 상태를 확인할 수 없는 offline 복원은 역사 snapshot으로 읽거나 선택한 revision에서 새 로컬 작업 분기를 시작할 수 있다. 이때 전역 최신성은 미확정으로 유지한다. 복원 자체는 외부 실행을 호출하지 않는다.", "",
  "## 작업별 산출물과 인수기준", "",
  ...plan.tasks.flatMap(t => [
    `### ${short(t.id)} ${t.title}`, "", t.currentGap, "",
    `예정 산출물: ${t.plannedOutputs.map(path => `\`${path}\``).join(", ")}. 이 경로는 향후 구현 위치 제안이며 생성 완료를 뜻하지 않는다.`, "",
    ...t.acceptance.flatMap(c => [`- **${short(c.id)}:** ${c.expectation}`, `  반례: ${c.negativeCase}`]), "",
    `참고: ${t.informedBy.map(id => { const r = plan.references.find(r => r.id === id)!; return `[${r.title}](${r.url})` }).join(", ")}.`, "",
  ]),
  "## 제안한 자원 모델", "",
  `다음은 \`${plan.draftDomainContract.namespace}\` 아래에 PT01에서 구체화할 로컬 모델이다. 상태는 \`${plan.draftDomainContract.status}\`이며 공유 KG나 표준 어휘에 등록한 것이 아니다.`, "",
  "| 관계 | 방향과 domain → range | Cardinality | 의미 |", "|---|---|---|---|",
  ...plan.draftDomainContract.predicates.map(r => `| \`${r.name}\` | ${r.domain} → ${r.range} | ${r.cardinality} | ${r.meaning} |`), "",
  ...plan.draftDomainContract.typeConstraints.map(value => `- ${value}`), "",
  "이동한 표현을 관측하는 것, 원문이 일치하는 것, 현재 버전인 것, 접근 권한이 있는 것, 외부 효과가 발생한 것은 별도 상태다. `VERIFIED`만으로 최신·허가·실행 완료 상태를 얻지 않는다.", "",
  ...Object.entries(plan.stateDimensions).map(([dimension, values]) => `- ${dimension}: ${values.map(v => `\`${v}\``).join(", ")}`), "",
  "## 계획 그래프와 검증", "",
  "[USL 그래프](../research/portability-plan/graph.json), [JSON-LD](../research/portability-plan/graph.jsonld), [역할 profile](../research/portability-plan/profile.json), [typed RDF](../research/portability-plan/trace.jsonld)를 함께 제공한다. 각 관계의 필수 역할은 정확히 한 개씩이고 추가 역할을 허용하지 않는다.", "",
  "| 계획 관계 | 역할과 타입 |", "|---|---|",
  ...definitions.map(d => `| \`${d.name}\` | ${Object.entries(d.roles).map(([role, type]) => `${role}: ${type}`).join(", ")} |`), "",
  "의존성은 task → prerequisite 방향이며 이 관계만 DAG로 검사한다. 예정 산출물은 `PlannedArtifact`, 인수기준은 `AcceptanceCriterion/NOT_RUN`으로 표현한다. 실제 소스는 고정 Git revision과 bytes digest를 갖고, 계획 입력·생성 활동·작성 주체는 PROV-O로 연결한다.", "",
  "계획 검사는 정확한 MVP 작업 집합, task dependency, requirement→task→criterion 경로, 예정 output과 기존 소스의 구별을 확인한다. 완료 상태로의 임의 승격·누락된 pin·잘못된 역할·dependency cycle을 반례로 거부한다. SHACL 2017과 SPARQL은 계획 그래프를 검사하며 미구현 복원 기능의 실행 성공을 증명하지 않는다.", "",
  "```sh", "node --import tsx scripts/build-portability-plan.ts --check", "python3 scripts/validate-portability-plan.py", "python3 scripts/check-docs.py", "```", "",
  "Python 검증 의존성은 기존 `scripts/requirements-standards.txt`를 사용한다. 계획 수정 후 빌더를 `--check` 없이 실행하면 문서와 그래프를 함께 재생성한다.", "",
  "## 표준 적용과 남은 선택", "",
  "아래 자료는 조사한 설계 근거다. W3C Recommendation, IETF Standards Track, Informational RFC, 커뮤니티 명세, 도구 문서를 구분하며 BagIt·OCFL 등을 참조했다는 이유만으로 구현 준수를 주장하지 않는다.", "",
  ...plan.references.flatMap(r => [`- [${r.title}](${r.url}) — ${r.publicationStatus}, 확인 ${r.checkedOn}. ${r.application} ${r.limit}`]), "",
  ...plan.openDecisions.map(d => `- **${d.topic}:** ${d.default}`), "",
].join("\n")
const outputs = { [`${folder}/profile.json`]: json(profile), [`${folder}/graph.json`]: rawGraph, [`${folder}/graph.jsonld`]: json(graphJsonLd), [`${folder}/trace.jsonld`]: json(trace), "docs/PORTABILITY_PLAN.md": doc }
for (const [path, content] of Object.entries(outputs)) {
  if (check) { if (await read(path) !== content) throw new Error(`portability plan artifact differs: ${path}`) }
  else { await mkdir(dirname(resolve(root, path)), { recursive: true }); await writeFile(resolve(root, path), content) }
}
console.log(json({ mode: check ? "PLAN_ARTIFACTS_CHECKED" : "PLAN_ARTIFACTS_BUILT", tasks: plan.tasks.length, criteria: plan.tasks.reduce((n, t) => n + t.acceptance.length, 0), resources: graph.resources.length, links: graph.links.length, runtimeImplementation: "NOT_STARTED", runtimeTests: "NOT_RUN" }))
