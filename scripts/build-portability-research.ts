/** Build a sourced research graph; only bounded parser probes execute. */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Either } from "effect"
import { digestSource } from "../src/language/digest.js"
import { parseDomainProfile } from "../src/domain-profile.js"
import { adaptResourceGraph, resourceGraphJsonLd, type ResourceGraph } from "../src/integrations/resource-graph.js"
import { runPortabilityResearchProbes, type PortabilityResearchProbe } from "./probe-portability-research.js"

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), check = process.argv.includes("--check")
if (process.argv.slice(2).some(arg => arg !== "--check")) throw new Error("usage: build-portability-research.ts [--check]")
const read = (path: string) => readFile(resolve(root, path), "utf8")
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"
const folder = "research/portability-research", inputPath = `${folder}/research.json`, raw = await read(inputPath)
type Source = { id: string; title: string; url: string; publicationStatus: string; sections: string; checkedOn: string; fact: string; limit: string; statusUrl?: string }
type LocalSource = { id: string; path: string; sha256: string; sourceCommit: string }
type Decision = { id: string; title: string; priority: string; authority: string; status: string; derivation: string; claim: string;
  sourceIds: string[]; localSourceIds: string[]; taskIds: string[]; requirementIds: string[]; checkIds: string[]; dependsOn: string[]; remaining: string; currentCoverage: string }
type Check = { id: string; decisionId: string; execution: string; expectation: string; negativeCase: string }
type Observation = { id: string; method: string; status: string; localSourceIds: readonly string[]; result: string; scope: string }
type Research = { schema: string; id: string; authority: string; status: string; researchedOn: string; sourceCommit: string;
  userRequest: { authority: string; text: string }; scope: Record<string, string>; sources: Source[]; localSources: LocalSource[];
  decisions: Decision[]; checks: Check[]; observations: Observation[]; tasks: { id: string; title: string }[];
  requirements: { id: string; text: string; authority: string }[]; competencyQuestions: string[]; implementationOrder: string[] }
const data = JSON.parse(raw) as Research
if (data.schema !== "usl-portability-research/v1" || data.authority !== "SECONDARY_AI" || data.status !== "RESEARCHED_PROPOSAL") throw new Error("invalid research contract")
const sets = [data.sources, data.localSources, data.decisions, data.checks, data.observations, data.tasks, data.requirements]
const ids = sets.flatMap(items => items.map(item => item.id))
if (new Set(ids).size !== ids.length) throw new Error("duplicate research identity")
const known = new Set(ids)
for (const source of data.localSources) {
  if (source.sourceCommit !== data.sourceCommit || digestSource(await read(source.path)) !== source.sha256) throw new Error(`local source drift: ${source.path}`)
  if (digestSource(execFileSync("git", ["show", `${source.sourceCommit}:${source.path}`], { cwd: root, encoding: "utf8" })) !== source.sha256) throw new Error(`historical source mismatch: ${source.path}`)
}
const visited = new Set<string>(), active = new Set<string>()
const visit = (id: string) => {
  if (active.has(id)) throw new Error("research dependency cycle")
  if (visited.has(id)) return
  const decision = data.decisions.find(item => item.id === id)
  if (!decision || decision.authority !== "SECONDARY_AI" || decision.status !== "PROPOSED" || decision.derivation !== "INFERENCE") throw new Error("invalid decision state")
  for (const key of ["sourceIds", "localSourceIds", "taskIds", "requirementIds", "checkIds", "dependsOn"] as const) {
    const values = decision[key]
    if ((!values.length && key !== "dependsOn") || values.some(value => !known.has(value)) || new Set(values).size !== values.length) throw new Error(`invalid decision ${key}`)
  }
  active.add(id); decision.dependsOn.forEach(visit); active.delete(id); visited.add(id)
}
data.decisions.forEach(item => visit(item.id))
for (const c of data.checks) if (c.execution !== "NOT_RUN" || !data.decisions.find(d => d.id === c.decisionId)?.checkIds.includes(c.id)) throw new Error("acceptance check is promoted or disconnected")
const probes: readonly PortabilityResearchProbe[] = runPortabilityResearchProbes()
const recordedProbes = data.observations.filter(o => o.method === "PURE_RUNTIME_PROBE")
if (json(probes) !== json(recordedProbes)) throw new Error("pure probe observations differ; review and repin research baseline")

