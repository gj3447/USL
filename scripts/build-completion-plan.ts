/** Build the future completion roadmap.  It validates plans; it never runs them. */
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Either } from "effect"
import { digestSource } from "../src/language/digest.js"
import { parseDomainProfile } from "../src/domain-profile.js"
import { adaptResourceGraph, resourceGraphJsonLd, type ResourceGraph } from "../src/integrations/resource-graph.js"

type Source = { id:string; path:string; sha256:string; sourceCommit:string }
type Baseline = { id:string; taskId:string; title:string; status:string; scope:string; remaining:string; sourceIds:string[] }
type Acceptance = { id:string; expectation:string; negativeCase:string; execution:"NOT_RUN" }
type Package = { id:string; title:string; phase:string; priority:string; owner:string; scope:string; dependsOn:string[]; conditionalDependsOn:string[]; canonicalTaskIds:string[]; criterionIds:string[]; sourceIds:string[]; prerequisiteIds:string[]; plannedOutputs:string[]; acceptance:Acceptance[]; status:"PLANNED" }
type Coverage = { id:string; kind:"CRITERION"|"ASSESSMENT"|"TECHNOLOGY"|"CONTROL"; sourceId:string; sourceRecordId:string; packageIds:string[]; disposition:"REVERIFY"|"IMPLEMENT_AND_VERIFY"|"PROFILE_ASSESSMENT"; rationale:string }
type Prerequisite = { id:string; title:string; status:"NEEDED"; owner:string; neededFor:string[]; resolution:string; completionEvidence:string }
type Milestone = { id:string; title:string; packageIds:string[]; gate:string; status:"PLANNED" }
type Plan = { schema:"usl-completion-plan/v1"; id:"plan:usl-completion-2026-10-04"; authority:"SECONDARY_AI"; status:"PLANNED"; recordedOn:"2026-10-04"; sourceCommit:string; firstPackage:string; userRequest:{authority:"USER_PRIMARY";text:string}; sources:Source[]; baselines:Baseline[]; packages:Package[]; coverage:Coverage[]; prerequisites:Prerequisite[]; milestones:Milestone[]; competencyQuestions:{id:string;question:string}[]; decisions:string[] }
type Entity = { id:string } & Record<string, unknown>
const root=resolve(dirname(fileURLToPath(import.meta.url)),".."), folder="research/completion-plan", input=`${folder}/plan.json`
const check=process.argv.slice(2).includes("--check")
if (process.argv.slice(2).some(x=>x!=="--check")) throw new Error("usage: build-completion-plan.ts [--check]")
const read=(p:string)=>readFile(resolve(root,p),"utf8"), text=(x:unknown)=>JSON.stringify(x,null,2)+"\n"
function must(x:unknown,m:string):asserts x { if(!x)throw new Error(m) }
const id=/^[A-Za-z][A-Za-z0-9_-]*:[A-Za-z0-9._:-]+$/
const raw=await read(input), plan=JSON.parse(raw) as Plan
must(plan.schema==="usl-completion-plan/v1"&&plan.id==="plan:usl-completion-2026-10-04"&&plan.authority==="SECONDARY_AI"&&plan.status==="PLANNED"&&plan.recordedOn==="2026-10-04"&&/^[a-f0-9]{40}$/.test(plan.sourceCommit),"invalid completion header")
must(plan.userRequest?.authority==="USER_PRIMARY"&&plan.userRequest.text.trim(),"missing verbatim user request")
const groups:[string,Entity[]][]=[["Source",plan.sources],["Baseline",plan.baselines],["Package",plan.packages],["Coverage",plan.coverage],["Prerequisite",plan.prerequisites],["Milestone",plan.milestones],["CompetencyQuestion",plan.competencyQuestions]]
const all=groups.flatMap(([,v])=>v), ids=new Set<string>(); for(const x of all){must(id.test(x.id)&&!ids.has(x.id),`duplicate/invalid ID ${x.id}`);ids.add(x.id)}
const sourceBy=new Map(plan.sources.map(x=>[x.id,x])); must(sourceBy.size===plan.sources.length&&plan.sources.length>0,"bad sources")
const blob=(commit:string,path:string)=>execFileSync("git",["show",`${commit}:${path}`],{cwd:root,encoding:"utf8"})
for(const s of plan.sources){must(s.sourceCommit===plan.sourceCommit&&/^[a-f0-9]{40}$/.test(s.sourceCommit)&&/^sha256:[a-f0-9]{64}$/.test(s.sha256)&&s.path&&!s.path.startsWith("/"),`bad source ${s.id}`);must(digestSource(blob(s.sourceCommit,s.path))===s.sha256,`source drift ${s.id}`)}
const oldSource=plan.sources.find(x=>x.path==="research/development-plan/plan.json");must(oldSource,"missing original plan source")
const old=JSON.parse(blob(oldSource.sourceCommit,oldSource.path)) as {requirements:({id:string;text:string}&Record<string,unknown>)[];tasks:({id:string;title:string;requirementIds:string[]}&Record<string,unknown>)[];criteria:({id:string;taskId:string;expectation:string}&Record<string,unknown>)[]}
const oldTasks=new Set(old.tasks.map(x=>x.id)), oldCriteria=new Set(old.criteria.map(x=>x.id)); must(oldTasks.size===14&&oldCriteria.size===47,"original plan shape changed")
const assessmentsSource=plan.sources.find(x=>x.path==="research/standards-coverage/coverage.json"); const catalogSource=plan.sources.find(x=>x.path==="research/engineering/catalog.json");must(assessmentsSource&&catalogSource,"missing coverage sources")
const assessments=JSON.parse(blob(assessmentsSource.sourceCommit,assessmentsSource.path)) as {assessments:{id:string}[]}; const catalog=JSON.parse(blob(catalogSource.sourceCommit,catalogSource.path)) as {technologies:{id:string}[];controls:{id:string}[]}
const assessmentIds=new Set(assessments.assessments.map(x=>x.id)), technologyIds=new Set(catalog.technologies.map(x=>x.id)), controlIds=new Set(catalog.controls.map(x=>x.id));must(assessmentIds.size===22&&technologyIds.size===40&&controlIds.size===12,"coverage source shape changed")
const baselineIds=new Set(plan.baselines.map(x=>x.id));must(plan.baselines.length===14&&new Set(plan.baselines.map(x=>x.taskId)).size===14,"must include fourteen distinct baselines");for(const b of plan.baselines){must(oldTasks.has(b.taskId)&&b.title.trim()&&b.status&&b.scope.trim()&&b.remaining.trim()&&b.sourceIds.length&&b.sourceIds.every(x=>sourceBy.has(x)),`bad baseline ${b.id}`)}
const byPackage=new Map(plan.packages.map(x=>[x.id,x]));must(byPackage.size===plan.packages.length&&plan.packages.length>=20&&plan.packages.length<=25&&byPackage.has(plan.firstPackage),"invalid package set")
const prereqIds=new Set(plan.prerequisites.map(x=>x.id));for(const p of plan.prerequisites)must(p.status==="NEEDED"&&p.title.trim()&&p.owner&&p.neededFor.length&&p.resolution.trim()&&p.completionEvidence.trim(),`bad prerequisite ${p.id}`)
const packageSeen=new Set<string>(), stack=new Set<string>();const visit=(p:string)=>{must(!stack.has(p),"package dependency cycle");if(packageSeen.has(p))return;const x=byPackage.get(p);must(x,`unknown package ${p}`);must(x.status==="PLANNED"&&x.title.trim()&&x.scope.trim()&&x.phase&&x.priority&&x.owner,`bad package ${p}`);stack.add(p);for(const q of [...x.dependsOn,...x.conditionalDependsOn])visit(q);stack.delete(p);packageSeen.add(p)};for(const p of plan.packages)visit(p.id)
for(const p of plan.packages){must(p.sourceIds.length&&p.sourceIds.every(x=>sourceBy.has(x))&&p.prerequisiteIds.every(x=>prereqIds.has(x))&&p.plannedOutputs.length&&p.acceptance.length,`bad package refs ${p.id}`);for(const task of p.canonicalTaskIds)must(oldTasks.has(task),`unknown original task ${task}`);for(const c of p.criterionIds)must(oldCriteria.has(c),`unknown original criterion ${c}`);for(const a of p.acceptance)must(id.test(a.id)&&a.execution==="NOT_RUN"&&a.expectation.trim()&&a.negativeCase.trim(),`bad acceptance ${p.id}`)}
const covered=new Map<string,Coverage>();for(const c of plan.coverage){must(id.test(c.id)&&!covered.has(c.id)&&sourceBy.has(c.sourceId)&&c.packageIds.length&&c.packageIds.every(x=>byPackage.has(x))&&c.rationale.trim(),`bad coverage ${c.id}`);covered.set(c.id,c);const expected=c.kind==="CRITERION"?oldCriteria:c.kind==="ASSESSMENT"?assessmentIds:c.kind==="TECHNOLOGY"?technologyIds:controlIds;must(expected.has(c.sourceRecordId),`unknown coverage record ${c.sourceRecordId}`)}
for(const x of [...oldCriteria,...assessmentIds,...technologyIds,...controlIds])must([...covered.values()].filter(c=>c.sourceRecordId===x).length===1,`coverage omission/duplicate ${x}`)
for(const c of plan.coverage){const path=sourceBy.get(c.sourceId)!.path;const expected=c.kind==="CRITERION"?"research/development-plan/plan.json":c.kind==="ASSESSMENT"?"research/standards-coverage/coverage.json":"research/engineering/catalog.json";must(path===expected,`coverage source mismatch ${c.id}`)}
for(const m of plan.milestones)must(m.status==="PLANNED"&&m.title.trim()&&m.gate.trim()&&m.packageIds.length&&m.packageIds.every(x=>byPackage.has(x)),`bad milestone ${m.id}`)
// Cross-record invariants: references must describe the same acceptance mapping.
const exact = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === a.length && a.every(x => b.includes(x))
const first = byPackage.get(plan.firstPackage)!
must(first.dependsOn.length === 0 && first.conditionalDependsOn.length === 0, "first package must be independently ready")
must(exact([...new Set(plan.packages.flatMap(p => p.canonicalTaskIds))], [...oldTasks]), "original task coverage incomplete")
must(exact([...new Set(plan.packages.flatMap(p => p.criterionIds))], [...oldCriteria]), "original criterion coverage incomplete")
must(exact([...new Set(plan.milestones.flatMap(m => m.packageIds))], [...byPackage.keys()]), "milestone package coverage incomplete")
const acceptanceIds = plan.packages.flatMap(p => p.acceptance.map(a => a.id))
const resourceIds = [...ids, ...acceptanceIds, ...old.tasks.map(t => t.id), ...old.criteria.map(c => c.id), ...old.requirements.map(r => r.id)]
must(new Set(resourceIds).size === resourceIds.length, "cross-type resource ID collision")
for (const p of plan.packages) {
  must(p.canonicalTaskIds.length && p.criterionIds.length, `missing original mapping ${p.id}`)
  for (const key of ["dependsOn", "conditionalDependsOn", "canonicalTaskIds", "criterionIds", "sourceIds", "prerequisiteIds", "plannedOutputs"] as const)
    must(new Set(p[key]).size === p[key].length, `duplicate ${key}: ${p.id}`)
  must(p.plannedOutputs.every(path => path && !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..")), `unsafe output path ${p.id}`)
  must(p.criterionIds.every(id => p.canonicalTaskIds.includes(old.criteria.find(c => c.id === id)!.taskId)), `criterion/task mismatch ${p.id}`)
}
for (const c of plan.coverage) {
  must(["CRITERION", "ASSESSMENT", "TECHNOLOGY", "CONTROL"].includes(c.kind), `invalid coverage kind ${c.id}`)
  must(["REVERIFY", "IMPLEMENT_AND_VERIFY", "PROFILE_ASSESSMENT"].includes(c.disposition), `invalid disposition ${c.id}`)
  if (c.kind === "CRITERION") must(exact(c.packageIds, plan.packages.filter(p => p.criterionIds.includes(c.sourceRecordId)).map(p => p.id)), `criterion coverage disagreement ${c.id}`)
}
for (const gate of plan.prerequisites)
  must(exact(gate.neededFor, plan.packages.filter(p => p.prerequisiteIds.includes(gate.id)).map(p => p.id)), `prerequisite inverse mismatch ${gate.id}`)
const d="urn:usl:completion-plan:", prov="http://www.w3.org/ns/prov#", repo=(p:string)=>`https://github.com/gj3447/USL/blob/master/${p}`
type Def={name:string;roles:Record<string,string>;meaning:string};const defs:Def[]=[
 {name:"original_task_addresses",roles:{originalTask:"OriginalTask",requirement:"OriginalRequirement"},meaning:"Historical task addresses the historical AI-derived requirement"},
 {name:"original_criterion_for",roles:{originalCriterion:"OriginalCriterion",originalTask:"OriginalTask"},meaning:"Original acceptance belongs to its original task"},
 {name:"requirement_source",roles:{requirement:"OriginalRequirement",source:"Source"},meaning:"Original requirement is preserved in this immutable source snapshot"},
 {name:"depends_on",roles:{package:"Package",prerequisite:"Package"},meaning:"Unconditional future package dependency"},{name:"conditionally_depends_on",roles:{package:"Package",prerequisite:"Package"},meaning:"Dependency activated only for stated scope"},{name:"uses_source",roles:{package:"Package",source:"Source"},meaning:"Future package is grounded in pinned source"},{name:"has_acceptance",roles:{package:"Package",acceptance:"Acceptance"},meaning:"Future NOT_RUN acceptance"},{name:"maps_original_task",roles:{package:"Package",originalTask:"OriginalTask"},meaning:"Package refines historical task without changing it"},{name:"maps_original_criterion",roles:{package:"Package",originalCriterion:"OriginalCriterion"},meaning:"Package addresses historical criterion"},{name:"covers",roles:{coverage:"Coverage",package:"Package"},meaning:"Coverage disposition belongs to future package"},{name:"covers_source_record",roles:{coverage:"Coverage",source:"Source"},meaning:"Coverage record exists in pinned source"},{name:"requires",roles:{package:"Package",prerequisite:"Prerequisite"},meaning:"External authorization or evidence gate"},{name:"needed_for",roles:{prerequisite:"Prerequisite",package:"Package"},meaning:"Gate applies to future package"},{name:"includes",roles:{milestone:"Milestone",package:"Package"},meaning:"Milestone groups packages"},{name:"builds_on",roles:{package:"Package",baseline:"Baseline"},meaning:"Package uses bounded historical baseline"},{name:"derived_from",roles:{baseline:"Baseline",source:"Source"},meaning:"Baseline is attributed to pinned source"}]
const profile=parseDomainProfile({schema:"usl-domain-profile/v1",id:d+"profile",version:"1",closedMeanings:true,meanings:defs.map(x=>({id:d+x.name,allowExtraRoles:false,roles:Object.entries(x.roles).map(([role,type])=>({role,required:true,types:[d+type],metadata:[]}))}))})
const graph:ResourceGraph={schema:"usl-resource-graph/v1",resources:[],meanings:defs.map(x=>({id:d+x.name,description:x.meaning})),links:[],provenance:{sources:["input:completion-plan","input:completion-builder","user:completion-request"],activity:"activity:completion-plan",agent:"agent:completion-plan"}}
const add=(id:string,type:string,metadata:object,locator=repo(input))=>graph.resources.push({id,types:[d+type,prov+(type==="PlanActivity"?"Activity":type==="PlanAgent"?"Agent":"Entity")],locator,metadata:metadata as NonNullable<ResourceGraph["resources"][number]["metadata"]>})
add("input:completion-plan","Input",{path:input,sha256:digestSource(raw)});add("input:completion-builder","Input",{path:"scripts/build-completion-plan.ts",sha256:digestSource(await read("scripts/build-completion-plan.ts"))});add("user:completion-request","UserStatement",plan.userRequest);add("activity:completion-plan","PlanActivity",{recordedOn:plan.recordedOn,runtimeAcceptance:"NOT_RUN"});add("agent:completion-plan","PlanAgent",{authority:"SECONDARY_AI"});add(plan.id,"Plan",{authority:plan.authority,status:plan.status,sourceCommit:plan.sourceCommit,firstPackage:plan.firstPackage})
for(const [type,items] of groups)for(const item of items)add(item.id,type,item,type==="Source"?`git://github.com/gj3447/USL@${String(item.sourceCommit)}:${String(item.path)}`:repo(input))
for(const x of old.requirements)add(x.id,"OriginalRequirement",{...x,sourceCommit:oldSource.sourceCommit,sourceRecordId:x.id},`git://github.com/gj3447/USL@${oldSource.sourceCommit}:${oldSource.path}`);
for(const x of old.tasks)add(x.id,"OriginalTask",{...x,sourceCommit:oldSource.sourceCommit,sourceRecordId:x.id},`git://github.com/gj3447/USL@${oldSource.sourceCommit}:${oldSource.path}`);for(const x of old.criteria)add(x.id,"OriginalCriterion",{...x,sourceCommit:oldSource.sourceCommit,sourceRecordId:x.id},`git://github.com/gj3447/USL@${oldSource.sourceCommit}:${oldSource.path}`)
const edge:{from:string;predicate:string;to:string}[]=[];const link=(name:string,parts:Record<string,string>)=>{const def=defs.find(x=>x.name===name)!;must(def,"unknown relation");const [from,to]=Object.values(parts);must(from!==undefined&&to!==undefined,"missing endpoint");edge.push({from,predicate:name,to});graph.links.push({id:`completion-link:${graph.links.length}`,meaning:d+name,participants:Object.entries(parts).map(([role,resource])=>({role,resource})),metadata:{authority:"SECONDARY_AI",status:"PLANNING_RELATION"}})}
for (const t of old.tasks) for (const r of t.requirementIds) link("original_task_addresses", {originalTask:t.id,requirement:r})
for (const c of old.criteria) link("original_criterion_for", {originalCriterion:c.id,originalTask:c.taskId})
for (const r of old.requirements) link("requirement_source", {requirement:r.id,source:oldSource.id})
for(const p of plan.packages){p.dependsOn.forEach(q=>link("depends_on",{package:p.id,prerequisite:q}));p.conditionalDependsOn.forEach(q=>link("conditionally_depends_on",{package:p.id,prerequisite:q}));p.sourceIds.forEach(q=>link("uses_source",{package:p.id,source:q}));p.canonicalTaskIds.forEach(q=>link("maps_original_task",{package:p.id,originalTask:q}));p.criterionIds.forEach(q=>link("maps_original_criterion",{package:p.id,originalCriterion:q}));p.prerequisiteIds.forEach(q=>link("requires",{package:p.id,prerequisite:q}));for(const a of p.acceptance){add(a.id,"Acceptance",{...a,packageId:p.id});link("has_acceptance",{package:p.id,acceptance:a.id})}for(const b of plan.baselines.filter(b=>p.canonicalTaskIds.includes(b.taskId)))link("builds_on",{package:p.id,baseline:b.id})}
for(const b of plan.baselines)b.sourceIds.forEach(s=>link("derived_from",{baseline:b.id,source:s}));for(const c of plan.coverage){c.packageIds.forEach(p=>link("covers",{coverage:c.id,package:p}));link("covers_source_record",{coverage:c.id,source:c.sourceId})}for(const p of plan.prerequisites)p.neededFor.forEach(x=>link("needed_for",{prerequisite:p.id,package:x}));for(const m of plan.milestones)m.packageIds.forEach(p=>link("includes",{milestone:m.id,package:p}))
const graphRaw=text(graph),opts={namespace:"usl.completion.plan",profile};Either.getOrThrowWith(adaptResourceGraph(graphRaw,opts),e=>new Error(JSON.stringify(e)));const graphLd=Either.getOrThrowWith(resourceGraphJsonLd(graphRaw,opts),e=>new Error(JSON.stringify(e)))
const ref=(x:string)=>({"@id":x})
const accepts=plan.packages.flatMap(p=>p.acceptance.map(a=>({...a,packageId:p.id})))
const scalar=(x:Entity)=>Object.fromEntries(Object.entries(x).filter(([k,v])=>k!=="id"&&["string","number","boolean"].includes(typeof v)).map(([k,v])=>[`c:${k}`,v]))
const trace={"@context":{c:d,prov},"@graph":[
  {"@id":plan.id,"@type":["c:Plan","prov:Entity"],"c:status":plan.status,"c:authority":plan.authority,"c:sourceCommit":plan.sourceCommit,"c:firstPackage":ref(plan.firstPackage),"prov:wasGeneratedBy":ref("activity:completion-plan")},
  {"@id":"user:completion-request","@type":"c:UserStatement","c:authority":"USER_PRIMARY","c:text":plan.userRequest.text},
  ...groups.flatMap(([type,items])=>items.map(x=>({"@id":x.id,"@type":[`c:${type}`,"prov:Entity"],...scalar(x),"prov:wasAttributedTo":ref("agent:completion-plan"),"prov:wasGeneratedBy":ref("activity:completion-plan"),...("sourceIds" in x?{"prov:wasDerivedFrom":(x.sourceIds as string[]).map(ref)}:{})}))),
  ...accepts.map(x=>({"@id":x.id,"@type":["c:Acceptance","prov:Entity"],"c:execution":x.execution,"c:expectation":x.expectation,"c:negativeCase":x.negativeCase,"prov:wasAttributedTo":ref("agent:completion-plan")})),
  ...old.requirements.map(x=>({"@id":x.id,"@type":"c:OriginalRequirement",...scalar(x),"prov:wasDerivedFrom":ref(oldSource.id)})),
  ...old.tasks.map(x=>({"@id":x.id,"@type":"c:OriginalTask",...scalar(x),"prov:wasDerivedFrom":ref(oldSource.id)})),
  ...old.criteria.map(x=>({"@id":x.id,"@type":"c:OriginalCriterion",...scalar(x),"prov:wasDerivedFrom":ref(oldSource.id)})),
  {"@id":"agent:completion-plan","@type":"prov:Agent","c:authority":"SECONDARY_AI"},{"@id":"activity:completion-plan","@type":"prov:Activity","c:recordedOn":plan.recordedOn,"c:runtimeAcceptance":"NOT_RUN","prov:wasAssociatedWith":ref("agent:completion-plan"),"prov:used":[ref("user:completion-request"),...plan.sources.map(x=>ref(x.id))]},
  ...edge.map(e=>({"@id":e.from,[`c:${e.predicate}`]:ref(e.to)}))
]}
const lockOutputs:Array<[string,string]>=[[`${folder}/graph.jsonld`,text(graphLd)],[`${folder}/trace.jsonld`,text(trace)]]
const lockRows=lockOutputs.map(([path,value])=>`| \`${path}\` | \`${digestSource(value)}\` | ${Buffer.byteLength(value)} |`)
const short=(x:string)=>x.slice(x.indexOf(":")+1), cell=(x:string)=>x.replaceAll("|","\\|").replaceAll("\n"," ")
const shortList = (values: string[]) => values.map(short).join(", ") || "없음"
const ready = plan.packages.filter(p => p.dependsOn.length === 0)
const doc: string[] = [
  "# USL 미완료 작업 완료 계획", "",
  `현재 구현을 기준으로 남은 작업을 **${plan.packages.length}개 작업 묶음 · ${accepts.length}개 새 인수 조건 · ${plan.milestones.length}개 단계별 완료 기준**으로 나눴다. 첫 작업은 **${short(plan.firstPackage)}: ${first.title}**다.`, "",
  `기준 시점 ${plan.recordedOn}, 소스 Git \`${plan.sourceCommit}\`. 기존 [개발 계획](DEVELOPMENT_PLAN.md)과 [실행 기록](DEVELOPMENT_PROGRESS.md)을 보존한 후속 SECONDARY_AI 계획이다. 사용자 요청은 USER_PRIMARY로 분리했다. **미래 인수 조건은 모두 NOT_RUN**이며, 이 계획의 그래프 검증은 구현·실행 완료를 뜻하지 않는다.`, "",
  `원래 요구사항 ${old.requirements.length}개 → 과제 ${oldTasks.size}개 → 완료 조건 ${oldCriteria.size}개를 새 작업에 연결했다. 표준 평가 22개·기술 40개·control 12개도 각각 추적한다. 기존 실행 결과는 source pin으로 고정한 과거 근거이며 이번 계획에서 다시 실행한 결과가 아니다.`, "",
  "## 실행 순서와 완료 판정", "",
  "| 단계 | 작업 | 완료 기준 |", "|---|---|---|",
  ...plan.milestones.map(m => `| ${cell(m.title)} | ${shortList(m.packageIds)} | ${cell(m.gate)} |`), "",
  `우선 ${short(plan.firstPackage)} → CP02를 진행한다. 무조건 선행 작업이 없는 묶음은 ${shortList(ready.map(p => p.id))}다. 외부 자료 준비는 구현과 병렬로 할 수 있다. CP21은 복원된 outcome을 쓰는 경우 CP14를 먼저 완료해야 한다. CP23은 실제 적용 profile을 출시하는 경우 CP22를 먼저 완료해야 한다.`, "",
  "코드로 구현할 수 있는 작업과 실제 OS·장치·owner API·운영 원자료가 필요한 작업을 구분했다. 필요한 외부 조건은 아래에 책임과 확보할 근거를 명시했다. NEEDED는 요구되는 조건이며 현재 권한이 없다고 단정하는 상태가 아니다.", "",
  "## 현재 구현과 남은 범위", "",
  "| 기존 과제 | 현재 상태 | 구현된 범위 / 남은 범위 |", "|---|---|---|",
  ...plan.baselines.map(b => `| ${short(b.taskId)} | ${cell(b.status)} | ${cell(b.scope)} / ${cell(b.remaining)} |`), "",
  "## 의존 그래프", "",
  "화살표는 선행 → 후속이다. 저장된 depends_on은 후속 → 선행 방향이며 점선은 해당 사용 범위를 선택할 때 필수가 되는 조건부 의존이다.", "",
  "```mermaid", "flowchart TD",
  ...plan.packages.map(p => `  ${short(p.id)}["${short(p.id)} ${p.title}"]`),
  ...plan.packages.flatMap(p => p.dependsOn.map(q => `  ${short(q)} --> ${short(p.id)}`)),
  ...plan.packages.flatMap(p => p.conditionalDependsOn.map(q => `  ${short(q)} -. 조건부 .-> ${short(p.id)}`)),
  "```", "", "## 작업별 산출물과 인수 조건", "",
  "아래 산출물은 계획한 경로이며 파일 생성·구현 완료를 의미하지 않는다. 기존 파일이 있으면 그 파일의 수정 범위다.", ""
]
for (const p of plan.packages) doc.push(
  `### ${short(p.id)} · ${p.title}`, "", `${p.phase} / ${p.priority} / 담당 ${p.owner}. ${p.scope}`, "",
  `선행: ${shortList(p.dependsOn)}. 조건부 선행: ${shortList(p.conditionalDependsOn)}. 기존 과제: ${shortList(p.canonicalTaskIds)}.`, "",
  `원래 완료 조건: ${shortList(p.criterionIds)}.`, "",
  `산출물: ${p.plannedOutputs.map(x => "`" + x + "`").join(", ")}.`, "",
  ...p.acceptance.map(a => `- **${short(a.id)} · NOT_RUN:** ${a.expectation} **실패 반례:** ${a.negativeCase}`), "",
  `외부 조건: ${shortList(p.prerequisiteIds)}.`, ""
)
doc.push("## 외부 조건과 확보할 근거", "")
for (const p of plan.prerequisites) doc.push(
  `### ${p.title}`, "", `담당 ${p.owner}; 필요한 작업 ${shortList(p.neededFor)}.`, "", p.resolution, "", `완료 근거: ${p.completionEvidence}.`, ""
)
doc.push("## 범위 추적 장부", "", "| 분류 | 수 | 처리 계획 |", "|---|---:|---|")
for (const k of ["CRITERION", "ASSESSMENT", "TECHNOLOGY", "CONTROL"] as const)
  doc.push(`| ${k} | ${plan.coverage.filter(x => x.kind === k).length} | ${[...new Set(plan.coverage.filter(x => x.kind === k).map(x => x.disposition))].join(", ")} |`)
doc.push("", "각 원문 record ID를 하나의 coverage 항목으로 보존하고 담당 작업에 연결한다. 개수뿐 아니라 정확한 ID·source revision·hash·관계의 방향과 의미를 검사한다. 미지원 항목을 제외해 기능 완료 수를 올리지 않는다.", "", "## 그래프 계약", "",
  "관계는 아래 domain/range와 named role을 사용한다. 각 생성 링크는 두 role을 정확히 하나씩 가진다. 관계가 여러 개인 경우 별도 링크로 표현한다. 의존 관계에만 DAG를 요구한다.", "",
  "| 관계 | domain → range / 역할 | 의미 |", "|---|---|---|",
  ...defs.map(d => `| ${d.name} | ${Object.entries(d.roles).map(([role, type]) => `${role}: ${type}`).join(" → ")} | ${d.meaning} |`), "",
  "## 그래프가 답해야 할 질문", "", ...plan.competencyQuestions.map(q => `- ${q.question}`), "",
  "## 판단과 범위", "", ...plan.decisions.map(x => `- ${x}`), "",
  "설계 근거: [Git bundle](https://git-scm.com/docs/git-bundle), [Git worktree](https://git-scm.com/docs/git-worktree), [W3C RDFC](https://www.w3.org/TR/rdf-canon/), [W3C SHACL](https://www.w3.org/TR/shacl/). 소스 검토와 계획 검증은 제품 전체 적합성을 입증하지 않는다.", "",
  `[기계 판독 계획과 source pins](../${input}) · [USL 그래프](../${folder}/graph.json) · JSON-LD \`${folder}/graph.jsonld\` · 직접 RDF trace \`${folder}/trace.jsonld\` · [관계 profile](../${folder}/profile.json) · [SHACL](../schemas/completion-plan/plan.shacl.ttl).`, "",
  "두 JSON-LD 파일은 입력에서 재생성되는 산출물이라 Git에 넣지 않는다. `node --import tsx scripts/build-completion-plan.ts`로 생성하며, `--check`는 메모리에서 다시 만든 bytes의 SHA-256을 아래 lock과 비교한다(파일이 있으면 bytes도 비교).", "",
  "| 재생성 산출물 (Git 제외) | SHA-256 | bytes |", "|---|---|---|",
  ...lockRows, "",
  "## 검증 재현", "", "Python 환경에 저장소 requirements의 rdflib·pyshacl이 필요하다. 아래 검사는 미래 구현을 실행하지 않는다.", "",
  "```sh", "node --import tsx scripts/build-completion-plan.ts", "node --import tsx scripts/build-completion-plan.ts --check", "python3 -B scripts/validate-completion-plan.py", "```", ""
)
const docPath="docs/COMPLETION_PLAN.md"
const outputs:Array<[string,string]>=[[`${folder}/graph.json`,graphRaw],...lockOutputs,[`${folder}/profile.json`,text(profile)],[docPath,doc.join("\n")]]
// JSON-LD outputs are not committed; their digest lock lives in the committed generated document.
const locked=new Set(lockOutputs.map(([path])=>path)), committedDoc=check?await read(docPath):""
const hydration:Record<string,string>={}
for(const [path,value]of outputs){if(check){if(locked.has(path)){const row=committedDoc.split("\n").find(line=>line.startsWith(`| \`${path}\` |`));must(row?.includes(`\`${digestSource(value)}\``),`stale generated artifact (digest lock) ${path}`);if(existsSync(resolve(root,path))){must(await read(path)===value,`stale generated artifact ${path}`);hydration[path]="BYTES_MATCH"}else hydration[path]="NOT_HYDRATED"}else must(await read(path)===value,`stale generated artifact ${path}`)}else{await mkdir(dirname(resolve(root,path)),{recursive:true});await writeFile(resolve(root,path),value)}}
console.log(JSON.stringify({packages:plan.packages.length,coverage:plan.coverage.length,resources:graph.resources.length,links:graph.links.length,mode:check?"CHECKED":"BUILT",...(check?{hydration}:{})}))
