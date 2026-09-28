"""Independent checks of the dated review's RDF structure and proof-scope separation."""
import hashlib
import json
import pathlib
from rdflib import Graph, Namespace, RDF, Literal
from pyshacl import validate

root = pathlib.Path(__file__).resolve().parents[1]
source = root / "research/engineering/current-state.graph.jsonld"
data = Graph().parse(source, format="json-ld")
shapes = Graph()
for name in ["resource-graph.shacl.ttl", "current-state.shacl.ttl"]:
    shapes.parse(root / "schemas" / name, format="turtle")
conforms, _, report = validate(data, shacl_graph=shapes)
assert conforms, report
usl, status = Namespace("urn:usl:vocab:"), Namespace("urn:usl:status:")
features = list(data.subjects(RDF.type, status.Feature))
tasks = list(data.subjects(RDF.type, status.Task))
assert len(features) == 7 and len(tasks) == 6

def copy():
    result = Graph()
    for triple in data:
        result.add(triple)
    return result

model = next(data.subjects(RDF.type, status.FormalModel))
model_as_runtime = copy()
model_as_runtime.remove((model, RDF.type, status.FormalModel))
model_as_runtime.add((model, RDF.type, status.Feature))
assert not validate(model_as_runtime, shacl_graph=shapes, abort_on_first=True)[0], "Runtime feature accepted as formal model"
promoted = copy()
link = next(data.subjects(RDF.type, usl.Link))
promoted.set((link, usl.status, Literal("PROVEN_TRUE")))
assert not validate(promoted, shacl_graph=shapes, abort_on_first=True)[0], "Declaration promoted to proven truth"

raw = json.loads((root / "research/engineering/current-state.graph.json").read_text())
by_id = {r["id"]: r for r in raw["resources"]}
dependencies = {r["id"]: [] for r in raw["resources"] if str(status.Task) in r["types"]}
for edge in raw["links"]:
    if edge["meaning"] == str(status.depends_on):
        participants = {p["role"]: p["resource"] for p in edge["participants"]}
        dependencies[participants["task"]].append(participants["prerequisite"])

def visit(task, stack):
    assert task not in stack, "Task dependency cycle"
    assert by_id[task]["metadata"]["status"] == "PROPOSED"
    for parent in dependencies[task]:
        visit(parent, stack | {task})

for task in dependencies:
    visit(task, set())
assert by_id["feature:cli"]["metadata"]["leanCoverage"] == "NOT_ESTABLISHED"
assert by_id["feature:bindings"]["metadata"]["leanCoverage"] == "NOT_ESTABLISHED"
assert by_id["evidence:lean"]["metadata"]["scope"] == "LEAN_ABSTRACT_GRAPH_MODEL_ONLY"
print(json.dumps({"scope": "RDF_SHACL_AND_REVIEW_TRACEABILITY_ONLY", "conforms": True,
    "features": len(features), "proposed_tasks": len(tasks), "triples": len(data), "negative_cases": 2,
    "task_dependencies": "ACYCLIC", "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest()}))
