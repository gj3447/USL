#!/usr/bin/env python3
"""Validate research coverage links; this is not a standards conformance suite."""
import copy, hashlib, json, pathlib, subprocess
from pyshacl import validate
from rdflib import BNode, Graph, Literal, Namespace, RDF, URIRef
from rdflib.collection import Collection

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE = ROOT / "research/standards-coverage"
S, USL, SH = (Namespace("urn:usl:standards-coverage:"), Namespace("urn:usl:vocab:"),
              Namespace("http://www.w3.org/ns/shacl#"))

def require(value, message):
    if not value: raise AssertionError(message)
def clone(graph):
    copy_graph = Graph()
    for triple in graph: copy_graph.add(triple)
    return copy_graph
def conforms(data, shapes):
    result, _, report = validate(data, shacl_graph=shapes)
    return result, report
def digest(path): return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
def committed_digest(commit, path):
    result = subprocess.run(["git", "show", f"{commit}:{path}"], cwd=ROOT, capture_output=True)
    return "sha256:" + hashlib.sha256(result.stdout).hexdigest() if result.returncode == 0 else None
def ids(items): return {item["id"] for item in items}
def pairs(graph, query): return {tuple(map(str, row)) for row in graph.query(query)}
def acyclic(edges):
    nodes = {node for edge in edges for node in edge}; done, active = set(), set()
    def visit(node):
        if node in active: return False
        if node in done: return True
        active.add(node); ok = all(visit(dep) for current, dep in edges if current == node); active.remove(node)
        if ok: done.add(node)
        return ok
    return all(visit(node) for node in nodes)
def coverage_identity_conforms(candidate):
    return candidate.get("schema") == "usl-standards-coverage/v1" and candidate.get("authority") == "SECONDARY_AI" and candidate.get("overallVerdict") == "NOT_A_STANDARDS_SUPERSET"

def profile_shapes(profile):
    """Compile this generated profile into SHACL over the generated USL graph."""
    shapes = Graph().parse(ROOT / "schemas/resource-graph.shacl.ttl", format="turtle")
    choices = []
    for meaning in profile["meanings"]:
        choice, meaning_path = BNode(), BNode()
        choices.append(choice)
        Collection(shapes, meaning_path, [USL.meaning, USL.nativeId])
        prop = BNode()
        shapes.add((choice, SH.property, prop)); shapes.add((prop, SH.path, meaning_path))
        shapes.add((prop, SH.hasValue, Literal(meaning["id"])))
        prop = BNode()
        shapes.add((choice, SH.property, prop)); shapes.add((prop, SH.path, USL.participant))
        shapes.add((prop, SH.minCount, Literal(len(meaning["roles"]))))
        shapes.add((prop, SH.maxCount, Literal(len(meaning["roles"]))))
        for role in meaning["roles"]:
            prop, participant, role_name, resource = (BNode() for _ in range(4))
            for triple in [
                (choice, SH.property, prop), (prop, SH.path, USL.participant),
                (prop, SH.qualifiedMinCount, Literal(1)), (prop, SH.qualifiedMaxCount, Literal(1)),
                (prop, SH.qualifiedValueShape, participant), (participant, SH.property, role_name),
                (role_name, SH.path, USL.role), (role_name, SH.hasValue, Literal(role["role"])),
                (participant, SH.property, resource), (resource, SH.path, USL.resource),
            ]:
                shapes.add(triple)
            for iri in role["types"]:
                shapes.add((resource, SH["class"], URIRef(iri)))
    choice_list = BNode(); Collection(shapes, choice_list, choices)
    shapes.add((S.CoverageBindingShape, RDF.type, SH.NodeShape))
    shapes.add((S.CoverageBindingShape, SH.targetClass, USL.Link))
    shapes.add((S.CoverageBindingShape, SH["or"], choice_list))
    return shapes

