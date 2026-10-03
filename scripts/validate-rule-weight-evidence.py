"""Independent SHACL and connected-SPARQL checks for the synthetic owner-review trace."""
import hashlib, json, pathlib
from rdflib import BNode, Graph, Literal, Namespace, RDF, URIRef
from rdflib.collection import Collection
from pyshacl import validate

root = pathlib.Path(__file__).resolve().parents[1]
USL, RW, RP, STATUS, SH, OWL = (Namespace(value) for value in ["urn:usl:vocab:", "urn:usl:rule-weight-evidence:", "urn:usl:rule-policy:", "urn:usl:status:", "http://www.w3.org/ns/shacl#", "http://www.w3.org/2002/07/owl#"])
def conforms(data, shapes):
    result, _, report = validate(data, shacl_graph=shapes)
    return result, report
def clone(data):
    result = Graph()
    for triple in data: result.add(triple)
    return result

typed = Graph().parse(root / "examples/fixtures/rule-weight-evidence/trace.jsonld", format="json-ld")
typed_shapes = Graph().parse(root / "schemas/rule-weight-evidence/trace.shacl.ttl", format="turtle")
ok, report = conforms(typed, typed_shapes); assert ok, report

# 1. A hard gate is never a weighted coefficient; all assignments name soft penalty rules.
hard = {str(row.rule) for row in typed.query("""PREFIX rw:<urn:usl:rule-weight-evidence:> SELECT ?rule WHERE {?rule a rw:Rule; rw:requirement "REQUIRED"; rw:onViolation "BLOCK"}""")}
assert hard == {"urn:example:rule:references"}
soft = list(typed.query("""PREFIX rw:<urn:usl:rule-weight-evidence:> SELECT ?a ?rule ?weight WHERE {?a a rw:WeightAssignment;rw:forRule ?rule;rw:weight ?weight. ?rule rw:requirement "RECOMMENDED";rw:onViolation "PENALIZE"}"""))
assert len(soft) == 4 and {float(row.weight) for row in soft} == {0.1, 0.2, 0.8, 0.9}

# 2. One actual RDF path binds baseline policy -> evaluation -> Evidence -> proposal -> candidate policy.
trace = list(typed.query("""PREFIX rw:<urn:usl:rule-weight-evidence:>
 SELECT ?baseline ?evaluation ?evidence ?outcome ?proposal ?candidate ?context ?action WHERE {
 ?evaluation a rw:Evaluation;rw:forPolicy ?baseline.
 ?evidence a rw:Evidence;rw:recordsEvaluation ?evaluation;rw:recordsOutcome ?outcome;rw:inContext ?context;rw:recordsAction ?action.
 ?proposal a rw:WeightRevisionProposal;rw:baseline ?baseline;rw:candidate ?candidate;rw:evidence ?evidence;rw:inContext ?context;rw:proposalState "OWNER_REVIEW_REQUIRED";rw:effectiveness "NOT_ESTABLISHED".
 ?outcome a rw:Outcome. ?action a rw:Action. ?baseline a rw:PolicySnapshot. ?candidate a rw:PolicySnapshot.
 }"""))
fixture = json.loads((root / "examples/fixtures/rule-weight-evidence/fixture.json").read_text())
expected = (
 f"trace:policy:{fixture['policy']['id']}:v{fixture['policy']['version']}",
 next(iter(typed.subjects(RDF.type, RW.Evaluation))).__str__(), fixture["evidence"]["id"], f"{fixture['evidence']['id']}:outcome",
 fixture["proposalInput"]["id"], f"trace:policy:{fixture['proposal']['candidatePolicy']['id']}:v{fixture['proposal']['candidatePolicy']['version']}",
 fixture["evidence"]["context"]["id"], fixture["evidence"]["action"]["id"],
)
assert {tuple(map(str, row)) for row in trace} == {expected}, trace

# 3. Action participant role, ordinal, and source version/digest pins survive the RDF projection.
action_pins = list(typed.query("""PREFIX rw:<urn:usl:rule-weight-evidence:>
 SELECT ?role ?ordinal ?source ?version ?digest WHERE { ?action a rw:Action;rw:participant ?p. ?p rw:role ?role;rw:ordinal ?ordinal;rw:source ?source;rw:sourceVersion ?version;rw:sourceDigest ?digest }"""))
expected_pins = {(item["role"], str(item["ordinal"]), item["source"]["id"], item["source"]["version"], item["source"]["digest"]) for item in fixture["evidence"]["action"]["participants"]}
assert {tuple(map(str, row)) for row in action_pins} == expected_pins

