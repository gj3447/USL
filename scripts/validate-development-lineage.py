#!/usr/bin/env python3
"""Validate generated USL development lineage as a bounded historical view."""
from __future__ import annotations
import copy, hashlib, json, subprocess, sys
from pathlib import Path
from rdflib import Graph, Namespace, RDF
from pyshacl import validate

ROOT = Path(__file__).resolve().parents[1]
DIR = ROOT / "research/development-lineage"
NS = Namespace("urn:usl:development-lineage:")
PROV = Namespace("http://www.w3.org/ns/prov#")
SHA = lambda b: "sha256:" + hashlib.sha256(b).hexdigest()

def load(name): return json.loads((DIR / name).read_text())
def git(*args): return subprocess.check_output(["git", *args], cwd=ROOT).decode()
def fail(message): raise AssertionError(message)
def ids(rows):
    values=[r["id"] for r in rows]
    if len(values) != len(set(values)): fail("duplicate resource/link ID")
def index(graph):
    ids(graph["resources"]); ids(graph["links"])
    return {r["id"]: r for r in graph["resources"]}
def type_name(resource):
    return {x.removeprefix(str(NS)) for x in resource["types"] if x.startswith(str(NS))}
def pair(link):
    return {x["role"]: x["resource"] for x in link["participants"]}
def sha_blob(commit,path): return SHA(subprocess.check_output(["git","show",f"{commit}:{path}"],cwd=ROOT))
def dag(edges, label):
    adjacent={}
    for a,b in edges: adjacent.setdefault(a,set()).add(b)
    visiting=set(); done=set()
    def walk(n):
        if n in visiting: fail(f"{label} cycle")
        if n in done:return
        visiting.add(n)
        for x in adjacent.get(n,()): walk(x)
        visiting.remove(n); done.add(n)
    for node in adjacent: walk(node)

