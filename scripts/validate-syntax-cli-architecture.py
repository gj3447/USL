"""Validate current/proposed architecture claims, RDF projection and SHACL role constraints."""
import hashlib, json, pathlib
from rdflib import Graph, Namespace, RDF, Literal
from pyshacl import validate

root = pathlib.Path(__file__).resolve().parents[1]
graph_path = root / "research/architecture/syntax-cli.graph.json"
jsonld_path = root / "research/architecture/syntax-cli.graph.jsonld"
shape_path = root / "research/architecture/syntax-cli.shacl.ttl"
raw = json.loads(graph_path.read_text())
profile = json.loads((root / "research/architecture/syntax-cli.profile.json").read_text())
catalog = json.loads((root / "research/architecture/syntax-cli.catalog.json").read_text())
work_plan_path = root / "research/architecture/hswm-like.plan.json"
work_plan = json.loads(work_plan_path.read_text())
resources = {r["id"]: r for r in raw["resources"]}
links = raw["links"]
assert len(resources) >= 25 and len(links) >= 20
assert resources["user:syntax-cli"]["metadata"]["authority"] == "USER_PRIMARY"
assert resources["user:weighted-hypergraph"]["metadata"]["authority"] == "USER_PRIMARY"
assert any(l["meaning"].endswith("trace") and len(l["participants"]) == 3 for l in links)
assert all("sourceDigest" in r.get("metadata", {}) for r in resources.values() if r["id"].startswith("artifact:"))
assert all("file://" not in r["locator"] for r in resources.values())
jsonld = json.loads(jsonld_path.read_text())
assert "@graph" in jsonld and any("usl:Link" in n.get("@type", []) for n in jsonld["@graph"])
shapes = shape_path.read_text()
assert "ArchitectureRoleShape" in shapes and "qualifiedMinCount 1" in shapes
for path, pin in catalog["sourcePins"].items():
    artifact = resources["artifact:" + path]
    assert artifact["metadata"]["sourceDigest"] == pin
    assert artifact["locator"].startswith("git://github.com/gj3447/USL@" + catalog["sourceCommit"] + ":")
assert resources["source:hswm-plan"]["metadata"]["sourceDigest"] == "sha256:" + hashlib.sha256(work_plan_path.read_bytes()).hexdigest()
assert resources["user:hswm-plan"]["metadata"] == {"status":"USER_PRIMARY", "text":work_plan["userRequest"]["text"], "authority":"USER_PRIMARY", "locationStatus":"DECLARED_PUBLIC_LOCATION", "remoteObservation":"NOT_PERFORMED"}
for correction in work_plan.get("scopeCorrections", []):
    assert resources[correction["id"]]["metadata"]["authority"] == "USER_PRIMARY"
rules = {m["id"]: m for m in profile["meanings"]}
def conforms(candidate):
    known = {r["id"]: set(r["types"]) for r in candidate["resources"]}
    for item in candidate["links"]:
        rule = rules.get(item["meaning"])
        if rule is None: return False
        participants = {p["role"]: p.get("resource") for p in item["participants"]}
        if len(participants) != len(item["participants"]): return False
        if not rule["allowExtraRoles"] and set(participants) != {r["role"] for r in rule["roles"]}: return False
        for role in rule["roles"]:
            resource = participants.get(role["role"])
            if role["required"] and resource not in known: return False
            if resource and not set(role["types"]).issubset(known[resource]): return False
    return True