def main():
    for name in ["coverage.json", "graph.json", "graph.jsonld", "profile.json", "trace.jsonld", "probe-fixture.jsonld"]:
        hint = "NOT_HYDRATED (regenerated, not committed); run node --import tsx scripts/build-standards-coverage.ts" if name in {"graph.jsonld", "trace.jsonld"} else "missing generated standards-coverage artifact"
        require((BASE / name).is_file(), f"{hint}: research/standards-coverage/{name}")
    data = json.loads((BASE / "coverage.json").read_text())
    require(coverage_identity_conforms(data), "coverage metadata must retain the non-superset verdict")
    for field in ["sources", "localSources", "assessments", "observations", "checks", "gates", "steps"]: require(isinstance(data.get(field), list) and data[field], f"missing {field}")
    for field in ["sources", "localSources", "assessments", "observations", "checks", "gates", "steps"]: require(len(ids(data[field])) == len(data[field]), f"duplicate {field} ID")
    source_ids, local_ids, observation_ids, check_ids, assessment_ids, step_ids = (ids(data[key]) for key in ["sources", "localSources", "observations", "checks", "assessments", "steps"])
    for local in data["localSources"]:
        require(local["id"] in local_ids and local.get("sourceCommit") == data["sourceCommit"] and local.get("sha256") == committed_digest(local["sourceCommit"], local["path"]), "local source pin differs from its audited commit")
    for assessment in data["assessments"]:
        require(assessment.get("authority") == "SECONDARY_AI" and assessment.get("coverage") and assessment.get("scope") and assessment.get("limitation"), "assessment authority or limitation missing")
        require(set(assessment["sourceIds"]).issubset(source_ids) and set(assessment["localSourceIds"]).issubset(local_ids) and set(assessment["observationIds"]).issubset(observation_ids) and set(assessment["checkIds"]).issubset(check_ids) and assessment["stepId"] in step_ids, "assessment endpoint missing")
    for observation in data["observations"]:
        require(observation.get("status") == "OBSERVED" and observation.get("method") in {"PURE_RUNTIME_PROBE", "STATIC_CODE_INSPECTION"} and observation.get("scope") and observation.get("result"), "invalid observation")
        require(set(observation.get("sourcePaths", [])).issubset({item["path"] for item in data["localSources"]}), "observation source path missing")
    require(all(check.get("execution") == "NOT_RUN" and check.get("expectation") and check.get("negativeCase") for check in data["checks"]), "future acceptance check was promoted")
    gates = {item["id"]: item for item in data["gates"]}
    for gate in gates.values(): require(set(gate["assessmentIds"]).issubset(assessment_ids) and set(gate["observationIds"]).issubset(observation_ids) and gate.get("rationale"), "gate endpoint missing")
    dependencies = {(step["id"], dep) for step in data["steps"] for dep in step.get("dependsOn", [])}
    require(all(dep in step_ids for _, dep in dependencies) and acyclic(dependencies), "step dependency cycle or missing step")
    catalog_path = "research/engineering/catalog.json"
    catalog = json.loads((ROOT / catalog_path).read_text())
    technologies, controls = data.get("inheritedTechnologies", []), data.get("inheritedControls", [])
    require(len(technologies) == len(catalog["technologies"]) == 40 and len(controls) == len(catalog["controls"]) == 12, "inherited catalog must contain all technologies and controls")
    technology_by_native = {item.get("nativeId"): item for item in technologies}; control_by_native = {item.get("nativeId"): item for item in controls}
    require(len(technology_by_native) == 40 and len(control_by_native) == 12, "duplicate inherited native IDs")
    for original in catalog["technologies"]:
        item = technology_by_native.get(original["id"], {})
        require(item.get("id") == "technology:" + original["id"] and item.get("sourceCatalog") == catalog_path and item.get("upstreamExecution") == "NOT_TESTED" and item.get("controlIds") == ["control:" + value for value in original["controls"]], "inherited technology endpoints differ from catalog")
        for key, value in original.items():
            if key not in {"id", "controls"}: require(item.get(key) == value, f"inherited technology {original['id']} changed {key}")
    for original in catalog["controls"]:
        item = control_by_native.get(original["id"], {})
        require(item.get("id") == "control:" + original["id"], "inherited control ID differs from catalog")
        for key, value in original.items():
            if key != "id": require(item.get(key) == value, f"inherited control {original['id']} changed {key}")

    trace = Graph().parse(BASE / "trace.jsonld", format="json-ld")
    shapes = Graph().parse(ROOT / "schemas/standards-coverage/coverage.shacl.ttl", format="turtle")
    ok, report = conforms(trace, shapes); require(ok, str(report))
    graph_data = Graph().parse(BASE / "graph.jsonld", format="json-ld")
    profile = json.loads((BASE / "profile.json").read_text())
    ok, report = conforms(graph_data, profile_shapes(profile)); require(ok, str(report))
    expected = {
      "supportedBy": {(a["id"], x) for a in data["assessments"] for x in a["sourceIds"]},
      "inspects": {(a["id"], x) for a in data["assessments"] for x in a["localSourceIds"]} | {(o["id"], local["id"]) for o in data["observations"] for local in data["localSources"] if local["path"] in o.get("sourcePaths", [])},
      "observedBy": {(a["id"], x) for a in data["assessments"] for x in a["observationIds"]} | {(g["id"], x) for g in data["gates"] for x in g["observationIds"]},
      "requiresCheck": {(a["id"], x) for a in data["assessments"] for x in a["checkIds"]},
      "plannedIn": {(a["id"], a["stepId"]) for a in data["assessments"]},
      "evaluates": {(g["id"], x) for g in data["gates"] for x in g["assessmentIds"]},
      "dependsOn": dependencies,
    }
    for predicate, wanted in expected.items():
        actual = pairs(trace, f"PREFIX s:<urn:usl:standards-coverage:> SELECT ?a ?b WHERE {{?a s:{predicate} ?b.}}")
        require(actual == wanted, f"trace {predicate} endpoints differ from coverage input")
    inherited_edges = {("technology:" + original["id"], "control:" + control) for original in catalog["technologies"] for control in original["controls"]}
    require(pairs(trace, "PREFIX s:<urn:usl:standards-coverage:> SELECT ?a ?b WHERE {?a s:coveredBy ?b.}") == inherited_edges, "inherited technology/control endpoints differ from catalog")
    require({str(row.node) for row in trace.query("PREFIX s:<urn:usl:standards-coverage:> SELECT ?node WHERE {?node a s:AcceptanceCheck;s:execution \"NOT_RUN\".}")} == check_ids, "trace check status differs")
    require({str(row.node) for row in trace.query("PREFIX s:<urn:usl:standards-coverage:> SELECT ?node WHERE {?node a s:Assessment;s:authority \"SECONDARY_AI\".}")} == assessment_ids, "trace assessment authority differs")
    source_properties = {
        (item["id"], item["publicationStatus"], item["access"])
        for item in data["sources"]
    }
    actual_source_properties = {
        tuple(map(str, row)) for row in trace.query(
            "PREFIX s:<urn:usl:standards-coverage:> "
            "SELECT ?source ?publication ?access WHERE {"
            "?source a s:Source;s:publicationStatus ?publication;s:access ?access.}"
        )
    }
    require(actual_source_properties == source_properties, "trace source publication status or access differs")
    assessment_coverage = {(item["id"], item["coverage"]) for item in data["assessments"]}
    actual_assessment_coverage = {
        tuple(map(str, row)) for row in trace.query(
            "PREFIX s:<urn:usl:standards-coverage:> "
            "SELECT ?assessment ?coverage WHERE {?assessment a s:Assessment;s:coverage ?coverage.}"
        )
    }
    require(actual_assessment_coverage == assessment_coverage, "trace assessment coverage differs")
    observation_properties = {
        (item["id"], item["method"], item["scope"], item["result"])
        for item in data["observations"]
    }
    actual_observation_properties = {
        tuple(map(str, row)) for row in trace.query(
            "PREFIX s:<urn:usl:standards-coverage:> "
            "SELECT ?observation ?method ?scope ?result WHERE {"
            "?observation a s:Observation;s:method ?method;s:scope ?scope;s:result ?result.}"
        )
    }
    require(actual_observation_properties == observation_properties, "trace observation properties differ")
    gate_status = {(item["id"], item["status"]) for item in data["gates"]}
    actual_gate_status = {
        tuple(map(str, row)) for row in trace.query(
            "PREFIX s:<urn:usl:standards-coverage:> "
            "SELECT ?gate ?status WHERE {?gate a s:Gate;s:status ?status.}"
        )
    }
    require(actual_gate_status == gate_status, "trace gate status differs")

    fixture = Graph().parse(BASE / "probe-fixture.jsonld", format="json-ld")
    require((URIRef("https://example.test/alice"), URIRef("urn:example:knows"), URIRef("https://example.test/bob")) not in fixture, "probe fixture unexpectedly preserves a general RDF triple")
    require(any(fixture.subjects(RDF.type, USL.Link)) and any(fixture.subjects(RDF.type, USL.Meaning)) and any(fixture.subjects(USL.participant, None)), "probe fixture lacks USL JSON-LD link projection")

    bad = clone(trace); assessment = URIRef(data["assessments"][0]["id"]); edge = next(bad.objects(assessment, S.supportedBy)); bad.remove((assessment, S.supportedBy, edge)); require(not conforms(bad, shapes)[0], "missing source edge must fail")
    bad = clone(trace); bad.set((assessment, S.plannedIn, URIRef("source:wrong"))); require(not conforms(bad, shapes)[0], "wrong typed endpoint must fail")
    check = URIRef(data["checks"][0]["id"]); bad = clone(trace); bad.set((check, S.execution, Literal("PASS"))); require(not conforms(bad, shapes)[0], "promoted future check must fail")
    bad = clone(trace); bad.remove((assessment, S.limitation, None)); require(not conforms(bad, shapes)[0], "missing limitation must fail")
    step = URIRef(data["steps"][0]["id"]); bad_edges = set(dependencies) | {(str(step), str(step))}; require(not acyclic(bad_edges), "step cycle must fail")
    bad_data = copy.deepcopy(data); bad_data["overallVerdict"] = "STANDARDS_SUPERSET"; require(not coverage_identity_conforms(bad_data), "verdict promotion must fail")
    audit = next(trace.subjects(RDF.type, S.Audit), None); require(audit is not None, "trace audit is missing")
    bad = clone(trace); bad.set((audit, S.overallVerdict, Literal("STANDARDS_SUPERSET"))); require(not conforms(bad, shapes)[0], "trace verdict promotion must fail")
    gate = URIRef(data["gates"][0]["id"]); bad = clone(trace); bad.remove((gate, S.rationale, None)); require(not conforms(bad, shapes)[0], "missing gate rationale must fail")
    print(json.dumps({"rdf":"PARSED", "shacl":"CONFORMS", "competencyQueries":14, "negativeCases":8, "scope":"STANDARDS_COVERAGE_RESEARCH_NOT_RDF_OR_JSONLD_CONFORMANCE"}))

if __name__ == "__main__": main()