graph_data = Graph().parse(root / "research/rule-weight-evidence/graph.jsonld", format="json-ld")
raw = json.loads((root / "research/rule-weight-evidence/graph.json").read_text())
# 4. The exact graph link takes Evidence (not proposal) only to an unconnected candidate W concept.
candidate = list(graph_data.query("""PREFIX usl:<urn:usl:vocab:> SELECT ?signal ?concept WHERE {
 ?link usl:meaning/usl:nativeId "urn:usl:rule-weight-evidence:candidate_input_to";usl:participant ?s,?w.
 ?s usl:role "signal";usl:resource/usl:nativeId ?signal. ?w usl:role "wConcept";usl:resource/usl:nativeId ?concept.}"""))
assert {tuple(map(str, row)) for row in candidate} == {("urn:example:rule-weight-evidence:dashboard-outcome", "urn:usl:hswm:w-concept")}
def candidate_contract(payload):
    rows = [row for row in payload["links"] if row["meaning"] == str(RW.candidate_input_to)]
    return len(rows) == 1 and rows[0]["metadata"] == {"authority":"NOT_GRANTED","canonicalMapping":"NOT_CONNECTED","relationship":"CANDIDATE_INPUT_ONLY","status":"PROPOSED"}
assert candidate_contract(raw)

# 5. The same proposal/context has one connected offline review/report/dataset/replay path.
reviews = list(typed.query("""PREFIX rw:<urn:usl:rule-weight-evidence:>
 SELECT ?proposal ?context ?review ?dataset ?report ?replay WHERE {
 ?proposal a rw:WeightRevisionProposal;rw:inContext ?context.
 ?review a rw:LearnerReview;rw:reviewsProposal ?proposal;rw:inContext ?context;
   rw:usesDataset ?dataset;rw:usesReport ?report;rw:usesReplay ?replay;
   rw:reviewStatus "REVIEW_READY";rw:disposition "REVIEW_ONLY_NOT_APPLIED";rw:dataKind "SYNTHETIC".
 ?dataset rw:inContext ?context. ?report rw:derivedFrom ?dataset. ?replay rw:verifiedReport ?report.
 }"""))
assert {tuple(map(str, row)) for row in reviews} == {(fixture["proposalInput"]["id"], fixture["evidence"]["context"]["id"], "trace:learner:review", "trace:learner:dataset", "trace:learner:report", "trace:learner:replay")}
# Raw-file pins are recomputed independently, not inferred from RDF labels.
for name in ["dataset", "report", "replay", "review"]:
    source = root / f"examples/fixtures/rule-weight-review/{name}.json"
    digest = "sha256:" + hashlib.sha256(source.read_bytes()).hexdigest()
    assert str(typed.value(URIRef(f"trace:learner:{name}"), RW.digest)) == digest
    resource = next(item for item in raw["resources"] if item["id"] == f"trace:learner:{name}")
    assert resource["metadata"]["sourceDigest"] == digest
review_links = [item for item in raw["links"] if item["meaning"] == str(RW.reviewed_with_learner)]
assert len(review_links) == 1
assert {item["role"]: item["resource"] for item in review_links[0]["participants"]} == {
    "proposal": fixture["proposalInput"]["id"], "context": fixture["evidence"]["context"]["id"],
    **{name: f"trace:learner:{name}" for name in ["dataset", "report", "replay", "review"]},
}
assert review_links[0]["metadata"] == {"reviewStatus": "REVIEW_READY", "disposition": "REVIEW_ONLY_NOT_APPLIED", "operationalEfficacy": "NOT_ESTABLISHED", "authority": "NOT_GRANTED"}
execution = json.loads((root / "research/rule-weight-evidence/learner-execution.json").read_text())
for section in ["artifactPins", "consumerSourcePins"]:
    for path, digest in execution[section].items():
        assert digest == "sha256:" + hashlib.sha256((root / path).read_bytes()).hexdigest(), path
assert execution["validation"]["inputDigest"] == str(typed.value(URIRef("trace:learner:dataset"), RW.inputDigest)).removeprefix("sha256:")

# Independently translate exact role cardinality/domain/range from the published profile.
shapes = Graph().parse(root / "schemas/resource-graph.shacl.ttl", format="turtle")
profile = json.loads((root / "research/rule-weight-evidence/profile.json").read_text()); choices = []
for meaning in profile["meanings"]:
    node=BNode(); choices.append(node); path=BNode(); Collection(shapes,path,[USL.meaning,USL.nativeId])
    p=BNode(); shapes.add((node,SH.property,p)); shapes.add((p,SH.path,path)); shapes.add((p,SH.hasValue,Literal(meaning["id"])))
    p=BNode(); shapes.add((node,SH.property,p)); shapes.add((p,SH.path,USL.participant)); shapes.add((p,SH.minCount,Literal(len(meaning["roles"])))); shapes.add((p,SH.maxCount,Literal(len(meaning["roles"]))))
    for role in meaning["roles"]:
        p, part, name, resource = (BNode() for _ in range(4))
        for triple in [(node,SH.property,p),(p,SH.path,USL.participant),(p,SH.qualifiedMinCount,Literal(1)),(p,SH.qualifiedMaxCount,Literal(1)),(p,SH.qualifiedValueShape,part),(part,SH.property,name),(name,SH.path,USL.role),(name,SH.hasValue,Literal(role["role"])),(part,SH.property,resource),(resource,SH.path,USL.resource)]: shapes.add(triple)
        for type_iri in role["types"]: shapes.add((resource,SH["class"],URIRef(type_iri)))
