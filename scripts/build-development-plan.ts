/** Build the integrated planning snapshot; never execute its future tasks. */
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Either } from "effect"
import { digestSource } from "../src/language/digest.js"
import { parseDomainProfile } from "../src/domain-profile.js"
import { adaptResourceGraph, resourceGraphJsonLd, type ResourceGraph } from "../src/integrations/resource-graph.js"

type Entity = { id: string } & Record<string, unknown>
type Source = Entity & { path: string; sha256: string; sourceCommit: string; kind: string }
type Statement = Entity & { authority: string; text: string }
type Requirement = Entity & { text: string; authority: string; sourceIds: string[]; userStatementIds: string[] }
type Baseline = Entity & { title: string; status: string; scope: string; remaining: string; sourceIds: string[] }
type Evidence = Entity & { title: string; kind: string; sourceId: string; sourceRecordId: string; interpretation: string; replayed: boolean }
type Task = Entity & { title: string; owner: string; priority: string; phase: string; status: string; implementation: string; scope: string; remaining: string; dependsOn: string[]; restoredEvidenceDependsOn?: string[]; requirementIds: string[]; baselineIds: string[]; evidenceIds: string[]; sourceIds: string[]; criterionIds: string[]; plannedOutputs: string[] }
type Criterion = Entity & { taskId: string; expectation: string; negativeCase: string; execution: string }
type Milestone = Entity & { title: string; taskIds: string[]; gate: string; status: string }
type Plan = { schema: string; id: string; authority: string; status: string; recordedOn: string; sourceCommit: string; firstTask: string; sources: Source[]; userStatements: Statement[]; requirements: Requirement[]; baselines: Baseline[]; evidence: Evidence[]; tasks: Task[]; criteria: Criterion[]; milestones: Milestone[]; competencyQuestions: string[]; decisions: string[] }

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), folder = "research/development-plan", inputPath = `${folder}/plan.json`
if (process.argv.slice(2).some(arg => arg !== "--check")) throw new Error("usage: build-development-plan.ts [--check]")
const check = process.argv.includes("--check")
const read = (path: string) => readFile(resolve(root, path), "utf8")
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"
const must: (value: unknown, message: string) => asserts value = (value, message) => { if (!value) throw new Error(message) }
const raw = await read(inputPath), data = JSON.parse(raw) as Plan
must(data.schema === "usl-development-plan/v1" && data.authority === "SECONDARY_AI" && data.status === "PLANNED", "invalid plan header")
const groups: [string, Entity[]][] = [["Source", data.sources], ["UserStatement", data.userStatements], ["Requirement", data.requirements], ["Baseline", data.baselines], ["Evidence", data.evidence], ["Task", data.tasks], ["Criterion", data.criteria], ["Milestone", data.milestones]]
const ids = groups.flatMap(([, entities]) => entities.map(entity => entity.id))
must(new Set(ids).size === ids.length, "duplicate plan ID")
for (const source of data.sources) {
  // This is the original planning snapshot. Later execution receipts can change
  // at the same path without rewriting the evidence that informed this plan.
  must(source.sourceCommit === data.sourceCommit, `plan source revision differs: ${source.path}`)
  must(digestSource(execFileSync("git", ["show", `${source.sourceCommit}:${source.path}`], { cwd: root, encoding: "utf8" })) === source.sha256, `historical source drift: ${source.path}`)
}
const seen = new Set<string>(), active = new Set<string>()
const visit = (id: string) => {
  must(!active.has(id), "task dependency cycle"); if (seen.has(id)) return
  const task = data.tasks.find(t => t.id === id); must(task, `unknown task ${id}`)
  must(task.status === "PLANNED" && task.implementation === "NOT_STARTED", "future task promoted")
  active.add(id); [...task.dependsOn, ...task.restoredEvidenceDependsOn ?? []].forEach(visit); active.delete(id); seen.add(id)
}
data.tasks.forEach(t => visit(t.id))
const first = data.tasks.find(t => t.id === data.firstTask); must(first && first.dependsOn.length === 0, "first task has unresolved prerequisites")
data.criteria.forEach(c => must(c.execution === "NOT_RUN", "future acceptance promoted"))