const r = "urn:usl:portability-research:", prov = "http://www.w3.org/ns/prov#"
const definitions = [
  { name: "supported_by", roles: { decision: "Decision", source: "Source" }, meaning: "Source informs an AI inference; not a normative implementation mandate or proof" },
  { name: "inspects", roles: { decision: "Decision", source: "LocalSource" }, meaning: "Decision inspects this exact local code snapshot" },
  { name: "implements_task", roles: { decision: "Decision", task: "Task" }, meaning: "Proposed implementation placement; does not mark task completed" },
  { name: "addresses", roles: { decision: "Decision", requirement: "Requirement" }, meaning: "Decision addresses an interpreted requirement from the initial plan" },
  { name: "validated_by", roles: { decision: "Decision", check: "AcceptanceCheck" }, meaning: "Proposed acceptance criterion; execution remains NOT_RUN" },
  { name: "depends_on", roles: { decision: "Decision", prerequisite: "Decision" }, meaning: "Decision requires a prerequisite design; only this predicate is a DAG" },
  { name: "observes", roles: { observation: "Observation", source: "LocalSource" }, meaning: "Bounded observation of a pinned implementation; no general runtime guarantee" },
]
const profile = parseDomainProfile({ schema: "usl-domain-profile/v1", id: r + "profile", version: "1", closedMeanings: true,
  meanings: definitions.map(d => ({ id: r + d.name, allowExtraRoles: false,
    roles: Object.entries(d.roles).map(([role, type]) => ({ role, required: true, types: [r + type], metadata: [] })) })) })
const graph: ResourceGraph = { schema: "usl-resource-graph/v1", resources: [], meanings: definitions.map(d => ({ id: r + d.name, description: d.meaning })), links: [],
  provenance: { sources: ["source:research-input", "source:research-builder", "source:research-probes", "user:portability-research"], activity: "activity:portability-research", agent: "agent:portability-researcher" } }
const repo = (path: string) => `https://github.com/gj3447/USL/blob/master/${path}`
type Metadata = NonNullable<ResourceGraph["resources"][number]["metadata"]>
const add = (id: string, types: string[], locator: string, metadata: Metadata) => graph.resources.push({ id, types, locator, metadata })
const link = (name: string, participants: Record<string, string>) => graph.links.push({ id: `research-link:${graph.links.length}`, meaning: r + name,
  participants: Object.entries(participants).map(([role, resource]) => ({ role, resource })), metadata: { authority: "SECONDARY_AI", status: "RESEARCH_RELATION", execution: "NOT_CLAIMED" } })
