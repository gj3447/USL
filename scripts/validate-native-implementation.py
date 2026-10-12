#!/usr/bin/env python3
"""Independent RDF/SHACL and adversarial checks for native implementation progress."""
import json
from pathlib import Path
import subprocess
import sys

from rdflib import Graph, Literal, Namespace, RDF, URIRef
from pyshacl import validate

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "research/native-development/implementation"
NI = Namespace("urn:usl:native-implementation:")
ROLES = {"snapshotOf": ("implementation", "historical"), "derivedFrom": ("implementation", "baseline"),
         "addresses": ("implementation", "requirement"), "implementedBy": ("implementation", "code"),
         "checkedBy": ("implementation", "test"), "observedBy": ("implementation", "check")}


def main():
    subprocess.run([sys.executable, "scripts/build-native-implementation.py", "--check"], cwd=ROOT, check=True, capture_output=True)
    raw = json.loads((BASE / "graph.json").read_text())
    graph = Graph().parse(BASE / "trace.jsonld", format="json-ld")
    shapes = Graph().parse(BASE / "shapes.ttl", format="turtle")

    def conforms(candidate):
        return bool(validate(candidate, shacl_graph=shapes, inference="none", abort_on_first=False)[0])

    if not conforms(graph):
        raise AssertionError("implementation projection violates SHACL")
    work = set(graph.subjects(RDF.type, NI.ImplementationWork))
    if len(work) != 12:
        raise AssertionError("work coverage differs")
    for link in raw["links"]:
        roles = {p["role"]: p["resource"] for p in link["participants"]}
        expected = ROLES[link["meaning"]]
        if len(link["participants"]) != 2 or set(roles) != set(expected):
            raise AssertionError("unexpected USL role names or cardinality")
        source, target = [URIRef(roles[role]) for role in expected]
        if (source, NI[link["meaning"]], target) not in graph:
            raise AssertionError("USL role link lost in RDF projection")
    for resource in raw["resources"]:
        subject = URIRef(resource["id"])
        if any((subject, RDF.type, URIRef(type_)) not in graph for type_ in resource["types"]):
            raise AssertionError("resource type lost in RDF projection")
        if json.loads(str(graph.value(subject, NI.metadata))) != resource["metadata"]:
            raise AssertionError("resource metadata lost in RDF projection")
    p08, p09, p10 = NI["work:P08"], NI["work:P09"], NI["work:P10"]
    if (p08, NI.addresses, URIRef("urn:usl:dev:req:R06")) not in graph or len(list(graph.objects(p09, NI.implementedBy))) != 2 or len(list(graph.objects(p09, NI.checkedBy))) != 4:
        raise AssertionError("competency query changed delivery or dispatcher dependency evidence")
    if (p09, NI.addresses, URIRef("urn:usl:dev:req:R07")) not in graph or (p10, NI.status, Literal("PLANNED")) not in graph:
        raise AssertionError("dispatcher requirement or pending P10 changed")
    implemented = [s for s in work if (s, NI.status, Literal("IMPLEMENTED_BOUNDED")) in graph]
    if len(implemented) != 7:
        raise AssertionError("expected seven bounded, evidenced work items")
    code = graph.value(p08, NI.implementedBy)
    check = graph.value(p08, NI.observedBy)
    cases = [
        ([(p08, NI.observedBy, check)], []),
        ([(code, NI.sha256, None)], [(code, NI.sha256, Literal("sha256:invalid"))]),
        ([(p09, NI.implementedBy, None)], []),
        ([(p08, NI.checkedBy, None)], [(p08, NI.checkedBy, p09)]),
        ([(p08, NI.checkedBy, None)], [(p08, NI.checkedBy, code)]),
        ([(p08, NI.status, None)], [(p08, NI.status, Literal("ALL_ACCEPTANCE_COMPLETE"))]),
    ]
    for removals, additions in cases:
        mutated = Graph()
        for triple in graph:
            mutated.add(triple)
        for triple in removals:
            mutated.remove(triple)
        for triple in additions:
            mutated.add(triple)
        if conforms(mutated):
            raise AssertionError("adversarial implementation graph unexpectedly conforms")
    print(json.dumps({"rdf": "PARSED", "shacl": "CONFORMS", "triples": len(graph),
                      "workItems": len(work), "implementedBounded": len(implemented),
                      "roleEdgesPreserved": len(raw["links"]), "negativeCasesRejected": len(cases),
                      "claim": "LOCAL_IMPLEMENTATION_EVIDENCE_ONLY"}))


if __name__ == "__main__":
    main()