const d = "urn:usl:development-plan:", prov = "http://www.w3.org/ns/prov#"
type Definition = { name: string; predicate: string; roles: Record<string, string>; meaning: string }
const definitions: Definition[] = [
  { name: "depends_on", predicate: "dependsOn", roles: { task: "Task", prerequisite: "Task" }, meaning: "Future task requires prerequisite in this planning snapshot; these edges alone form a DAG" },
  { name: "requires_reconciliation", predicate: "requiresReconciliation", roles: { task: "Task", prerequisite: "Task" }, meaning: "Conditional prerequisite only when this task consumes restored outcomes or receipts; combined dependency graph must also be acyclic" },
  { name: "addresses", predicate: "addresses", roles: { task: "Task", requirement: "Requirement" }, meaning: "Proposed task addresses the derived requirement; not proof of satisfaction" },
  { name: "builds_on", predicate: "buildsOn", roles: { task: "Task", baseline: "Baseline" }, meaning: "Task reuses an existing implementation within its recorded limits" },
  { name: "motivated_by", predicate: "motivatedBy", roles: { task: "Task", evidence: "Evidence" }, meaning: "Historical observation, assessment or backlog motivates future work" },
  { name: "uses_source", predicate: "usesSource", roles: { task: "Task", source: "Source" }, meaning: "Task derives from this pinned source snapshot" },
  { name: "validated_by", predicate: "validatedBy", roles: { task: "Task", criterion: "Criterion" }, meaning: "Future acceptance requirement with NOT_RUN execution" },
  { name: "for_task", predicate: "forTask", roles: { criterion: "Criterion", task: "Task" }, meaning: "Criterion belongs to exactly one task in this snapshot" },
  { name: "recorded_in", predicate: "recordedIn", roles: { evidence: "Evidence", source: "Source" }, meaning: "Evidence points to a pinned historical source; this build does not replay it" },
  { name: "requirement_derived_from", predicate: "derivedFrom", roles: { requirement: "Requirement", source: "Source" }, meaning: "AI requirement interpretation is grounded in the source" },
  { name: "baseline_derived_from", predicate: "derivedFrom", roles: { baseline: "Baseline", source: "Source" }, meaning: "Bounded implementation state is grounded in the source" },
  { name: "interprets", predicate: "interprets", roles: { requirement: "Requirement", statement: "UserStatement" }, meaning: "AI interpretation of primary user words; never user canon by inference" },
  { name: "includes", predicate: "includes", roles: { milestone: "Milestone", task: "Task" }, meaning: "Milestone groups tasks; its gate does not grant authority" },
]
const profile = parseDomainProfile({ schema: "usl-domain-profile/v1", id: d + "profile", version: "1", closedMeanings: true, meanings: definitions.map(x => ({ id: d + x.name, allowExtraRoles: false, roles: Object.entries(x.roles).map(([role, type]) => ({ role, required: true, types: [d + type], metadata: [] })) })) })
const graph: ResourceGraph = { schema: "usl-resource-graph/v1", resources: [], meanings: definitions.map(x => ({ id: d + x.name, description: x.meaning })), links: [], provenance: { sources: ["input:development-plan", "input:development-builder", ...data.userStatements.map(x => x.id)], activity: "activity:development-plan", agent: "agent:development-plan" } }
const repo = (path: string) => `https://github.com/gj3447/USL/blob/master/${path}`
type Metadata = NonNullable<ResourceGraph["resources"][number]["metadata"]>
const add = (id: string, type: string, metadata: object, locator = repo(inputPath), provType = "Entity") => graph.resources.push({ id, types: [d + type, prov + provType], locator, metadata: metadata as Metadata })
add("input:development-plan", "Input", { path: inputPath, sha256: digestSource(raw) })
add("input:development-builder", "Input", { path: "scripts/build-development-plan.ts", sha256: digestSource(await read("scripts/build-development-plan.ts")) }, repo("scripts/build-development-plan.ts"))
add("activity:development-plan", "PlanActivity", { recordedOn: data.recordedOn, runtimeAcceptance: "NOT_RUN" }, repo(inputPath), "Activity")
add("agent:development-plan", "PlanAgent", { authority: "SECONDARY_AI" }, repo(inputPath), "Agent")
add(data.id, "Plan", { authority: data.authority, status: data.status, sourceCommit: data.sourceCommit, firstTask: data.firstTask })
for (const [type, entities] of groups) for (const entity of entities) {
  const locator = type === "Source" ? `git://github.com/gj3447/USL@${String(entity.sourceCommit)}:${String(entity.path)}` : repo(inputPath)
  add(entity.id, type, entity, locator)
}
const edges: { predicate: string; from: string; to: string }[] = []
const link = (name: string, participants: Record<string, string>) => {
  const definition = definitions.find(x => x.name === name); must(definition, "unknown relation")
  const [from, to] = Object.values(participants); must(from && to, "missing endpoint")
  edges.push({ predicate: definition.predicate, from, to })
  graph.links.push({ id: `development-link:${graph.links.length}`, meaning: d + name, participants: Object.entries(participants).map(([role, resource]) => ({ role, resource })), metadata: { authority: "SECONDARY_AI", status: "PLANNING_RELATION" } })
}
for (const task of data.tasks) {
  task.dependsOn.forEach(prerequisite => link("depends_on", { task: task.id, prerequisite }))
  task.restoredEvidenceDependsOn?.forEach(prerequisite => link("requires_reconciliation", { task: task.id, prerequisite }))
  task.requirementIds.forEach(requirement => link("addresses", { task: task.id, requirement }))
  task.baselineIds.forEach(baseline => link("builds_on", { task: task.id, baseline }))
  task.evidenceIds.forEach(evidence => link("motivated_by", { task: task.id, evidence }))
  task.sourceIds.forEach(source => link("uses_source", { task: task.id, source }))
  task.criterionIds.forEach(criterion => link("validated_by", { task: task.id, criterion }))
}
data.criteria.forEach(c => link("for_task", { criterion: c.id, task: c.taskId }))
data.evidence.forEach(e => link("recorded_in", { evidence: e.id, source: e.sourceId }))
data.requirements.forEach(r => {
  r.sourceIds.forEach(source => link("requirement_derived_from", { requirement: r.id, source }))
  r.userStatementIds.forEach(statement => link("interprets", { requirement: r.id, statement }))
})
data.baselines.forEach(b => b.sourceIds.forEach(source => link("baseline_derived_from", { baseline: b.id, source })))
data.milestones.forEach(m => m.taskIds.forEach(task => link("includes", { milestone: m.id, task })))
const graphRaw = json(graph), options = { namespace: "usl.development.plan", profile }
Either.getOrThrowWith(adaptResourceGraph(graphRaw, options), error => new Error(JSON.stringify(error)))
const graphLd = Either.getOrThrowWith(resourceGraphJsonLd(graphRaw, options), error => new Error(JSON.stringify(error)))
const ref = (id: string) => ({ "@id": id })
const traceNode = (type: string, entity: Entity) => ({ "@id": entity.id, "@type": [`d:${type}`, "prov:Entity"], ...Object.fromEntries(Object.entries(entity).filter(([key, value]) => !["id", "sourceId", "taskId"].includes(key) && ["string", "number", "boolean"].includes(typeof value)).map(([key, value]) => [`d:${key}`, value])) })
const trace = { "@context": { d, prov }, "@graph": [
  traceNode("Plan", { id: data.id, status: data.status, authority: data.authority, recordedOn: data.recordedOn, sourceCommit: data.sourceCommit }),
  ...groups.flatMap(([type, entities]) => entities.map(entity => ({ ...traceNode(type, entity), ...(type === "UserStatement" || type === "Source" ? {} : { "prov:wasAttributedTo": ref("agent:development-plan"), "prov:wasGeneratedBy": ref("activity:development-plan") }), ...("sourceIds" in entity ? { "prov:wasDerivedFrom": (entity.sourceIds as string[]).map(ref) } : {}) }))),
  { "@id": data.id, "d:firstTask": ref(data.firstTask), "prov:wasGeneratedBy": ref("activity:development-plan") },
  { "@id": "agent:development-plan", "@type": "prov:Agent", "d:authority": "SECONDARY_AI" },
  { "@id": "activity:development-plan", "@type": "prov:Activity", "d:recordedOn": data.recordedOn, "prov:used": [...data.userStatements, ...data.sources].map(x => ref(x.id)) },
  ...edges.map(edge => ({ "@id": edge.from, [`d:${edge.predicate}`]: ref(edge.to) })),
] }
const short = (id: string) => id.slice(id.indexOf(":") + 1), cell = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ")
const taskList = (ids: string[]) => ids.map(short).join(", ") || "없음"
const ready = data.tasks.filter(t => t.dependsOn.length === 0)
const sourceLink = (id: string) => { const source = data.sources.find(x => x.id === id); must(source, "missing source"); return `[${source.path}](../${source.path})` }
const lockOutputs: [string, string][] = [[`${folder}/graph.jsonld`, json(graphLd)], [`${folder}/trace.jsonld`, json(trace)]]
const lockRows = lockOutputs.map(([path, value]) => `| \`${path}\` | \`${digestSource(value)}\` | ${Buffer.byteLength(value)} |`)
const document = [
  "# USL 통합 개발 계획", "",
  "이 문서는 원래 계획 스냅샷이다. 이후 구현 상태와 실제 실행 결과는 [개발 진행](DEVELOPMENT_PROGRESS.md)에서 확인한다.", "",
  `이 계획은 **기기·메모리·작업환경 이동과 Git worktree 분기에도 의미 있는 연결을 보존하는 USL**을 개발하기 위한 통합 작업 그래프다. ${data.recordedOn} 기준 **요구사항 ${data.requirements.length}개 · 후속 과제 ${data.tasks.length}개 · 완료 조건 ${data.criteria.length}개 · milestone ${data.milestones.length}개**로 구성한다.`, "",
  "첫 구현은 **DG01: 선택형 checkout·worktree·revision guard**다. 잘못된 worktree 또는 HEAD를 선택했는데 파일 bytes만 같아서 일치로 보이는 경계를 먼저 막고, PT02 실제 snapshot/export → PT03 staging restore → PT04 환경별 검증으로 이어 간다.", "",
  `이 문서는 SECONDARY_AI의 구현 제안이다. 현재 모든 후속 과제는 **PLANNED / NOT_STARTED**, 미래 완료 조건은 **NOT_RUN**이다. 그래프 생성·검증 성공은 해당 기능의 구현 완료가 아니다. 근거 snapshot은 Git \`${data.sourceCommit}\`과 파일별 SHA-256으로 고정한다. 과거 실행 근거 ${data.evidence.filter(e => e.kind.includes("EXECUTION")).length}건을 포함한 근거 ${data.evidence.length}개를 참조하며 이번 계획 생성에서 재실행하지 않았다.`, "",
  "## 개발 원칙과 범위", "",
  ...data.decisions.map(value => `- ${value}`), "",
  "고정 resource ID·revision·representation·현재 위치를 분리한다. 기본 core는 resource·meaning·이름 있는 role에 집중하고, 복원·표준 교환·W 평가 알고리즘은 선택형 consumer 또는 owner 프로그램에 둔다. 링크·출처·plan·receipt는 접근 권한을 부여하지 않는다. private registration과 credential은 로컬에 남긴다.", "",
  "‘표준 그래프 엔지니어링으로 계획을 구축했다’는 뜻은 typed relation·role/cardinality·provenance·검증 가능한 제약·질의·실패 반례를 갖췄다는 것이다. USL이 RDF/OWL/SHACL/SPARQL/GQL 전체를 구현했거나 표준 기관의 인증을 받았다는 뜻은 아니다. 기존 [지원 범위 감사](STANDARDS_COVERAGE.md)의 NOT_A_STANDARDS_SUPERSET 판정을 유지한다.", "",
  "## 이미 있는 기반", "",
  "| ID | 재사용할 구현 | 남은 경계 |", "|---|---|---|",
  ...data.baselines.map(b => `| ${short(b.id)} | ${cell(b.scope)} | ${cell(b.remaining)} |`), "",
  "PT01의 최초 PLANNED 기록과 후속 CONTRACT_IMPLEMENTED receipt는 서로 다른 시점의 기록이다. 원래 문서를 덮어쓰지 않고 후속 영수증으로 제한된 현재 기반을 표현한다. PT01은 실제 전송·복원 완료가 아니다. W도 offline learner 실행과 review bridge는 존재하지만 운영 효과와 live 적용은 별도다.", "",
  "## 요구사항 추적", "",
  "사용자 원문은 USER_PRIMARY, 다음 요구사항과 작업 배치는 SECONDARY_AI로 분리한다. 원문은 기계 판독 입력의 userStatements에 그대로 보존한다.", "",
  "| 요구사항 | 해석 | 담당 과제 |", "|---|---|---|",
  ...data.requirements.map(r => `| ${short(r.id)} | ${cell(r.text)} | ${taskList(data.tasks.filter(t => t.requirementIds.includes(r.id)).map(t => t.id))} |`), "",
  "## 의존 순서와 병렬 작업", "",
  `무조건 선행 과제가 없어 먼저 착수 가능한 작업은 **${taskList(ready.map(t => t.id))}**다. 우선 선택한 과제는 ${short(data.firstTask)}이다. 이는 일정상 선행 조건이며 외부 실행 승인이나 배포 권한이 아니다. DG02 표준 교환 계약과 C02–C04 CLI 및 새 owner 데이터의 DG04 검토는 이동성 작업과 병렬로 진행할 수 있다.`, "",
  "```mermaid", "flowchart TD",
  ...data.tasks.map(t => `  ${short(t.id)}["${short(t.id)} ${t.title}"]`),
  ...data.tasks.flatMap(t => t.dependsOn.map(prerequisite => `  ${short(prerequisite)} --> ${short(t.id)}`)),
  ...data.tasks.flatMap(t => (t.restoredEvidenceDependsOn ?? []).map(prerequisite => `  ${short(prerequisite)} -. 복원 데이터 사용 시 .-> ${short(t.id)}`)), "```", "",
  "그림의 화살표는 선행 → 후속이다. 저장된 dependsOn 관계는 후속 task → prerequisite 방향이다. 이미 있는 기반은 buildsOn으로 연결한다. DG04는 복원된 outcome/receipt를 사용하는 profile에만 PT07 선행을 요구하며 requiresReconciliation으로 별도 표현한다. 기본 의존 DAG와 조건부 의존을 합한 DAG 모두 순환이 없어야 한다. 기존 offline review와 새 owner 데이터 검토는 이 조건에 막히지 않는다.", "",
  "| 과제 | 우선순위 · 단계 | 선행 과제 | 완료 조건 수 |", "|---|---|---|---|",
  ...data.tasks.map(t => `| ${short(t.id)} ${cell(t.title)} | ${t.priority} · ${t.phase} | ${taskList(t.dependsOn)}${t.restoredEvidenceDependsOn ? `; 복원 데이터: ${taskList(t.restoredEvidenceDependsOn)}` : ""} | ${t.criterionIds.length} |`), "",
  "## 단계별 완료 판정", "",
  ...data.milestones.flatMap(m => [`### ${short(m.id)} · ${m.title}`, "", `과제: ${taskList(m.taskIds)}. 상태: ${m.status}.`, "", m.gate, ""]),
  "portable MVP(M2), 선택한 표준 상호운용(M4), 전체 선택 기능을 연결한 검증(DG05)을 구분한다. 한 기능의 미완료를 감추지 않으면서 기본 바인딩과 준비된 선택 기능을 각각 제공할 수 있다.", "",
  "## 과제별 구현 범위와 인수 조건", "",
  "아래 경로는 계획한 산출물이다. 파일이 이미 존재하면 그 범위의 수정이며, 미존재 경로는 아직 생성한 구현이 아니다. 모든 인수 조건의 실행 상태는 NOT_RUN이다.", "",
  ...data.tasks.flatMap(t => [
    `### ${short(t.id)} · ${t.title}`, "", t.scope, "", `남은 문제: ${t.remaining}`, "",
    `담당 경계: ${t.owner}. 기존 기반: ${taskList(t.baselineIds)}. 선행: ${taskList(t.dependsOn)}.${t.restoredEvidenceDependsOn ? ` 복원 데이터 사용 시 선행: ${taskList(t.restoredEvidenceDependsOn)}.` : ""}`, "",
    `계획 산출물: ${t.plannedOutputs.map(path => `\`${path}\``).join(", ")}.`, "",
    ...t.criterionIds.flatMap(id => { const c = data.criteria.find(x => x.id === id); must(c, "missing criterion"); return [`- **${short(c.id)} · ${c.execution}:** ${c.expectation} **실패 반례:** ${c.negativeCase}`] }), "",
    `근거 기록: ${t.evidenceIds.map(id => { const e = data.evidence.find(x => x.id === id); must(e, "missing evidence"); return `\`${e.sourceRecordId}\`` }).join(", ")}.`, "",
    `고정 원문: ${t.sourceIds.map(sourceLink).join(", ")}.`, "",
  ]),
  "## 근거와 실패 사례의 연결", "",
  "Worktree 감사의 PASS에는 현재 한계를 재현한 검사가 포함된다. 표준 coverage는 bounded probe/정적 검토이며 전체 적합성 suite가 아니다. 이동성 연구는 설계 근거, W learner 실행은 합성 offline 근거다. 각 원문 기록을 그 범위대로 참조한다.", "",
  "| 근거 기록 | 유형 | 연결된 과제 |", "|---|---|---|",
  ...data.evidence.map(e => `| ${cell(e.sourceRecordId)} | ${e.kind} | ${taskList(data.tasks.filter(t => t.evidenceIds.includes(e.id)).map(t => t.id))} |`), "",
  "기존 40개 technology와 12개 control의 전체 항목은 [engineering catalog](../research/engineering/catalog.json) 및 [표준 감사 입력](../research/standards-coverage/coverage.json)에 보존한다. 이번 계획은 22개 표준 평가 모두를 작업에 연결하고 DG05에서 원래 catalog까지 지원·위임·미지원 판정을 대조하도록 한다. 모든 기술을 구현하겠다는 일괄 약속으로 바꾸지 않는다. 표준의 최신 상태를 이번에 다시 검색한 문서는 아니며 구현 시 선택 edition과 source revision을 재확인한다.", "",
  "## 그래프 계약과 재현", "",
  "[계획 입력](../research/development-plan/plan.json) → [USL graph](../research/development-plan/graph.json) / JSON-LD 선언 `research/development-plan/graph.jsonld` / typed RDF trace `research/development-plan/trace.jsonld` / [role profile](../research/development-plan/profile.json) / 이 문서를 같은 builder에서 생성한다. RDF trace는 계획의 관계를 명시한 별도 projection이며, 임의 RDF 입력의 무손실 수입 기능이 아니다.", "",
  "| USL 의미 / RDF predicate | domain → range | 의미 |", "|---|---|---|",
  ...definitions.map(x => `| ${x.name} / ${x.predicate} | ${Object.values(x.roles).join(" → ")} | ${x.meaning} |`), "",
  "각 link는 profile에 지정한 역할을 정확히 하나씩 가진다. Task는 requirement·baseline·evidence·source·criterion을 하나 이상 참조한다. Criterion은 task 하나에 귀속되고 Task의 validatedBy와 역방향으로 일치한다. Requirement는 사용자 원문과 고정 source를 각각 하나 이상 참조한다. 모든 요구사항과 미래 과제는 작업/milestone에 연결된다.", "",
  ...data.competencyQuestions.map(q => `- ${q}`), "",
  "[SHACL](../schemas/development-plan/plan.shacl.ttl)과 [독립 validator](../scripts/validate-development-plan.py)는 실제 RDF parsing, typed 관계의 정확한 endpoint 집합, 상태·provenance·source pins·DAG·원래 인수 조건 보존을 확인한다. source pin은 계획 당시 고정 Git revision의 실제 bytes와 비교한다. 이후 같은 경로에 새 실행 영수증이 기록되어도 원래 계획의 근거와 미래 상태를 소급 변경하지 않는다. 현재 구현 진행과 새 실행 결과는 별도 진행 기록에서 검증한다. 근거 제거·잘못된 타입/역할·순환·고아 criterion·미래 PASS/완료 승격 등의 변조는 거부해야 한다. 이 검증은 계획의 구조적 적합성이며 미래 runtime 인수검사나 형식 증명은 아니다.", "",
  "```sh", "node --import tsx scripts/build-development-plan.ts", "node --import tsx scripts/build-development-plan.ts --check", "python3 scripts/validate-development-plan.py", "```", "",
  "Python validator는 저장소 scripts/requirements-standards.txt의 rdflib/pyshacl을 사용한다. CI에서 생성물 일치·TypeScript 검사·독립 검증을 반복한다.", "",
  "| 고정 source | SHA-256 |", "|---|---|", ...data.sources.map(source => `| [${source.path}](../${source.path}) | \`${source.sha256}\` |`), "",
  "두 JSON-LD 파일은 입력에서 재생성되는 산출물이라 Git에 넣지 않는다. `node --import tsx scripts/build-development-plan.ts`로 생성하며, `--check`는 메모리에서 다시 만든 bytes의 SHA-256을 아래 lock과 비교한다(파일이 있으면 bytes도 비교).", "",
  "| 재생성 산출물 (Git 제외) | SHA-256 | bytes |", "|---|---|---|", ...lockRows, "",
].join("\n")
const docPath = "docs/DEVELOPMENT_PLAN.md"
const outputs: Record<string, string> = { [`${folder}/profile.json`]: json(profile), [`${folder}/graph.json`]: graphRaw, ...Object.fromEntries(lockOutputs), [docPath]: document }
// JSON-LD outputs are not committed; their digest lock lives in the committed generated document.
const locked = new Set(lockOutputs.map(([path]) => path)), committedDoc = check ? await read(docPath) : "", hydration: Record<string, string> = {}
for (const [path, content] of Object.entries(outputs)) {
  if (check && locked.has(path)) {
    const row = committedDoc.split("\n").find(line => line.startsWith(`| \`${path}\` |`))
    must(row?.includes(`\`${digestSource(content)}\``), `development artifact differs from digest lock: ${path}`)
    if (existsSync(resolve(root, path))) { must(await read(path) === content, `development artifact differs: ${path}`); hydration[path] = "BYTES_MATCH" }
    else hydration[path] = "NOT_HYDRATED"
  }
  else if (check) must(await read(path) === content, `development artifact differs: ${path}`)
  else { await mkdir(dirname(resolve(root, path)), { recursive: true }); await writeFile(resolve(root, path), content) }
}
console.log(json({ mode: check ? "PLAN_ARTIFACTS_CHECKED" : "PLAN_ARTIFACTS_BUILT", requirements: data.requirements.length, tasks: data.tasks.length, criteria: data.criteria.length, resources: graph.resources.length, links: graph.links.length, firstTask: data.firstTask, futureAcceptance: "NOT_RUN", ...(check ? { hydration } : {}) }))
