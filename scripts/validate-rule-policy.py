"""Independent RDF/SHACL and competency-query checks; no runtime effect claims."""
import json
import pathlib
from rdflib import BNode, Graph, Literal, Namespace, RDF, URIRef, XSD
from rdflib.collection import Collection
from pyshacl import validate

root = pathlib.Path(__file__).resolve().parents[1]
USL, RP, SH, STATUS = (Namespace(value) for value in [
    "urn:usl:vocab:", "urn:usl:rule-policy:", "http://www.w3.org/ns/shacl#", "urn:usl:status:"])
policy_data = Graph().parse(root / "examples/fixtures/rule-policy/policy.jsonld", format="json-ld")
policy_shapes = Graph().parse(root / "schemas/rule-policy/policy.shacl.ttl", format="turtle")


def conforms(data, shapes):
    result, _, report = validate(data, shacl_graph=shapes)
    return result, report


def clone(data):
    copy = Graph()
    for triple in data:
        copy.add(triple)
    return copy


ok, report = conforms(policy_data, policy_shapes)
assert ok, report
rules = {str(row.rule): (str(row.requirement), str(row.action), float(row.weight)) for row in policy_data.query("""
    PREFIX rp: <urn:usl:rule-policy:>
    SELECT ?rule ?requirement ?action ?weight WHERE {
      ?policy a rp:Policy ; rp:rule ?rule .
      ?rule rp:requirement ?requirement ; rp:onViolation ?action ; rp:weight ?weight .
    }
""")}
assert rules == {
    "urn:example:rule:references": ("REQUIRED", "BLOCK", 0.0),
    "urn:example:rule:sources": ("RECOMMENDED", "PENALIZE", 0.8),
    "urn:example:rule:tags": ("RECOMMENDED", "PENALIZE", 0.2),
}, rules
hard, soft = URIRef("urn:example:rule:references"), URIRef("urn:example:rule:sources")
for subject, predicate, value in [
    (hard, RP.onViolation, Literal("WARN")),
    (hard, RP.weight, Literal(0.5, datatype=XSD.double)),
    (soft, RP.weight, Literal(-1, datatype=XSD.double)),
    (soft, RP.weight, Literal(2, datatype=XSD.double)),
    (soft, RP.weight, Literal(0, datatype=XSD.double)),
    (soft, RP.evaluatorVersion, None),
]:
    broken = clone(policy_data)
    broken.remove((subject, predicate, None))
    if value is not None:
        broken.add((subject, predicate, value))
    assert not conforms(broken, policy_shapes)[0], (subject, predicate, value)

data = Graph().parse(root / "research/rule-policy/graph.jsonld", format="json-ld")
shapes = Graph().parse(root / "schemas/resource-graph.shacl.ttl", format="turtle")
profile = json.loads((root / "research/rule-policy/profile.json").read_text())
# Independent translation of the published domain/range and cardinality contract.
alternatives = []
for meaning in profile["meanings"]:
    shape = BNode()
    alternatives.append(shape)
    constraint, path = BNode(), BNode()
    Collection(shapes, path, [USL.meaning, USL.nativeId])
    shapes.add((shape, SH.property, constraint))
    shapes.add((constraint, SH.path, path))
    shapes.add((constraint, SH.hasValue, Literal(meaning["id"])))
    count = BNode()
    shapes.add((shape, SH.property, count))
    shapes.add((count, SH.path, USL.participant))
    shapes.add((count, SH.minCount, Literal(len(meaning["roles"]))))
    shapes.add((count, SH.maxCount, Literal(len(meaning["roles"]))))
    for role in meaning["roles"]:
        prop, participant, name, resource = (BNode() for _ in range(4))
        for triple in [
            (shape, SH.property, prop), (prop, SH.path, USL.participant),
            (prop, SH.qualifiedMinCount, Literal(1)), (prop, SH.qualifiedMaxCount, Literal(1)),
            (prop, SH.qualifiedValueShape, participant), (participant, SH.property, name),
            (name, SH.path, USL.role), (name, SH.hasValue, Literal(role["role"])),
            (participant, SH.property, resource), (resource, SH.path, USL.resource),
        ]:
            shapes.add(triple)
        for type_iri in role["types"]:
            shapes.add((resource, SH["class"], URIRef(type_iri)))
choices = BNode()
Collection(shapes, choices, alternatives)
shapes.add((RP.BindingsShape, RDF.type, SH.NodeShape))
shapes.add((RP.BindingsShape, SH.targetClass, USL.Link))
shapes.add((RP.BindingsShape, SH["or"], choices))
ok, report = conforms(data, shapes)
assert ok, report
rows = list(data.query("""
    PREFIX usl: <urn:usl:vocab:>
    SELECT ?rule ?target ?consumer WHERE {
      ?link usl:meaning/usl:nativeId "urn:usl:addon:applies_binding_rule" ; usl:participant ?r, ?t, ?c .
      ?r usl:role "rule" ; usl:resource/usl:nativeId ?rule .
      ?t usl:role "target" ; usl:resource/usl:nativeId ?target .
      ?c usl:role "consumer" ; usl:resource/usl:nativeId ?consumer .
    }
"""))
assert {tuple(map(str, row)) for row in rows} == {
    (rule, "example:dashboard-memory", "example:dashboard-consumer") for rule in rules
}
trace = list(data.query("""
    PREFIX usl: <urn:usl:vocab:>
    SELECT ?artifact WHERE {
      ?origin usl:meaning/usl:nativeId "urn:usl:status:informed_by" ; usl:participant ?ot, ?os .
      ?ot usl:role "task" ; usl:resource ?task .
      ?os usl:role "source" ; usl:resource/usl:nativeId "trace:request" .
      ?realized usl:meaning/usl:nativeId "urn:usl:rule-policy:realized_by" ; usl:participant ?rt, ?rf .
      ?rt usl:role "task" ; usl:resource ?task .
      ?rf usl:role "feature" ; usl:resource ?feature .
      ?implementation usl:meaning/usl:nativeId "urn:usl:status:implemented_by" ; usl:participant ?if, ?ia .
      ?if usl:role "feature" ; usl:resource ?feature .
      ?ia usl:role "artifact" ; usl:resource/usl:nativeId ?artifact .
    }
"""))
assert "artifact:src/addons/rule-policy.ts" in {str(row.artifact) for row in trace}
role_node = next(data.subjects(USL.role, Literal("consumer")))
broken = clone(data)
broken.set((role_node, USL.role, Literal("wrong_role")))
assert not conforms(broken, shapes)[0], "Wrong binding role accepted"
test_node = next(data.subjects(RDF.type, STATUS.TestEvidence))
broken = clone(data)
broken.remove((test_node, RDF.type, STATUS.TestEvidence))
assert not conforms(broken, shapes)[0], "Missing test evidence type accepted"
raw = json.loads((root / "research/rule-policy/graph.json").read_text())
assert all(r["metadata"]["execution"] == "NOT_CLAIMED" for r in raw["resources"] if str(STATUS.TestEvidence) in r["types"])
assert any(r["id"] == "trace:request" and r["metadata"]["authority"] == "USER_PRIMARY" for r in raw["resources"])
assert any(r["id"] == "trace:agent" and r["metadata"]["authority"] == "SECONDARY_AI" for r in raw["resources"])
print(json.dumps({"rdf": "PARSED", "shacl": "CONFORMS", "competencyQueries": 3,
                  "negativeCases": 8, "scope": "POLICY_AND_ROLE_STRUCTURE_NOT_RUNTIME_EFFECTS"}))
