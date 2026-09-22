"""Independent RDF/SHACL checks of the generated engineering review and deliberate corruptions."""
import hashlib
import json
import pathlib
from rdflib import Graph, Namespace, RDF, Literal, BNode
from pyshacl import validate

root = pathlib.Path(__file__).resolve().parents[1]
source = root / "research/engineering/graph.jsonld"
data = Graph().parse(source, format="json-ld")
shapes = Graph()
for name in ["resource-graph.shacl.ttl", "engineering-review.shacl.ttl"]:
    shapes.parse(root / "schemas" / name, format="turtle")
usl, engineering = Namespace("urn:usl:vocab:"), Namespace("urn:usl:engineering:")
conforms, _, report = validate(data, shacl_graph=shapes)
assert conforms, report
technologies = list(data.subjects(RDF.type, engineering.Technology))
assert len(technologies) == 40, len(technologies)

def copy():
    result = Graph()
    for triple in data:
        result.add(triple)
    return result

broken_type = copy()
broken_type.remove((technologies[0], RDF.type, engineering.Technology))
assert not validate(broken_type, shacl_graph=shapes, abort_on_first=True)[0], "Wrong engineering role type accepted"
link = next(data.subjects(RDF.type, usl.Link))
promoted = copy()
promoted.set((link, usl.status, Literal("PROVEN_TRUE")))
assert not validate(promoted, shacl_graph=shapes, abort_on_first=True)[0], "Declaration promoted to proven truth"
duplicate = copy()
participant = next(data.objects(link, usl.participant))
extra = BNode()
duplicate.add((link, usl.participant, extra))
for predicate, value in data.predicate_objects(participant):
    duplicate.add((extra, predicate, value))
assert not validate(duplicate, shacl_graph=shapes, abort_on_first=True)[0], "Duplicate role accepted"
print(json.dumps({"scope": "JSONLD_RDF_AND_SHACL_STRUCTURE_ONLY", "conforms": True,
    "technologies": len(technologies), "triples": len(data), "negative_cases": 3,
    "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
    "shape_sha256": {name: hashlib.sha256((root / "schemas" / name).read_bytes()).hexdigest()
        for name in ["resource-graph.shacl.ttl", "engineering-review.shacl.ttl"]}}, ensure_ascii=False))