def claims_conform(candidate):
    by_id = {r["id"]: r for r in candidate["resources"]}
    current = [r for r in by_id.values() if "urn:usl:syntax-cli:ImplementedFeature" in r["types"]]
    proposals = [r for r in by_id.values() if "urn:usl:syntax-cli:Proposal" in r["types"]]
    if not current or not proposals: return False
    if any(r["metadata"].get("status") != "IMPLEMENTED_CURRENT_SOURCE" for r in current): return False
    if any(r["metadata"].get("status") != "PROPOSED" or r["metadata"].get("authority") != "SECONDARY_AI" or r["metadata"].get("placement") not in {"ADDON_RESPONSIBILITY", "MINIMAL_BINDING_CLI"} for r in proposals): return False
    def participants(link): return {p["role"]: p["resource"] for p in link["participants"]}
    implementation = [l for l in candidate["links"] if l["meaning"].endswith("implemented_by")]
    for feature in current:
        bound = [participants(l).get("artifact") for l in implementation if participants(l).get("feature") == feature["id"]]
        if not bound or any(not artifact or artifact not in by_id or not by_id[artifact]["id"].startswith("artifact:") or "sourceDigest" not in by_id[artifact].get("metadata", {}) for artifact in bound): return False
    addressed = [l for l in candidate["links"] if l["meaning"].endswith("addresses")]
    for proposal in proposals:
        matched = [l for l in addressed if participants(l).get("proposal") == proposal["id"]]
        if not matched or any(l.get("metadata", {}).get("authority") != "SECONDARY_AI" or participants(l).get("requirement") not in by_id or by_id[participants(l)["requirement"]].get("metadata", {}).get("authority") != "USER_PRIMARY" for l in matched): return False
    return True
def task_dag_acyclic(graph):
    seen, visiting = set(), set()
    def visit(task):
        if task in visiting: return False
        if task in seen: return True
        visiting.add(task)
        ok = all(dep in graph and visit(dep) for dep in graph[task])
        visiting.remove(task)
        if ok: seen.add(task)
        return ok
    return all(visit(task) for task in graph)

def planned_work_conforms(candidate):
    by_id = {r["id"]: r for r in candidate["resources"]}
    plan_tasks = work_plan["tasks"]
    if len({t["id"] for t in plan_tasks}) != len(plan_tasks): return False
    if any(t["status"] != "PLANNED" or t["implementation"] != "NOT_STARTED" or t["proofStatus"] != "NOT_PROVEN" or not t["acceptance"] or not t["deliverables"] for t in plan_tasks): return False
    if any(by_id.get(t["id"], {}).get("metadata", {}).get("status") != "PLANNED" or by_id.get(t["id"], {}).get("metadata", {}).get("implementation") != "NOT_STARTED" or by_id.get(t["id"], {}).get("metadata", {}).get("proofStatus") != "NOT_PROVEN" for t in plan_tasks): return False
    links_by_meaning = {}
    for link in candidate["links"]: links_by_meaning.setdefault(link["meaning"].split(":")[-1], []).append(link)
    def parts(link): return {p["role"]: p["resource"] for p in link["participants"]}
    for task in plan_tasks:
        criterion = "criterion:" + task["id"].split(":", 1)[1]
        if by_id.get(criterion, {}).get("metadata", {}).get("checks") != task["acceptance"]: return False
        work = [l for l in links_by_meaning.get("planned_work", []) if parts(l).get("task") == task["id"]]
        if {parts(l).get("requirement") for l in work} != set(task["requirements"]) or any(parts(l).get("criterion") != criterion or l.get("metadata", {}).get("authority") != "SECONDARY_AI" for l in work): return False
        deps = [parts(l).get("prerequisite") for l in links_by_meaning.get("task_depends_on", []) if parts(l).get("task") == task["id"]]
        if set(deps) != set(task["dependsOn"]): return False
    graph = {t["id"]: t["dependsOn"] for t in plan_tasks}
    return task_dag_acyclic(graph)
assert conforms(raw)
assert claims_conform(raw)
assert planned_work_conforms(raw)
def clone(): return json.loads(json.dumps(raw))
broken_ref = clone(); broken_ref["links"][0]["participants"][0]["resource"] = "missing:resource"
assert not conforms(broken_ref)
broken_role = clone(); broken_role["links"][0]["participants"][0]["role"] = "wrong_role"
assert not conforms(broken_role)
wrong_proposal_claim = clone()
for resource in wrong_proposal_claim["resources"]:
    if resource["id"] == "proposal:m-map": resource["metadata"]["status"] = "IMPLEMENTED_CURRENT_SOURCE"
assert not claims_conform(wrong_proposal_claim)
cycle = {task["id"]: list(task["dependsOn"]) for task in work_plan["tasks"]}
cycle["task:P01"].append("task:P03")
assert not task_dag_acyclic(cycle)
missing_criterion = clone()
missing_criterion["resources"] = [r for r in missing_criterion["resources"] if r["id"] != "criterion:P01"]
assert not planned_work_conforms(missing_criterion)
false_completed = clone()
for resource in false_completed["resources"]:
    if resource["id"] == "task:P01": resource["metadata"]["status"] = "COMPLETED"
