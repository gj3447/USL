"""Independently parse the CLI's JSON-LD and validate the USL declaration shapes."""
import json
import pathlib
import subprocess
from rdflib import Graph, Namespace, RDF, BNode, Literal
from pyshacl import validate

root = pathlib.Path(__file__).resolve().parents[1]
output = subprocess.check_output([
    "node", str(root / "dist/src/cli.js"), "adapt", "--format", "resource-graph",
    "--graph", str(root / "examples/fixtures/resource-graph.json"),
    "--namespace", "standard.example", "--operation", "jsonld",
], cwd=root, text=True, timeout=30)
data = Graph().parse(data=output, format="json-ld")
shapes = Graph().parse(root / "schemas/resource-graph.shacl.ttl", format="turtle")
conforms, _, report = validate(data, shacl_graph=shapes)
assert conforms, report
usl = Namespace("urn:usl:vocab:")
links = list(data.subjects(RDF.type, usl.Link))
assert links
broken = Graph()
for triple in data:
    broken.add(triple)
broken.remove((links[0], usl.meaning, None))
assert not validate(broken, shacl_graph=shapes)[0], "Missing meaning was accepted"
duplicate = Graph()
for triple in data:
    duplicate.add(triple)
participant = next(data.objects(links[0], usl.participant))
copy = BNode()
duplicate.add((links[0], usl.participant, copy))
for predicate, value in data.predicate_objects(participant):
    duplicate.add((copy, predicate, value))
assert not validate(duplicate, shacl_graph=shapes)[0], "Duplicate role was accepted"
print(json.dumps({"jsonld": "PARSED", "shacl": "CONFORMS", "triples": len(data),
                  "links": len(links), "negative_cases": 2}))