add("source:research-input", [r + "Input", prov + "Entity"], repo(inputPath), { digest: digestSource(raw), scope: data.scope })
for (const [id, path] of [["source:research-builder", "scripts/build-portability-research.ts"], ["source:research-probes", "scripts/probe-portability-research.ts"]] as const) add(id, [r + "Input", prov + "Entity"], repo(path), { path, digest: digestSource(await read(path)) })
add("user:portability-research", [r + "UserRequest", prov + "Entity"], repo(inputPath), { ...data.userRequest })
add("activity:portability-research", [r + "ResearchActivity", prov + "Activity"], repo(inputPath), { researchedOn: data.researchedOn, runtimeAcceptance: "NOT_RUN" })
add("agent:portability-researcher", [r + "ResearchAgent", prov + "Agent"], repo(inputPath), { authority: "SECONDARY_AI" })
for (const s of data.sources) add(s.id, [r + "Source", prov + "Entity"], s.url, { ...s, factKind: "AI_PARAPHRASE_OF_PRIMARY_SOURCE", sourceBodyDigest: "NOT_RECORDED" })
for (const s of data.localSources) add(s.id, [r + "LocalSource", prov + "Entity"], `git://github.com/gj3447/USL@${s.sourceCommit}:${s.path}`, { ...s })
for (const t of data.tasks) add(t.id, [r + "Task"], repo("research/portability-plan/plan.json"), { ...t, role: "EXISTING_TASK_REFERENCE_NOT_CURRENT_STATUS" })
for (const q of data.requirements) add(q.id, [r + "Requirement"], repo("research/portability-plan/plan.json"), { ...q })
for (const d of data.decisions) {
  add(d.id, [r + "Decision", prov + "Entity"], repo(inputPath), { ...d })
  d.sourceIds.forEach(source => link("supported_by", { decision: d.id, source }))
  d.localSourceIds.forEach(source => link("inspects", { decision: d.id, source }))
  d.taskIds.forEach(task => link("implements_task", { decision: d.id, task }))
  d.requirementIds.forEach(requirement => link("addresses", { decision: d.id, requirement }))
  d.checkIds.forEach(check => link("validated_by", { decision: d.id, check }))
  d.dependsOn.forEach(prerequisite => link("depends_on", { decision: d.id, prerequisite }))
}
for (const c of data.checks) add(c.id, [r + "AcceptanceCheck"], repo(inputPath), { ...c })
for (const o of data.observations) { add(o.id, [r + "Observation", prov + "Entity"], repo(inputPath), { ...o, localSourceIds: [...o.localSourceIds] }); o.localSourceIds.forEach(source => link("observes", { observation: o.id, source })) }
const graphRaw = json(graph)
Either.getOrThrowWith(adaptResourceGraph(graphRaw, { namespace: "usl.portability.research", profile }), error => new Error(JSON.stringify(error)))
const graphLd = Either.getOrThrowWith(resourceGraphJsonLd(graphRaw, { namespace: "usl.portability.research", profile }), error => new Error(JSON.stringify(error)))
const ref = (id: string) => ({ "@id": id })
const trace = { "@context": { r, prov }, "@graph": [
  ...data.sources.map(s => ({ "@id": s.id, "@type": ["r:Source", "prov:Entity"], "r:url": ref(s.url), "r:publicationStatus": s.publicationStatus, "r:checkedOn": s.checkedOn, "r:fact": s.fact, "r:limit": s.limit, ...(s.statusUrl ? { "r:statusUrl": ref(s.statusUrl) } : {}) })),
  ...data.localSources.map(s => ({ "@id": s.id, "@type": ["r:LocalSource", "prov:Entity"], "r:path": s.path, "r:sha256": s.sha256, "r:sourceCommit": s.sourceCommit })),
  ...data.tasks.map(t => ({ "@id": t.id, "@type": "r:Task" })), ...data.requirements.map(q => ({ "@id": q.id, "@type": "r:Requirement" })),
  ...data.decisions.map(d => ({ "@id": d.id, "@type": ["r:Decision", "prov:Entity"], "r:authority": d.authority, "r:status": d.status, "r:derivation": d.derivation, "r:priority": d.priority, "r:claim": d.claim, "r:currentCoverage": d.currentCoverage,
    "r:supportedBy": d.sourceIds.map(ref), "r:inspects": d.localSourceIds.map(ref), "r:implementsTask": d.taskIds.map(ref), "r:addresses": d.requirementIds.map(ref), "r:validatedBy": d.checkIds.map(ref), "r:dependsOn": d.dependsOn.map(ref),
    "prov:wasDerivedFrom": [...d.sourceIds, ...d.localSourceIds].map(ref), "prov:wasAttributedTo": ref("agent:portability-researcher"), "prov:wasGeneratedBy": ref("activity:portability-research") })),
  ...data.checks.map(c => ({ "@id": c.id, "@type": "r:AcceptanceCheck", "r:forDecision": ref(c.decisionId), "r:execution": c.execution, "r:expectation": c.expectation, "r:negativeCase": c.negativeCase })),
  ...data.observations.map(o => ({ "@id": o.id, "@type": ["r:Observation", "prov:Entity"], "r:method": o.method, "r:status": o.status, "r:about": o.localSourceIds.map(ref), "r:result": o.result, "r:scope": o.scope })),
  { "@id": "agent:portability-researcher", "@type": "prov:Agent" },
  { "@id": "activity:portability-research", "@type": "prov:Activity", "prov:used": [...data.sources, ...data.localSources].map(s => ref(s.id)), "prov:wasAssociatedWith": ref("agent:portability-researcher") },
] }