def validate_model(catalog, graph, inventory, bindings):
    resource=index(graph); meanings={m["id"] for m in graph["meanings"]}
    profile=load("profile.json"); roles={m["id"]:{r["role"]:set(r["types"]) for r in m["roles"]} for m in profile["meanings"]}
    if meanings != set(roles): fail("meanings/profile mismatch")
    # closed typed endpoints/cardinality
    for link in graph["links"]:
        if link["meaning"] not in meanings: fail("unknown meaning")
        declared=roles[link["meaning"]]; actual=pair(link)
        if set(actual)!=set(declared) or len(actual)!=len(link["participants"]): fail("role/cardinality mismatch")
        for role, uid in actual.items():
            if uid not in resource: fail("dangling endpoint")
            if not (set(resource[uid]["types"]) & declared[role]): fail("reversed role/type endpoint")
    base=catalog["sourceCommit"]
    commits=[]
    for row in git("log","--reverse","--topo-order","--format=%H%x09%T%x09%P%x09%cI%x09%s",base).splitlines():
        c,t,p,at,subject=row.split("\t",4); commits.append({"commit":c,"tree":t,"parents":p.split(),"committedAt":at,"subject":subject,"authority":"REPOSITORY_RECORD","claim":"COMMIT_EXISTS_NOT_RUNTIME_PASS"})
    if inventory["commits"] != commits: fail("Git rev-list/inventory tuple mismatch")
    expected_commits={"commit:usl:"+x["commit"] for x in commits}
    if {k for k,v in resource.items() if "Commit" in type_name(v)} != expected_commits: fail("commit resource coverage mismatch")
    parent_links={(pair(x)["child"],pair(x)["parent"]) for x in graph["links"] if x["meaning"]==str(NS.parent)}
    expected_parent={("commit:usl:"+x["commit"],"commit:usl:"+p) for x in commits for p in x["parents"]}
    if parent_links != expected_parent: fail("commit parent exact tuple mismatch")
    dag(parent_links,"commit-parent")
    # sources are exact git blobs at their declared revision
    for uid,r in resource.items():
        if "Source" in type_name(r):
            m=r["metadata"]
            if not all(k in m for k in ("path","sourceCommit","sha256")): fail("source pin missing")
            if m["sha256"] != sha_blob(m["sourceCommit"],m["path"]): fail("source blob digest mismatch")
            if "commit:usl:"+m["sourceCommit"] not in resource: fail("source revision endpoint missing")
    # historical package/criterion mappings exactly follow pinned completion plan
    completion=json.loads(subprocess.check_output(["git","show",f"{base}:research/completion-plan/plan.json"],cwd=ROOT))
    old=json.loads(subprocess.check_output(["git","show",f"{base}:research/development-plan/plan.json"],cwd=ROOT))
    packages={x["id"]:x for x in completion["packages"]}
    if len(packages)!=23 or len(old["criteria"])!=47 or inventory["counts"].get("packages") != 23: fail("pinned plan cardinality changed")
    package_records={uid:r["metadata"] for uid,r in resource.items() if "Package" in type_name(r)}
    if package_records != packages: fail("package metadata/source exact mismatch")
    mapping={(pair(x)["package"],pair(x)["criterion"]) for x in graph["links"] if x["meaning"]==str(NS.package_criterion)}
    expected={(p["id"],c) for p in packages.values() for c in p["criterionIds"]}
    if mapping != expected: fail("package criterion exact mapping mismatch")
    if {x["id"] for x in old["criteria"]} != {uid for uid,r in resource.items() if "Criterion" in type_name(r)}: fail("criterion coverage mismatch")
    # dependencies remain planning-only and acyclic per relation
    for predicate,key in (("depends_on","dependsOn"),("conditionally_depends_on","conditionalDependsOn")):
        got={(pair(x)["package"],pair(x)["prerequisite"]) for x in graph["links"] if x["meaning"]==str(NS[predicate])}
        want={(p["id"],q) for p in packages.values() for q in p[key]}
        if got != want: fail(predicate+" exact tuple mismatch")
        dag(got,predicate)
    # Remaining work is a distinct planned view with exact roots/dependencies.
    remaining={x["id"]:x for x in catalog["remaining"]}
    remaining_records={uid:r["metadata"] for uid,r in resource.items() if "RemainingTask" in type_name(r)}
    if remaining_records != remaining: fail("remaining task metadata mismatch")
    remaining_refines={(pair(x)["task"],pair(x)["package"]) for x in graph["links"] if x["meaning"]==str(NS.refines_package)}
    if remaining_refines != {(x["id"],x["packageId"]) for x in remaining.values()}: fail("remaining package mapping mismatch")
    remaining_deps={(pair(x)["task"],pair(x)["prerequisite"]) for x in graph["links"] if x["meaning"]==str(NS.remaining_depends_on)}
    expected_remaining_deps={(x["id"],p) for x in remaining.values() for p in x["dependsOn"]}
    if remaining_deps != expected_remaining_deps: fail("remaining dependency exact tuple mismatch")
    dag(remaining_deps,"remaining-depends")
    roots={x["id"] for x in remaining.values() if not x["dependsOn"]}
    if roots != {x["id"] for x in remaining.values() if not any(a==x["id"] for a,_ in remaining_deps)}: fail("remaining root set mismatch")
    # no future acceptance status inflation
    for r in resource.values():
        if "Acceptance" in type_name(r) and r["metadata"].get("execution") != "NOT_RUN": fail("future acceptance promoted")
        if "RemainingTask" in type_name(r) and (r["metadata"].get("status"),r["metadata"].get("execution")) != ("PLANNED","NOT_RUN"): fail("remaining task promoted")
    snapshot=resource[catalog["id"]]["metadata"]
    for key,value in {"authority":"SECONDARY_AI","hswmExecution":"NOT_READY","hswmAuthority":"NOT_GRANTED","operationalLearning":"NOT_ESTABLISHED"}.items():
        if snapshot.get(key)!=value: fail("HSWM/runtime boundary inflated")
    facets={x["id"]:x for x in catalog["hswmFacets"]}
    got_facets={uid:r["metadata"] for uid,r in resource.items() if "HswmAssessment" in type_name(r)}
    if got_facets != facets: fail("HSWM facet/source coverage mismatch")
    # Selected milestones and the historical recorded run retain exact pinned tuples.
    milestone_edges={(pair(x)["milestone"],pair(x)["package"]) for x in graph["links"] if x["meaning"]==str(NS.milestone_package)}
    milestone_expected={(m["id"],p) for m in catalog["milestones"] for p in m["packageIds"]}
    if milestone_edges != milestone_expected: fail("milestone package exact tuple mismatch")
    receipt=json.loads(subprocess.check_output(["git","show",f"{base}:research/clean-git-progress/receipt.json"],cwd=ROOT))
    runs=[(uid,r) for uid,r in resource.items() if "RecordedRun" in type_name(r)]
    if len(runs)!=1: fail("recorded run cardinality mismatch")
    run_id,run=runs[0]
    if (run["metadata"].get("status"),run["metadata"].get("runtimeRerun")) != ("HISTORICAL_LOCAL_CASES_PASS","NOT_RUN"): fail("historical run inflated")
    run_sources={pair(x)["source"] for x in graph["links"] if x["meaning"]==str(NS.run_source) and pair(x)["run"]==run_id}
    if run["metadata"].get("sourceCommit") != receipt["sourceCommit"]: fail("historical run revision mismatch")
    run_commits={(pair(x)["run"],pair(x)["commit"]) for x in graph["links"] if x["meaning"]==str(NS.run_commit)}
    if run_commits != {(run_id,"commit:usl:"+receipt["sourceCommit"])}: fail("historical run commit tuple mismatch")
    run_receipts={(pair(x)["run"],pair(x)["source"]) for x in graph["links"] if x["meaning"]==str(NS.run_receipt)}
    if len(run_receipts) != 1 or next(iter(run_receipts))[0] != run_id: fail("historical receipt tuple mismatch")
    expected_pins={(p["path"],receipt["sourceCommit"],p["sha256"]) for p in receipt["sources"]}
    actual_pins={(resource[u]["metadata"]["path"],resource[u]["metadata"]["sourceCommit"],resource[u]["metadata"]["sha256"]) for u in run_sources}
    if actual_pins != expected_pins: fail("historical run source pin tuples mismatch")
    test_links=[x for x in graph["links"] if x["meaning"]==str(NS.run_test) and pair(x)["run"]==run_id]
    observed={resource[pair(x)["test"]]["metadata"]["name"] for x in test_links}
    if observed != set(receipt["tests"]) or any((resource[pair(x)["test"]]["metadata"].get("status"),resource[pair(x)["test"]]["metadata"].get("runtimeRerun")) != ("HISTORICAL_PASS","NOT_RUN") for x in test_links): fail("historical test exact tuple/status mismatch")
    test_accept={(resource[pair(x)["test"]]["metadata"]["name"],pair(x)["acceptance"]) for x in graph["links"] if x["meaning"]==str(NS.test_acceptance)}
    if test_accept != {(name,"acceptance:"+name.split(":",1)[0]) for name in receipt["tests"]}: fail("historical test acceptance mapping mismatch")
    # Snapshot is a navigable entrypoint, with all edges bounded by catalog IDs.
    snapshot_pairs=[(x["meaning"].removeprefix(str(NS)),pair(x)) for x in graph["links"] if pair(x).get("snapshot")==catalog["id"]]
    snapshot_single={name:p for name,p in snapshot_pairs if name in {"snapshot_subject","snapshot_request","snapshot_next"}}
    if snapshot_single.get("snapshot_subject",{}).get("subject") != "sym:Concept:usl" or snapshot_single.get("snapshot_request",{}).get("statement") != catalog["userRequest"]["id"] or snapshot_single.get("snapshot_next",{}).get("task") != catalog["nextTask"]: fail("snapshot entrypoint tuple mismatch")
    milestones={p["milestone"] for name,p in snapshot_pairs if name=="snapshot_milestone"}
    facets_at_snapshot={p["assessment"] for name,p in snapshot_pairs if name=="snapshot_facet"}
    if milestones != {x["id"] for x in catalog["milestones"]} or facets_at_snapshot != {x["id"] for x in catalog["hswmFacets"]}: fail("snapshot coverage tuple mismatch")
    scope=json.loads(subprocess.check_output(["git","show",f"{base}:research/architecture/hswm-like.plan.json"],cwd=ROOT))
    expected_statements={catalog["userRequest"]["id"]:catalog["userRequest"], **{x["id"]:x for x in scope["scopeCorrections"]}}
    actual_statements={uid:r["metadata"] for uid,r in resource.items() if "UserStatement" in type_name(r)}
    if actual_statements != expected_statements: fail("USER_PRIMARY statement source/text mismatch")
    # all graph resources have one binding and selection
    bound={x["id"] for x in bindings["resources"]}
    if bound != set(resource): fail("binding resource coverage mismatch")
    return resource

