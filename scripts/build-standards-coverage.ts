/** Build a bounded standards audit, not a universal standards implementation. */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Either } from "effect"
import { digestSource } from "../src/language/digest.js"
import { parseDomainProfile } from "../src/domain-profile.js"
import { adaptResourceGraph, resourceGraphJsonLd, type ResourceGraph } from "../src/integrations/resource-graph.js"
import { runStandardsCoverageProbes, type StandardsCoverageObservation } from "./probe-standards-coverage.js"

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), folder = "research/standards-coverage"
const check = process.argv.includes("--check"), inputPath = `${folder}/coverage.json`
if (process.argv.slice(2).some(arg => arg !== "--check")) throw new Error("usage: build-standards-coverage.ts [--check]")
const read = (path: string) => readFile(resolve(root, path), "utf8")
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"
const must: (value: unknown, message: string) => void = (value, message) => { if (!value) throw new Error(message) }
type Source = { id: string; title: string; url: string; publicationStatus: string; checkedOn: string; fact: string; limit: string; access: string }
type LocalSource = { id: string; path: string; sha256: string; sourceCommit: string }
type Assessment = { id: string; title: string; sourceIds: string[]; localSourceIds: string[]; observationIds: string[]; checkIds: string[]; stepId: string; coverage: string; scope: string; limitation: string; authority: string }
type AcceptanceCheck = { id: string; execution: string; expectation: string; negativeCase: string }
type Gate = { id: string; title: string; status: string; assessmentIds: string[]; observationIds: string[]; rationale: string }
type Step = { id: string; title: string; dependsOn: string[] }
type Technology = { id: string; nativeId: string; title: string; sources: string[]; upstreamCapability: string; classification: string; limitation: string; requirement: string; attack: string; expected: string; controls: string[]; controlIds: string[]; residual: string; upstreamExecution: string; freshness: string; reviewedAt: string; sourceCatalog: string }
type Control = { id: string; nativeId: string; title: string; scope: string; implementation: string[]; checks: string[]; residual: string }
type Coverage = { schema: string; id: string; authority: string; researchedOn: string; sourceCommit: string; overallVerdict: string; userRequest: { authority: string; text: string }; scope: Record<string, string>; sources: Source[]; localSources: LocalSource[]; assessments: Assessment[]; observations: StandardsCoverageObservation[]; checks: AcceptanceCheck[]; gates: Gate[]; steps: Step[]; inheritedTechnologies: Technology[]; inheritedControls: Control[]; competencyQuestions: string[] }
const raw = await read(inputPath), data = JSON.parse(raw) as Coverage
must(data.schema === "usl-standards-coverage/v1" && data.authority === "SECONDARY_AI" && data.overallVerdict === "NOT_A_STANDARDS_SUPERSET", "invalid audit metadata")
must(data.userRequest.authority === "USER_PRIMARY" && data.userRequest.text.length > 0, "missing user source")
const groups = [data.sources, data.localSources, data.assessments, data.observations, data.checks, data.gates, data.steps, data.inheritedTechnologies, data.inheritedControls]
const ids = groups.flatMap(group => group.map(item => item.id))
must(new Set(ids).size === ids.length, "duplicate audit ID")
const refs = (values: string[], targets: { id: string }[], required = true) => must((!required || values.length > 0) && new Set(values).size === values.length && values.every(id => targets.some(t => t.id === id)), "invalid or duplicate typed reference")
for (const s of data.localSources) {
  must(s.sourceCommit === data.sourceCommit && digestSource(await read(s.path)) === s.sha256, `source drift: ${s.path}`)
  must(digestSource(execFileSync("git", ["show", `${s.sourceCommit}:${s.path}`], { cwd: root, encoding: "utf8" })) === s.sha256, `historical source mismatch: ${s.path}`)
}
const coverageKinds = new Set(["DECLARATION_PROJECTION", "NOT_IMPLEMENTED", "BOUNDED_EXPORT", "EXTERNAL_TEST_TOOLING", "LOSSY_PROJECTION", "VOCABULARY_USE", "BOUNDED_WORKFLOW", "BOUNDED_NATIVE_FEATURE", "DRAFT_NOT_IMPLEMENTED"])
for (const a of data.assessments) {
  must(a.authority === "SECONDARY_AI" && coverageKinds.has(a.coverage) && a.scope && a.limitation, "invalid assessment")
  refs(a.sourceIds, data.sources); refs(a.localSourceIds, data.localSources); refs(a.observationIds, data.observations, false); refs(a.checkIds, data.checks); refs([a.stepId], data.steps)
}
for (const c of data.checks) must(c.execution === "NOT_RUN" && c.expectation && c.negativeCase && data.assessments.some(a => a.checkIds.includes(c.id)), "promoted or disconnected future check")
for (const g of data.gates) { refs(g.assessmentIds, data.assessments); refs(g.observationIds, data.observations, false); must(["FAIL", "NOT_ESTABLISHED"].includes(g.status) && g.rationale, "invalid gate") }
const done = new Set<string>(), active = new Set<string>()
const visit = (id: string) => {
  must(!active.has(id), "step dependency cycle"); if (done.has(id)) return
  const step = data.steps.find(s => s.id === id); must(step, "missing step")
  active.add(id); refs(step!.dependsOn, data.steps, false); step!.dependsOn.forEach(visit); active.delete(id); done.add(id)
}
data.steps.forEach(s => visit(s.id))
const probes = runStandardsCoverageProbes()
must(json(probes.observations) === json(data.observations), "observations drifted; review audit baseline")
const catalog = JSON.parse(await read("research/engineering/catalog.json")) as { reviewedAt: string; upstreamExecution: string; technologies: Omit<Technology, "nativeId" | "controlIds" | "sourceCatalog" | "upstreamExecution" | "freshness" | "reviewedAt">[]; controls: Omit<Control, "nativeId">[] }
must(json(data.inheritedTechnologies) === json(catalog.technologies.map(t => ({ ...t, id: `technology:${t.id}`, nativeId: t.id, controlIds: t.controls.map(c => `control:${c}`), sourceCatalog: "research/engineering/catalog.json", upstreamExecution: catalog.upstreamExecution, freshness: "INHERITED_NOT_RECHECKED", reviewedAt: catalog.reviewedAt }))), "inherited technology changed or missing")
must(json(data.inheritedControls) === json(catalog.controls.map(c => ({ ...c, id: `control:${c.id}`, nativeId: c.id }))), "inherited control changed or missing")