assert not planned_work_conforms(false_completed)
# Query the actual JSON-LD projection and run both shared and task-specific shapes.
data = Graph().parse(jsonld_path, format="json-ld")
shape_graph = Graph().parse(root / "schemas/resource-graph.shacl.ttl", format="turtle")
shape_graph.parse(shape_path, format="turtle")
assert validate(data, shacl_graph=shape_graph)[0]
usl, prov = Namespace("urn:usl:vocab:"), Namespace("http://www.w3.org/ns/prov#")
links_rdf = list(data.subjects(RDF.type, usl.Link))
assert links_rdf
def native(node): return str(next(data.objects(node, usl.nativeId)))
meaning_ids = {native(next(data.objects(link, usl.meaning))) for link in links_rdf}
assert {"urn:usl:syntax-cli:interpreted_as", "urn:usl:syntax-cli:addresses", "urn:usl:syntax-cli:trace"}.issubset(meaning_ids)
trace = next(link for link in links_rdf if native(next(data.objects(link, usl.meaning))).endswith("trace"))
assert len(list(data.objects(trace, usl.participant))) == 3
assert any(data.triples((None, RDF.type, prov.Activity))) and any(data.triples((None, RDF.type, prov.Agent)))
assert any(link["meaning"].endswith("interpreted_as") and link.get("metadata", {}).get("authority") == "SECONDARY_AI" for link in links)
assert any(link["meaning"].endswith("addresses") and link["participants"][0]["resource"] == "proposal:graph-cli" and link["participants"][1]["resource"] == "user:syntax-cli" for link in links)
task_resources = [r for r in resources.values() if "urn:usl:syntax-cli:Task" in r["types"]]
assert [r["id"] for r in sorted(task_resources, key=lambda r: r["metadata"]["order"])] == ["task:P01", "task:P02", "task:P03"]
assert min(task_resources, key=lambda r: r["metadata"]["order"])["id"] == "task:P01"
task_meta = {r["id"]: r["metadata"] for r in task_resources}
assert task_meta["task:P02"]["dependsOn"] == ["task:P01"]
assert task_meta["task:P03"]["dependsOn"] == ["task:P02"]
for proposal in ["proposal:weighted-assertion", "proposal:hierarchy", "proposal:m-map"]:
    assert resources[proposal]["metadata"]["placement"] == "ADDON_RESPONSIBILITY"
for boundary in ["limitation:weights", "limitation:m-map", "limitation:hierarchy"]:
    assert resources[boundary]["metadata"]["status"] == "SCOPE_BOUNDARY"
def copy_graph():
    result = Graph()
    for triple in data: result.add(triple)
    return result
broken_ref_rdf = copy_graph(); participant = next(broken_ref_rdf.objects(links_rdf[0], usl.participant)); broken_ref_rdf.remove((participant, usl.resource, None))
assert not validate(broken_ref_rdf, shacl_graph=shape_graph, abort_on_first=True)[0]
broken_role_rdf = copy_graph(); participant = next(broken_role_rdf.objects(links_rdf[0], usl.participant)); broken_role_rdf.set((participant, usl.role, Literal("wrong_role")))
assert not validate(broken_role_rdf, shacl_graph=shape_graph, abort_on_first=True)[0]
wrong_status_rdf = copy_graph(); wrong_status_rdf.set((links_rdf[0], usl.status, Literal("IMPLEMENTED_AND_PROVEN")))
assert not validate(wrong_status_rdf, shacl_graph=shape_graph, abort_on_first=True)[0]
print(json.dumps({"scope":"ARCHITECTURE_GRAPH_STRUCTURE_AND_COMPETENCY_QUERIES_ONLY","resources":len(resources),"links":len(links),"tasks":len(task_resources),"triples":len(data),"negative_cases":9,"graph_sha256":hashlib.sha256(graph_path.read_bytes()).hexdigest()}, ensure_ascii=False))