def rdf_checks(trace, graph, catalog):
    data=Graph().parse(data=json.dumps(trace),format="json-ld")
    shapes=Graph().parse(ROOT/"schemas/development-lineage/lineage.shacl.ttl",format="turtle")
    ok,_,report=validate(data_graph=data,shacl_graph=shapes,advanced=True,allow_infos=False,allow_warnings=False)
    if not ok: fail("SHACL failed: "+str(report))
    def query(q): return {tuple(str(v) for v in row) for row in data.query(q,initNs={"l":NS,"prov":PROV})}
    # Trace is checked against the native graph projection, then every CQ checks exact tuples.
    expected_relationships={(x["participants"][0]["resource"],x["participants"][1]["resource"],x["meaning"].removeprefix(str(NS))) for x in graph["links"]}
    parents=query("SELECT ?c ?p WHERE { ?c l:parent ?p }")
    relationships=query("SELECT ?f ?t ?p WHERE { ?r a l:Relationship; l:from ?f; l:to ?t; l:predicate ?p }")
    if relationships != expected_relationships: fail("trace/native graph relationship tuple mismatch")
    if parents != {(f,t) for f,t,p in expected_relationships if p=="parent"}: fail("CQ parent tuple mismatch")
    for predicate in ("milestone_commit","milestone_source","milestone_package","package_criterion","depends_on","conditionally_depends_on","facet_source","statement_source","run_commit","run_receipt","run_source","run_test","test_acceptance"):
        direct=query(f"SELECT ?a ?b WHERE {{ ?a l:{predicate} ?b }}")
        rel={(f,t) for f,t,p in relationships if p==predicate}
        if direct != rel: fail("CQ exact relationship mismatch: "+predicate)
    users=query('SELECT ?u WHERE { ?u a l:UserStatement; l:authority "USER_PRIMARY" }')
    agents=query('SELECT ?a WHERE { ?a a l:Agent; l:authority "SECONDARY_AI" }')
    if ("user:usl-lineage-request-2026-10-07",) not in users or agents != {("agent:usl-lineage",)}: fail("CQ authority tuples mismatch")
    prov=query("SELECT ?a ?agent ?input WHERE { ?a a prov:Activity; prov:wasAssociatedWith ?agent; prov:used ?input }")
    if prov != {("activity:usl-lineage","agent:usl-lineage","input:usl-lineage:catalog")}: fail("CQ PROV tuple mismatch")
    return len(data), len(relationships)