const s = "urn:usl:standards-coverage:", prov = "http://www.w3.org/ns/prov#"
const definitions = [
  { name: "supported_by", predicate: "supportedBy", roles: { assessment: "Assessment", source: "Source" }, meaning: "Primary source informs an AI assessment; no implementation certification" },
  { name: "inspects", predicate: "inspects", roles: { assessment: "Assessment", source: "LocalSource" }, meaning: "Assessment inspects this pinned implementation snapshot" },
  { name: "observed_by", predicate: "observedBy", roles: { assessment: "Assessment", observation: "Observation" }, meaning: "Bounded observation contributes evidence to the assessment" },
  { name: "requires_check", predicate: "requiresCheck", roles: { assessment: "Assessment", check: "AcceptanceCheck" }, meaning: "Future acceptance condition, not an execution result" },
  { name: "planned_in", predicate: "plannedIn", roles: { assessment: "Assessment", step: "Step" }, meaning: "Proposed implementation placement" },
  { name: "gate_evaluates", predicate: "evaluates", roles: { gate: "Gate", assessment: "Assessment" }, meaning: "Audit gate examines the assessment" },
  { name: "gate_observed_by", predicate: "observedBy", roles: { gate: "Gate", observation: "Observation" }, meaning: "Specific evidence contributing to a gate decision" },
  { name: "observation_inspects", predicate: "inspects", roles: { observation: "Observation", source: "LocalSource" }, meaning: "Observation applies only to this source revision" },
  { name: "depends_on", predicate: "dependsOn", roles: { step: "Step", prerequisite: "Step" }, meaning: "Step requires prerequisite; only these edges form a DAG" },
  { name: "covered_by", predicate: "coveredBy", roles: { technology: "InheritedTechnology", control: "InheritedControl" }, meaning: "Existing local integration control, not implementation of the upstream technology" },
]
const profile = parseDomainProfile({ schema: "usl-domain-profile/v1", id: s + "profile", version: "1", closedMeanings: true, meanings: definitions.map(d => ({ id: s + d.name, allowExtraRoles: false, roles: Object.entries(d.roles).map(([role, type]) => ({ role, required: true, types: [s + type], metadata: [] })) })) })
const graph: ResourceGraph = { schema: "usl-resource-graph/v1", resources: [], meanings: definitions.map(d => ({ id: s + d.name, description: d.meaning })), links: [], provenance: { sources: ["input:coverage", "input:coverage-builder", "input:coverage-probe", "user:standards-coverage"], activity: "activity:standards-coverage", agent: "agent:standards-coverage" } }
const repo = (p: string) => `https://github.com/gj3447/USL/blob/master/${p}`
type Metadata = NonNullable<ResourceGraph["resources"][number]["metadata"]>
const add = (id: string, type: string, metadata: Metadata, locator = repo(inputPath), provType = "Entity") => graph.resources.push({ id, types: [s + type, prov + provType], locator, metadata })
add("input:coverage", "Input", { path: inputPath, sha256: digestSource(raw) })
for (const [id, path] of [["input:coverage-builder", "scripts/build-standards-coverage.ts"], ["input:coverage-probe", "scripts/probe-standards-coverage.ts"]]) add(id!, "Input", { path: path!, sha256: digestSource(await read(path!)) }, repo(path!))
add("user:standards-coverage", "UserRequest", data.userRequest)
add("activity:standards-coverage", "AuditActivity", { researchedOn: data.researchedOn, officialConformanceSuite: "NOT_RUN" }, repo(inputPath), "Activity")
add("agent:standards-coverage", "AuditAgent", { authority: "SECONDARY_AI" }, repo(inputPath), "Agent")
add(data.id, "Audit", { authority: data.authority, overallVerdict: data.overallVerdict, scope: data.scope })
data.sources.forEach(x => add(x.id, "Source", { ...x, factKind: "AI_PARAPHRASE_OF_PRIMARY_SOURCE", sourceBodyDigest: "NOT_RECORDED" }, x.url))
data.localSources.forEach(x => add(x.id, "LocalSource", x, `git://github.com/gj3447/USL@${x.sourceCommit}:${x.path}`))
data.assessments.forEach(x => add(x.id, "Assessment", x))
data.observations.forEach(x => add(x.id, "Observation", { ...x, sourcePaths: [...x.sourcePaths] }))
data.checks.forEach(x => add(x.id, "AcceptanceCheck", x))
data.gates.forEach(x => add(x.id, "Gate", x))
data.steps.forEach(x => add(x.id, "Step", { ...x, status: "PROPOSED", authority: "SECONDARY_AI" }))
data.inheritedTechnologies.forEach(x => add(x.id, "InheritedTechnology", x, repo(x.sourceCatalog)))
data.inheritedControls.forEach(x => add(x.id, "InheritedControl", x, repo("research/engineering/catalog.json")))
const edges: { predicate: string; from: string; to: string }[] = []
const link = (name: string, participants: Record<string, string>) => {
  const d = definitions.find(x => x.name === name)!; const [from, to] = Object.values(participants)
  edges.push({ predicate: d.predicate, from: from!, to: to! })
  graph.links.push({ id: `coverage-link:${graph.links.length}`, meaning: s + name, participants: Object.entries(participants).map(([role, resource]) => ({ role, resource })), metadata: { authority: "SECONDARY_AI", status: "AUDIT_RELATION" } })
}
for (const a of data.assessments) {
  a.sourceIds.forEach(source => link("supported_by", { assessment: a.id, source })); a.localSourceIds.forEach(source => link("inspects", { assessment: a.id, source }))
  a.observationIds.forEach(observation => link("observed_by", { assessment: a.id, observation })); a.checkIds.forEach(check => link("requires_check", { assessment: a.id, check }))
  link("planned_in", { assessment: a.id, step: a.stepId })
}
for (const g of data.gates) { g.assessmentIds.forEach(assessment => link("gate_evaluates", { gate: g.id, assessment })); g.observationIds.forEach(observation => link("gate_observed_by", { gate: g.id, observation })) }
for (const o of data.observations) for (const path of o.sourcePaths) { const source = data.localSources.find(x => x.path === path); must(source, "missing observation source"); link("observation_inspects", { observation: o.id, source: source!.id }) }
data.steps.forEach(x => x.dependsOn.forEach(prerequisite => link("depends_on", { step: x.id, prerequisite })))
data.inheritedTechnologies.forEach(x => x.controlIds.forEach(control => link("covered_by", { technology: x.id, control })))
const graphRaw = json(graph), options = { namespace: "usl.standards.coverage", profile }
Either.getOrThrowWith(adaptResourceGraph(graphRaw, options), e => new Error(JSON.stringify(e)))
const graphLd = Either.getOrThrowWith(resourceGraphJsonLd(graphRaw, options), e => new Error(JSON.stringify(e)))
const ref = (id: string) => ({ "@id": id })
const traceNode = (id: string, type: string, fields: Record<string, unknown>) => ({ "@id": id, "@type": [`s:${type}`, "prov:Entity"], ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [`s:${key}`, value])) })
const trace = { "@context": { s, prov }, "@graph": [
  traceNode(data.id, "Audit", { overallVerdict: data.overallVerdict, authority: data.authority, researchedOn: data.researchedOn }),
  ...data.sources.map(({ id, url, ...x }) => traceNode(id, "Source", { ...x, url: ref(url) })),
  ...data.localSources.map(({ id, ...x }) => traceNode(id, "LocalSource", x)),
  ...data.assessments.map(a => ({ ...traceNode(a.id, "Assessment", { title: a.title, authority: a.authority, coverage: a.coverage, scope: a.scope, limitation: a.limitation }), "prov:wasDerivedFrom": [...a.sourceIds, ...a.localSourceIds].map(ref), "prov:wasAttributedTo": ref("agent:standards-coverage"), "prov:wasGeneratedBy": ref("activity:standards-coverage") })),
  ...data.observations.map(o => traceNode(o.id, "Observation", { status: o.status, method: o.method, scope: o.scope, result: o.result })),
  ...data.checks.map(({ id, ...x }) => traceNode(id, "AcceptanceCheck", x)),
  ...data.gates.map(g => traceNode(g.id, "Gate", { title: g.title, status: g.status, rationale: g.rationale })),
  ...data.steps.map(x => traceNode(x.id, "Step", { title: x.title, status: "PROPOSED" })),
  ...data.inheritedTechnologies.map(x => traceNode(x.id, "InheritedTechnology", { title: x.title, scope: x.classification, residual: x.residual, upstreamExecution: x.upstreamExecution, freshness: x.freshness, reviewedAt: x.reviewedAt })),
  ...data.inheritedControls.map(x => traceNode(x.id, "InheritedControl", { title: x.title, scope: x.scope, residual: x.residual })),
  { "@id": "user:standards-coverage", "@type": "prov:Entity", "s:authority": "USER_PRIMARY", "s:text": data.userRequest.text },
  { "@id": "agent:standards-coverage", "@type": "prov:Agent", "s:authority": "SECONDARY_AI" },
  { "@id": "activity:standards-coverage", "@type": "prov:Activity", "s:researchedOn": data.researchedOn, "prov:used": ref("user:standards-coverage") },
  ...edges.map(e => ({ "@id": e.from, [`s:${e.predicate}`]: ref(e.to) })),
] }
const sourceLinks = (ids: string[]) => ids.map(id => { const x = data.sources.find(s => s.id === id)!; return `[${x.title}](${x.url})` }).join(", ")
const short = (id: string) => id.split(":").slice(1).join(":"), cell = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ")
const document = [
  "# USL 표준 그래프 엔지니어링 지원 범위 감사", "",
  `**판정: 현재 USL은 표준 그래프 기술 전체의 상위호환이 아니다 — ${data.overallVerdict}.** ${data.researchedOn} 조사, 코드 기준 \`${data.sourceCommit}\`. 이 판정은 SECONDARY_AI의 근거 기반 평가이며 표준 기관의 인증이 아니다.`, "",
  "USL은 출처·역할·바인딩·계획/관측 상태를 연결하는 공학 작업을 수행한다. 그러나 일반 RDF dataset의 무손실 교환, 표준 질의·추론·검증·protocol 동작을 모두 수행하지는 않는다. JSON-LD 출력, 자체 profile 검사, 일부 표준 어휘 사용을 범용 표준 processor 지원으로 확대 해석하면 안 된다.", "",
  `기존 [engineering catalog](../research/engineering/catalog.json)의 **${data.inheritedTechnologies.length}개 기술과 ${data.inheritedControls.length}개 control을 모두 가져와** 원래 한계·반례·잔여 과제를 보존했다. 추가로 **${data.sources.length}개 공식 자료를 ${data.assessments.length}개 지원 영역**으로 대조했다. 전 세계 모든 그래프 관련 표준의 규범 전문을 수집한 목록은 아니다. 분야별 ontology·GeoSPARQL·vendor dialect·graph algorithm·GraphRAG 검색 품질은 별도 범위다.`, "",
  "기존 40항목은 2026-09-22의 역사적 조사이며 최신 제품 버전을 이번에 모두 재검증한 것은 아니다. 모든 항목의 upstreamExecution은 NOT_TESTED다. 로컬 control이 기술과 연결된다는 사실은 해당 기술을 USL이 구현했다는 뜻이 아니다. ISO GQL/SQL-PGQ는 공개 catalog/abstract만 확인했으며 유료 규범 전문의 조항별 적합성은 미평가다.", "",
  "## 상위호환의 판단 기준", "",
  "이번 감사에서는 선언한 표준 profile에 대해 입력·모델 수용, 무손실 왕복, 관련 observable behavior, 독립 적합성 근거, 확장의 보수성을 요구한다. vocabulary 사용에는 query engine을 요구하지 않는다. processor를 제공한다고 주장할 때에만 해당 processor의 동작을 요구하며, 명시된 외부 엔진으로 위임하는 구현도 가능하다.", "",
  "| Gate | 판정 | 근거 |", "|---|---|---|", ...data.gates.map(g => `| ${short(g.id)} ${g.title} | ${g.status} | ${g.rationale} |`), "",
  "## 실제로 확인한 경계", "",
  "- USL 고유 graph의 이름 있는 n-ary 역할은 문법 검사를 통과한다. 이는 USL graph의 round trip이며 RDF dataset round trip은 아니다.",
  "- 일반 JSON-LD와 Turtle 입력을 USL resource graph parser에 주면 거부된다.",
  "- 선언 export를 독립 RDF parser로 읽으면 USL Link·Meaning·Participant가 나온다. 원래 의도한 `alice knows bob` domain triple은 없다. 선언에 대한 RDF 표현과 원문 RDF assertion은 다르다.",
  "- property-graph/v2에서 node label/score·edge weight 같은 임의 property를 바꿔도 adapted plan과 identity는 같고 원문 digest만 바뀐다. 따라서 임의 LPG의 무손실 수입으로 볼 수 없다.",
  "- DomainProfile은 정확한 role/type/metadata 검사다. 부모 타입을 metadata에 적는 것만으로 타입 조건을 만족시키지 않는다. 이 probe는 RDFS conformance 시험이 아니다. 추론하지 않는다는 범위는 코드 계약에서 별도로 확인한다.",
  "- GQL engine을 호출하지 않는다는 항목은 정적 코드 검토다. 실행한 GQL conformance test로 세지 않는다.", "",
  `관측 ${data.observations.length}개 중 순수 실행 probe ${data.observations.filter(o => o.method === "PURE_RUNTIME_PROBE").length}개, 정적 코드 검토 ${data.observations.filter(o => o.method === "STATIC_CODE_INSPECTION").length}개다. [Probe 코드](../scripts/probe-standards-coverage.ts)의 범위를 넘는 보장을 주장하지 않는다. 공식 전체 적합성 suite와 후속 인수검사 ${data.checks.length}개는 NOT_RUN이다.`, "",
  "## 표준별 현재 지원", "",
  "| 영역 | 현재 범위 | 구현과 한계 |", "|---|---|---|", ...data.assessments.map(a => `| ${cell(a.title)} | ${a.coverage} | ${cell(a.scope)} ${cell(a.limitation)} |`), "",
  "n-ary를 문법에서 직접 다루는 것은 유용하지만 RDF/OWL에서도 relation node와 role property로 표현할 수 있다. 따라서 n-ary만으로 더 큰 표현력을 증명할 수 없다. [W3C 모델링 Note](https://www.w3.org/TR/swbp-n-aryRelations/)는 이를 설명하며 규범적 적합성 표준은 아니다.", "",
  "규칙의 severity, 차단 여부, soft penalty coefficient, HSWM의 학습된 W, provenance 신뢰도, 접근 권한은 다른 값이다. 현재 rule-policy·rule-weight-evidence는 선택형 계약/증거 기능이며 W 전체의 학습·평가나 표준 reasoner를 대체하지 않는다. 기기 이동의 identity/revision/manifest 계약과 실제 백업·복원 완료도 별개다. [기존 이동성 조사](PORTABILITY_RESEARCH.md)의 후속 과제를 유지한다.", "",
  "## 기존 40개 기술의 전체 대응표", "",
  "아래 control 연결은 원본 그대로다. 각 기술의 세부 원문 source·요구사항·반례·기대 동작은 [기계 판독 입력](../research/standards-coverage/coverage.json)에 빠짐없이 남겼다. 공통 상태: INHERITED_NOT_RECHECKED / upstream NOT_TESTED.", "",
  "| ID · 기술 | 기존 control | 남은 구현/보장 |", "|---|---|---|", ...data.inheritedTechnologies.map(t => `| ${t.nativeId} · ${cell(t.title)} | ${t.controls.join(", ")} | ${cell(t.residual)} |`), "",
  "| Control | 실제 검사 범위 | 남은 한계 |", "|---|---|---|", ...data.inheritedControls.map(c => `| ${c.nativeId} · ${cell(c.title)} | ${cell(c.scope)} | ${cell(c.residual)} |`), "",
  "## 구현 순서와 완료 조건", "",
  "단순한 USL core는 유지하고 선택형 adapter와 owner engine을 연결하는 방향이다. 모든 표준 엔진을 core 안에 재구현할 필요는 없다. 목표 문구는 우선 ‘명시한 표준 profile과 상호운용하는 연결 계층’이며 검증 전에는 ‘완전한 상위호환’을 사용하지 않는다.", "",
  "```mermaid", "flowchart LR", '  S0[지원 profile과 손실 계약] --> S1[RDF와 LPG 교환 경계]', '  S1 --> S2[표준 검증·질의·추론 위임]', '  S1 --> S3[도메인 어휘와 anchor mapping]', '  S2 --> S4[독립 적합성 검증]', '  S3 --> S4', "```", "",
  ...data.steps.map(x => `- **${short(x.id)}:** ${x.title}. 선행: ${x.dependsOn.map(short).join(", ") || "없음"}. 상태 PROPOSED.`), "",
  "RDF 교환 경계에는 IRI·blank node·typed/language literal·default/named graph를 명시해야 한다. payload와 USL link metadata를 구분하고, 지원하지 않는 문법/의미를 명시적으로 거부하거나 손실로 보고한다. dataset 동형성, 원문 bytes 일치, RDF entailment는 서로 다른 비교다. N-Quads의 빈 named graph 같은 형식 자체의 한계도 profile에 포함한다.", "",
  ...data.assessments.flatMap(a => { const c = data.checks.find(x => x.id === a.checkIds[0])!; return [`### ${a.title}`, "", `현재 판단: **${a.coverage}**. ${a.limitation}`, "", `**${c.id} · NOT_RUN:** ${c.expectation} 반례: ${c.negativeCase}`, "", `근거: ${sourceLinks(a.sourceIds)}. 코드: ${a.localSourceIds.map(id => { const x = data.localSources.find(l => l.id === id)!; return `[${x.path}](../${x.path})` }).join(", ")}.`, ""] }),
  "## 공식 자료의 상태와 접근 범위", "",
  "RDF 1.2 Concepts는 2026-04-07 Candidate Recommendation Snapshot이며 최신 Recommendation은 RDF 1.1이다. SHACL 1.2 Core는 2026-09-18 Working Draft, SPARQL 1.2 Query는 2026-10-01 Working Draft, Protocol은 2026-07-23 Working Draft다. ISO GQL은 2024판과 2026년 7월 Cor 1을 구분한다. Note·Draft를 확정 Recommendation으로 승격하지 않는다.", "",
  ...data.sources.map(x => `- [${x.title}](${x.url}) — ${x.publicationStatus}; 확인 ${x.checkedOn}; ${x.access}. ${x.fact} ${x.limit}`), "",
  "## 그래프 계약과 검증", "",
  "[입력](../research/standards-coverage/coverage.json), [USL graph](../research/standards-coverage/graph.json), [JSON-LD 선언](../research/standards-coverage/graph.jsonld), [typed RDF trace](../research/standards-coverage/trace.jsonld), [role profile](../research/standards-coverage/profile.json), [SHACL](../schemas/standards-coverage/coverage.shacl.ttl)을 생성한다. Local source는 Git revision과 bytes SHA-256으로 고정한다. 웹 원문의 bytes를 보관하거나 hash 검증했다고 주장하지 않는다. URL·자료 상태·확인일·접근 범위를 보존한다.", "",
  "| USL 관계 / RDF predicate | domain → range | 의미 |", "|---|---|---|", ...definitions.map(d => `| ${d.name} / ${d.predicate} | ${Object.values(d.roles).join(" → ")} | ${d.meaning} |`), "",
  "각 link의 명명된 역할은 정확히 하나씩이며 추가 역할은 거부한다. Assessment는 source·local source·future check를 각각 하나 이상, step을 정확히 하나 갖는다. 관측 연결은 0개 이상이다. gate는 판단을 하나 이상 참조한다. step의 depends_on만 DAG다. provenance는 출처/작성 주체를 나타내며 권한이나 사용자 정전 승인으로 해석하지 않는다.", "",
  ...data.competencyQuestions.map(q => `- ${q}`), "",
  "독립 validator는 실제 RDF parsing·SHACL·SPARQL endpoint 집합을 확인하고, 누락된 근거·잘못된 대상 타입·미실행 검사 승격·누락된 한계·dependency 순환·판정 승격 등을 거부한다. 이 결과는 감사 그래프와 선택한 fixture의 적합성이며 모든 RDF/JSON-LD/SHACL/GQL 공식 suite 합격을 뜻하지 않는다.", "",
  "```sh", "node --import tsx scripts/build-standards-coverage.ts", "node --import tsx scripts/build-standards-coverage.ts --check", "python3 scripts/validate-standards-coverage.py", "```", "",
].join("\n")
const outputs: Record<string, string> = { [`${folder}/profile.json`]: json(profile), [`${folder}/graph.json`]: graphRaw, [`${folder}/graph.jsonld`]: json(graphLd), [`${folder}/trace.jsonld`]: json(trace), [`${folder}/probe-fixture.jsonld`]: json(probes.rdfFixture), "docs/STANDARDS_COVERAGE.md": document }
for (const [path, content] of Object.entries(outputs)) {
  if (check) must(await read(path) === content, `audit artifact differs: ${path}`)
  else { await mkdir(dirname(resolve(root, path)), { recursive: true }); await writeFile(resolve(root, path), content) }
}
console.log(json({ mode: check ? "AUDIT_ARTIFACTS_CHECKED" : "AUDIT_ARTIFACTS_BUILT", verdict: data.overallVerdict, sources: data.sources.length, assessments: data.assessments.length, inheritedTechnologies: data.inheritedTechnologies.length, inheritedControls: data.inheritedControls.length, pureProbesExecuted: data.observations.filter(o => o.method === "PURE_RUNTIME_PROBE").length, staticObservations: data.observations.filter(o => o.method === "STATIC_CODE_INSPECTION").length, futureAcceptance: "NOT_RUN", resources: graph.resources.length, links: graph.links.length }))
