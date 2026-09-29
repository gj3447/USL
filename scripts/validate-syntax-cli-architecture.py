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
    if any(r["metadata"].get("status") != "PROPOSED" or r["metadata"].get("authority") != "SECONDARY_AI" for r in proposals): return False
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
assert conforms(raw)
assert claims_conform(raw)
def clone(): return json.loads(json.dumps(raw))
broken_ref = clone(); broken_ref["links"][0]["participants"][0]["resource"] = "missing:resource"
assert not conforms(broken_ref)
broken_role = clone(); broken_role["links"][0]["participants"][0]["role"] = "wrong_role"
assert not conforms(broken_role)
wrong_proposal_claim = clone()
for resource in wrong_proposal_claim["resources"]:
    if resource["id"] == "proposal:m-map": resource["metadata"]["status"] = "IMPLEMENTED_CURRENT_SOURCE"
assert not claims_conform(wrong_proposal_claim)
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
print(json.dumps({"scope":"ARCHITECTURE_GRAPH_STRUCTURE_AND_COMPETENCY_QUERIES_ONLY","resources":len(resources),"links":len(links),"triples":len(data),"negative_cases":6,"graph_sha256":hashlib.sha256(graph_path.read_bytes()).hexdigest()}, ensure_ascii=False))