def must_reject(label, mutate, catalog, graph, inventory, bindings):
    c,g,i,b=map(copy.deepcopy,(catalog,graph,inventory,bindings)); mutate(c,g,i,b)
    try: validate_model(c,g,i,b)
    except AssertionError: return
    fail("negative mutation accepted: "+label)

def must_reject_shacl(label, mutate, trace):
    value=copy.deepcopy(trace); mutate(value)
    data=Graph().parse(data=json.dumps(value),format="json-ld")
    shapes=Graph().parse(ROOT/"schemas/development-lineage/lineage.shacl.ttl",format="turtle")
    ok,_,_=validate(data_graph=data,shacl_graph=shapes,advanced=True,allow_infos=False,allow_warnings=False)
    if ok: fail("SHACL mutation accepted: "+label)

def main():
    subprocess.run([sys.executable,"scripts/build-development-lineage.py","--check"],cwd=ROOT,check=True,capture_output=True,text=True)
    catalog,graph,inventory,bindings,trace=map(load,["catalog.json","graph.json","inventory.json","bindings.json","trace.jsonld"])
    resource=validate_model(catalog,graph,inventory,bindings)
    triples,relationships=rdf_checks(trace,graph,catalog)
    # Actual adversarial mutations, not counted comments.
    must_reject("missing-parent",lambda c,g,i,b:g["links"].__delitem__(next(n for n,x in enumerate(g["links"]) if x["meaning"]==str(NS.parent))),catalog,graph,inventory,bindings)
    must_reject("missing-source-pin",lambda c,g,i,b:next(x for x in g["resources"] if "Source" in type_name(x))["metadata"].pop("sha256"),catalog,graph,inventory,bindings)
    def reversed_roles(c,g,i,b):
        link=next(x for x in g["links"] if x["meaning"]==str(NS.milestone_source))
        left,right=link["participants"]
        link["participants"]=[{"role":"milestone","resource":right["resource"]},{"role":"source","resource":left["resource"]}]
    must_reject("reversed-milestone-source-roles",reversed_roles,catalog,graph,inventory,bindings)
    must_reject("dangling",lambda c,g,i,b:next(x for x in g["links"] if x["meaning"]==str(NS.parent))["participants"].__setitem__(0,{"role":"child","resource":"missing"}),catalog,graph,inventory,bindings)
    must_reject("duplicate-id",lambda c,g,i,b:g["resources"].append(copy.deepcopy(g["resources"][0])),catalog,graph,inventory,bindings)
    must_reject("future-pass",lambda c,g,i,b:next(x for x in g["resources"] if "Acceptance" in type_name(x))["metadata"].__setitem__("execution","PASS"),catalog,graph,inventory,bindings)
    must_reject("hswm-ready",lambda c,g,i,b:next(x for x in g["resources"] if x["id"]==c["id"])["metadata"].__setitem__("hswmExecution","READY"),catalog,graph,inventory,bindings)
    must_reject("weight-learned",lambda c,g,i,b:next(x for x in g["resources"] if x["id"]=="assessment:usl-hswm:weight-learning")["metadata"].__setitem__("status","CANONICAL_W_LEARNED"),catalog,graph,inventory,bindings)
    def cycle(c,g,i,b):
        p=next(x for x in g["resources"] if "Package" in type_name(x))["id"]
        g["links"].append({"id":"mut-cycle","meaning":str(NS.depends_on),"participants":[{"role":"package","resource":p},{"role":"prerequisite","resource":p}],"metadata":{}})
    must_reject("dependency-cycle",cycle,catalog,graph,inventory,bindings)
    # Mutate RDF itself: these prove the shapes are executed, not merely loaded.
    must_reject_shacl("shacl-source-pin", lambda t: next(x for x in t["@graph"] if str(NS.Source) in x.get("@type",[])).pop("l:sha256"), trace)
    must_reject_shacl("shacl-future-acceptance", lambda t: next(x for x in t["@graph"] if str(NS.Acceptance) in x.get("@type",[])).__setitem__("l:execution","PASS"), trace)
    must_reject_shacl("shacl-snapshot-ready", lambda t: next(x for x in t["@graph"] if str(NS.Snapshot) in x.get("@type",[])).__setitem__("l:hswmExecution","READY"), trace)
    must_reject_shacl("shacl-snapshot-w-learned", lambda t: next(x for x in t["@graph"] if str(NS.Snapshot) in x.get("@type",[])).__setitem__("l:operationalLearning","W_LEARNED"), trace)
    print(json.dumps({"status":"PASS","commits":len(inventory["commits"]),"packages":23,"criteria":47,"resources":len(graph["resources"]),"links":len(graph["links"]),"rdfTriples":triples,"relationships":relationships,"negativeMutations":13},ensure_ascii=False))
if __name__=="__main__": main()