collection=BNode(); Collection(shapes,collection,choices); shapes.add((RW.BindingShape,RDF.type,SH.NodeShape)); shapes.add((RW.BindingShape,SH.targetClass,USL.Link)); shapes.add((RW.BindingShape,SH["or"],collection))
ok, report = conforms(graph_data,shapes); assert ok,report

# Negatives: pin/type/role/equivalence/hard-rule and missing connected path are all rejected.
context=next(typed.subjects(RDF.type,RW.Context)); bad=clone(typed); bad.remove((context,RW.digest,None)); assert not conforms(bad,typed_shapes)[0]
assignment=next(typed.subjects(RDF.type,RW.WeightAssignment)); bad=clone(typed); bad.set((assignment,RW.forRule,URIRef("urn:example:rule:references"))); assert not conforms(bad,typed_shapes)[0]
bad=clone(typed); bad.add((URIRef("urn:bad"),OWL.sameAs,URIRef("urn:usl:hswm:w-concept"))); assert not conforms(bad,typed_shapes)[0]
evidence=URIRef(fixture["evidence"]["id"]); bad=clone(typed); bad.remove((evidence,RW.recordsOutcome,None)); assert not bool(bad.query("""PREFIX rw:<urn:usl:rule-weight-evidence:> ASK {?p a rw:WeightRevisionProposal;rw:evidence ?e. ?e rw:recordsEvaluation ?v;rw:recordsOutcome ?o}""").askAnswer)
evaluation = next(typed.subjects(RDF.type, RW.Evaluation)); target = next(typed.objects(evaluation, RW.target)); bad = clone(typed); bad.set((evaluation, RW.target, URIRef("urn:usl:target:wrong"))); assert not bool(bad.query(f"""PREFIX rw:<urn:usl:rule-weight-evidence:> ASK {{ <{evaluation}> rw:target <{target}> }}""").askAnswer)
participant = next(typed.objects(next(typed.subjects(RDF.type, RW.Action)), RW.participant)); bad = clone(typed); bad.remove((participant, RW.sourceDigest, None)); assert not conforms(bad, typed_shapes)[0]
role=next(graph_data.subjects(USL.role,Literal("wConcept"))); bad=clone(graph_data); bad.set((role,USL.role,Literal("wrongRole"))); assert not conforms(bad,shapes)[0]
changed=json.loads(json.dumps(raw)); next(row for row in changed["links"] if row["meaning"]==str(RW.candidate_input_to))["metadata"]["status"]="APPLIED"; assert not candidate_contract(changed)
review_node = URIRef("trace:learner:review")
bad = clone(typed); bad.set((review_node, RW.inContext, URIRef("urn:wrong:context"))); assert not conforms(bad, typed_shapes)[0]
bad = clone(typed); bad.set((review_node, RW.reportDigest, Literal("sha256:" + "0" * 64))); assert not conforms(bad, typed_shapes)[0]
bad = clone(typed); bad.set((review_node, RW.disposition, Literal("APPLIED"))); assert not conforms(bad, typed_shapes)[0]
bad = clone(typed); bad.set((URIRef("trace:learner:report"), RW.inputDigest, Literal("sha256:" + "0" * 64))); assert not conforms(bad, typed_shapes)[0]
assert any(resource["id"]=="standard:shacl-2017" and resource["metadata"]["checkedOn"]=="2026-10-03" for resource in raw["resources"])
for resource in raw["resources"]:
    if str(STATUS.TestEvidence) not in resource["types"]: continue
    expected_execution = "OBSERVED_LOCAL_SYNTHETIC" if resource["id"] == "trace:learner:execution" else "NOT_CLAIMED"
    assert resource["metadata"].get("execution") == expected_execution
print(json.dumps({"rdf":"PARSED","shacl":"CONFORMS","competencyQueries":5,"negativeCases":12,"scope":"SYNTHETIC_PROPOSAL_AND_OFFLINE_LEARNER_REVIEW_NO_LIVE_APPLY_OR_CANONICAL_W"}))
