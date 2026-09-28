"""Structural validation of the source-definition-only binding progress graph."""
import json
import pathlib
from rdflib import Graph, Namespace, RDF
from pyshacl import validate

root = pathlib.Path(__file__).resolve().parents[1]
data = Graph().parse(root / "research/engineering/binding-progress.graph.jsonld", format="json-ld")
shapes = Graph()
for name in ["resource-graph.shacl.ttl", "current-state.shacl.ttl"]:
    shapes.parse(root / "schemas" / name, format="turtle")
conforms, _, report = validate(data, shacl_graph=shapes)
assert conforms, report
status = Namespace("urn:usl:status:")
assert len(list(data.subjects(RDF.type, status.Feature))) == 4
raw = json.loads((root / "research/engineering/binding-progress.graph.json").read_text())
resources = raw["resources"]
tests = [r for r in resources if str(status.TestEvidence) in r["types"]]
assert len(tests) == 5
assert all(r["metadata"] == {
    "path": r["metadata"]["path"], "sourceDigest": r["metadata"]["sourceDigest"],
    "evidenceKind": "TEST_DEFINITION", "execution": "NOT_CLAIMED", "finiteCoverage": "NOT_CLAIMED",
} for r in tests)
tasks = [r for r in resources if str(status.Task) in r["types"]]
assert len(tasks) == 3
assert all(r["metadata"]["status"] == "PARTIALLY_ADDRESSED_BY_CURRENT_INCREMENT" and
           r["metadata"]["acceptanceComplete"] is False and r["metadata"]["execution"] == "NOT_CLAIMED" for r in tasks)
models = [r for r in resources if str(status.FormalModel) in r["types"]]
assert len(models) == 2
assert all(r["metadata"]["runtimeRefinement"] == "NOT_ESTABLISHED" and
           r["metadata"]["proofExecution"] == "NOT_CLAIMED" for r in models)
print(json.dumps({"scope": "SOURCE_GRAPH_AND_SHACL_STRUCTURE_ONLY", "conforms": True, "features": 4,
                  "testsReplayed": False, "runtimeRefinement": "NOT_ESTABLISHED"}))