const short = (id: string) => id.split(":").at(-1)!
const sourceLinks = (ids: string[]) => ids.map(id => { const s = data.sources.find(s => s.id === id)!; return `[${s.title}](${s.url})` }).join(", ")
const document = [
  "# USL 기기 이동과 백업 복원의 구현 근거", "",
  "USL이 컴퓨터·메모리 저장소·작업경로 이동을 견디려면 고정 ID에 더해 일관된 snapshot, 닫힌 복원 범위, 검증 후 활성화, 인과 이력과 명시적인 owner 계약이 필요하다. 조사 결과를 현재 코드와 대조해 다음 구현의 선택과 반례를 정리했다.", "",
  `조사 기준일은 ${data.researchedOn}, 코드·실행 기록 기준은 \`${data.sourceCommit}\`이다. 외부 1차 자료 ${data.sources.length}개의 사실과 USL에 대한 AI 구현 제안을 구분한다. PT01은 순수 manifest 계약이며, PT02·PT03의 파일 export/import·재바인딩은 별도 모듈에 있다. 이 연구 빌더는 제한된 parser probe와 기록된 실행 근거를 대조한다.`, "",
  "## 구현 판단", "",
  "ID를 보존한 이동·검증 가능한 백업 복원·오프라인 작업 분기는 구현 가능하다. 모든 사본 소실 뒤 복구, 통신이 끊긴 다른 기기의 전역 최신성, 임의의 외부 시스템에 대한 exactly-once는 조건 없이 보장할 수 없다. 누락·충돌·미확정 상태를 유지하고 명확한 범위에서만 성공으로 판단하는 것이 설계 기준이다.", "",
  "owner/native ID, revision parent DAG, tombstone, 명시적 digest 알고리즘과 host pin을 유지한다. 파일 profile의 구현과 실제 로컬 검사는 [개발 진행](DEVELOPMENT_PROGRESS.md)에 기록한다. 다음 보완 대상은 Git closure 재구성과 아직 실행하지 않은 OS의 복원 검사다.", "",
  "| 순서 | 제안 | 이유 |", "|---|---|---|",
  ...data.implementationOrder.map((text, i) => `| ${i + 1} | ${text} | ${i === 0 ? "이미 실행한 범위를 소스와 함께 보존" : i === 1 ? "파일 묶음만으로 Git 전체를 복구할 수 없음" : i === 2 ? "CI 정의와 실제 OS 실행을 구분" : i === 3 ? "파일 복원 위에 메모리 조각 식별을 추가" : "인과 이력과 외부 owner 효과를 별도로 검증"} |`), "",
  "## 현재 코드에서 확인한 경계", "",
  "순수 runtime probe 네 개를 실제 실행했다. OS 파일 생성이나 다기기 복원 실험은 아니다. 기존 PT01의 12개 통과 기록은 이전 영수증을 읽은 것으로, 이번에 그 테스트를 재실행했다고 기록하지 않는다.", "",
  "- 300자 ASCII 파일명 성분은 manifest가 허용한다. 목표 filesystem의 성분 길이·전체 경로 길이는 별도 검사해야 한다.",
  "- 300자 native ID는 기존 resource bindings가 허용하지만 portable v1은 거부한다. 기존 ID를 줄이거나 새 ID로 바꾸는 자동 migration은 부적절하다.",
  "- 같은 revision ID에 서로 다른 digest를 넣은 두 manifest는 각각 parse된다. 별도 PT03 importer는 owner가 제공한 registry descriptor와 충돌을 대조하지만 전역 registry를 자동 조회하지 않는다.",
  "- 미래 관측 시각을 넣어도 host 검사 결과는 freshness UNKNOWN, payload NOT_CHECKED, authority NOT_GRANTED를 유지한다.", "",
  "이 관측은 순수 PT01 parser의 경계다. PT03 파일 I/O와 registry 대조의 실행 근거는 [개발 진행](DEVELOPMENT_PROGRESS.md)에 별도로 연결한다. [Probe 코드](../scripts/probe-portability-research.ts)와 [관측 데이터](../research/portability-research/research.json)에 각각의 기준을 남겼다.", "",
  "## 제안한 export와 restore 절차", "",
  "```mermaid", "flowchart LR", "  A[owner 범위와 지원 확인] --> B[snapshot 또는 쓰기 중지]", "  B --> C[범위 목록과 bytes 수집]", "  C --> D[해시 크기 의존성 검증]", "  D --> E[완료된 bundle 봉인]", "  E --> F[목적지 filesystem staging]", "  F --> G[검증과 충돌 대조]", "  G --> H[sync와 no-replace 공개]", "  H --> I[새 로컬 binding 연결]", "```", "",
  "각 전이는 자원 수·bytes·시간 예산을 갖고 실패 상태를 기록한다. Bundle의 완전성, bytes 무결성, snapshot 일관성, 저장 내구성, 현재성, 권한은 별도 값이다. 일반 파일의 순차 복사와 stat 비교만으로 다중 파일의 원자적 snapshot을 주장하지 않는다. Owner snapshot을 얻을 수 없으면 제한된 capture로 표시한다.", "",
  "SQLite는 owner backup API를, Git은 refs 외에 working tree·submodule·LFS 목록을 사용한다. 원래 파일명은 번들 내부 ASCII 경로와 별도로 기록한다. 복원은 검증된 새 목적지에서 시작하고 환경 recipe 설치나 외부 실행은 별도의 명시적 작업이다.", "",
  "## 근거에 따른 설계 결정", "",
  "다음은 모두 SECONDARY_AI의 PROPOSED 판단이다. 인용은 판단의 근거이며 해당 표준이 USL의 구현 방식 전체를 의무화하거나 현재 기능을 인증한다는 뜻이 아니다. P0는 안전한 MVP 전에 결정할 사항, P1은 그 위에 추가할 기능이다.", "",
  ...data.decisions.flatMap(d => [
    `### ${short(d.id)} ${d.title}`, "", `**${d.priority} · ${d.taskIds.map(short).join(", ")}**. ${d.claim}`, "",
    `현재: ${d.currentCoverage}`, "", `남은 범위: ${d.remaining}`, "",
    `근거: ${sourceLinks(d.sourceIds)}.`, "",
    ...d.checkIds.flatMap(id => { const c = data.checks.find(c => c.id === id)!; return [`- **${short(c.id)} · NOT_RUN:** ${c.expectation} 반례: ${c.negativeCase}`] }), "",
  ]),
  "## 표준의 상태와 적용 한계", "",
  "SHACL의 안정된 검증 기준은 2017 Recommendation으로 유지한다. SHACL 1.2 Core의 2026-09-18 문서는 Working Draft다. Idempotency-Key draft 07은 Datatracker에서 만료·보관 상태이므로 확정 RFC로 채택하지 않는다. 아래 날짜는 자료 확인 시점이며 원문의 발행 시점 또는 실행 성공 시점이 아니다.", "",
  ...data.sources.flatMap(s => [`- [${s.title}](${s.url}) — \`${s.publicationStatus}\`, ${s.sections}, 확인 ${s.checkedOn}. 사실 요약: ${s.fact} 한계: ${s.limit}${s.statusUrl ? ` [상태 기록](${s.statusUrl}).` : ""}`]), "",
  "규칙의 severity, 실제 차단 정책, soft penalty coefficient, HSWM W 추정치, provenance 신뢰도, 권한은 서로 다른 필드다. 특히 현재 정책 감점 계수를 HSWM W 전체의 구현으로 보지 않는다. RDFC 역시 RDF dataset 동형성에 대한 정규화이며 원문의 의미·자원 소유권을 판정하지 않는다.", "",
  "## 연구 그래프와 검증 범위", "",
  "[원본 조사 데이터](../research/portability-research/research.json), [USL graph](../research/portability-research/graph.json), [JSON-LD](../research/portability-research/graph.jsonld), [typed RDF trace](../research/portability-research/trace.jsonld), [역할 profile](../research/portability-research/profile.json), [SHACL shapes](../schemas/portability-research/research.shacl.ttl)를 제공한다. 기존 PT01–PT07 작업과 R01–R07 요구사항 ID를 재사용한다. 공유 KG에는 쓰지 않았으며 이 로컬 어휘는 승인된 정전으로 승격하지 않았다.", "",
  "| 관계 | domain → range와 방향 | Cardinality | 의미 |", "|---|---|---|---|",
  ...definitions.map(d => `| ${d.name} | ${Object.values(d.roles).join(" → ")} | 각 link의 역할은 정확히 1개 | ${d.meaning} |`), "",
  "각 decision은 근거·코드·작업·요구사항·인수기준을 하나 이상 갖고, 인수기준은 한 decision에 귀속한다. dependencies만 DAG로 검증한다. PROV-O의 wasDerivedFrom·wasAttributedTo·wasGeneratedBy로 판단의 출처와 작성 활동을 연결하며 출처를 권한으로 읽지 않는다.", "",
  ...data.competencyQuestions.map(q => `- ${q}`), "",
  "독립 Python 검증기는 실제 SPARQL 결과의 endpoint 집합을 입력 데이터와 비교하고 SHACL로 타입·필수 관계·상태를 검사한다. 미래 인수기준은 모두 NOT_RUN이다. 인터넷 원문 bytes를 보관하거나 해시 검증했다고 주장하지 않으며 URL·절·상태·확인일을 기록한다. 코드 파일은 Git revision과 실제 bytes digest를 대조한다.", "",
  "```sh", "node --import tsx scripts/build-portability-research.ts", "node --import tsx scripts/build-portability-research.ts --check", "python3 scripts/validate-portability-research.py", "```", "",
  "빌더와 check는 4개 순수 probe를 실행한다. 이것은 복원·내구성·분산 효과에 대한 인수검사가 아니다. Python 환경은 기존 scripts/requirements-standards.txt를 따른다. [최초 계획](PORTABILITY_PLAN.md)과 [PT01 구현 범위](PORTABLE_TRANSFER.md)를 함께 읽으면 현재 구현과 남은 작업을 구분할 수 있다.", "",
].join("\n")
const outputs: Record<string, string> = { [`${folder}/profile.json`]: json(profile), [`${folder}/graph.json`]: graphRaw,
  [`${folder}/graph.jsonld`]: json(graphLd), [`${folder}/trace.jsonld`]: json(trace), "docs/PORTABILITY_RESEARCH.md": document }
for (const [path, content] of Object.entries(outputs)) {
  if (check) { if (await read(path) !== content) throw new Error(`research artifact differs: ${path}`) }
  else { await mkdir(dirname(resolve(root, path)), { recursive: true }); await writeFile(resolve(root, path), content) }
}
console.log(json({ mode: check ? "RESEARCH_ARTIFACTS_CHECKED" : "RESEARCH_ARTIFACTS_BUILT", sources: data.sources.length, decisions: data.decisions.length,
  plannedChecks: data.checks.length, observations: data.observations.length, pureProbesExecuted: probes.length, resources: graph.resources.length, links: graph.links.length, runtimeAcceptance: "NOT_RUN" }))
