#!/usr/bin/env python3
"""Validate the proposed integrated development plan without claiming runtime work."""
import copy
import hashlib
import json
import pathlib
import re
import subprocess

from pyshacl import validate
from rdflib import BNode, Graph, Literal, Namespace, RDF, URIRef
from rdflib.collection import Collection

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE = ROOT / "research/development-plan"
D = Namespace("urn:usl:development-plan:")
USL = Namespace("urn:usl:vocab:")
SH = Namespace("http://www.w3.org/ns/shacl#")
QUERY_COUNT = 0
ROLE_CONTRACT = {
    "depends_on": (("task", "Task"), ("prerequisite", "Task")),
    "requires_reconciliation": (("task", "Task"), ("prerequisite", "Task")),
    "addresses": (("task", "Task"), ("requirement", "Requirement")),
    "builds_on": (("task", "Task"), ("baseline", "Baseline")),
    "motivated_by": (("task", "Task"), ("evidence", "Evidence")),
    "uses_source": (("task", "Task"), ("source", "Source")),
    "validated_by": (("task", "Task"), ("criterion", "Criterion")),
    "for_task": (("criterion", "Criterion"), ("task", "Task")),
    "recorded_in": (("evidence", "Evidence"), ("source", "Source")),
    "requirement_derived_from": (("requirement", "Requirement"), ("source", "Source")),
    "baseline_derived_from": (("baseline", "Baseline"), ("source", "Source")),
    "interprets": (("requirement", "Requirement"), ("statement", "UserStatement")),
    "includes": (("milestone", "Milestone"), ("task", "Task")),
}


def require(value, message):
    if not value:
        raise AssertionError(message)


def digest_bytes(value):
    return "sha256:" + hashlib.sha256(value).hexdigest()


def digest_file(path):
    return digest_bytes(path.read_bytes())


def ids(items):
    values = [item.get("id") for item in items]
    require(all(isinstance(value, str) and value for value in values) and len(values) == len(set(values)), "IDs must be unique nonempty strings")
    return set(values)


def acyclic(dependencies):
    complete, active = set(), set()
    def visit(node):
        if node in active or node not in dependencies:
            return False
        if node in complete:
            return True
        active.add(node)
        valid = all(visit(dependency) for dependency in dependencies[node])
        active.remove(node)
        if valid:
            complete.add(node)
        return valid
    return all(visit(node) for node in dependencies)


def list_of_ids(value, allowed):
    return isinstance(value, list) and len(value) == len(set(value)) and set(value).issubset(allowed)


def plan_conforms(plan, check_pins=False):
    if (plan.get("schema") != "usl-development-plan/v1" or plan.get("authority") != "SECONDARY_AI"
            or plan.get("status") != "PLANNED" or not isinstance(plan.get("recordedOn"), str)
            or not isinstance(plan.get("sourceCommit"), str)):
        return False
    fields = ["sources", "userStatements", "requirements", "baselines", "evidence", "tasks", "criteria", "milestones"]
    if any(not isinstance(plan.get(field), list) or not plan[field] for field in fields):
        return False
    try:
        source_ids, statement_ids, requirement_ids, baseline_ids, evidence_ids, task_ids, criterion_ids, milestone_ids = (ids(plan[field]) for field in fields)
    except AssertionError:
        return False
    if len(source_ids | statement_ids | requirement_ids | baseline_ids | evidence_ids | task_ids | criterion_ids | milestone_ids) != sum(map(len, [source_ids, statement_ids, requirement_ids, baseline_ids, evidence_ids, task_ids, criterion_ids, milestone_ids])):
        return False
    sources = plan["sources"]
    for source in sources:
        path, sha = source.get("path"), source.get("sha256")
        if (not isinstance(source.get("kind"), str) or not source["kind"] or source.get("sourceCommit") != plan["sourceCommit"]
                or not isinstance(path, str) or pathlib.PurePosixPath(path).is_absolute() or ".." in pathlib.PurePosixPath(path).parts
                or not isinstance(sha, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", sha)):
            return False
        if check_pins:
            try:
                current = digest_file(ROOT / path)
            except OSError:
                return False
            result = subprocess.run(["git", "show", f"{plan['sourceCommit']}:{path}"], cwd=ROOT, capture_output=True)
            if current != sha or result.returncode != 0 or digest_bytes(result.stdout) != sha:
                return False
    if any(item.get("authority") != "USER_PRIMARY" or not isinstance(item.get("text"), str) or not item["text"] for item in plan["userStatements"]):
        return False
    interpreted = set()
    for requirement in plan["requirements"]:
        if (requirement.get("authority") != "SECONDARY_AI" or not isinstance(requirement.get("text"), str) or not requirement["text"]
                or not list_of_ids(requirement.get("sourceIds"), source_ids) or not requirement["sourceIds"]
                or not list_of_ids(requirement.get("userStatementIds"), statement_ids) or not requirement["userStatementIds"]):
            return False
        interpreted.update(requirement["userStatementIds"])
    if interpreted != statement_ids:
        return False
    for baseline in plan["baselines"]:
        if (baseline.get("status") != "AVAILABLE_WITH_LIMITS" or any(not isinstance(baseline.get(field), str) or not baseline[field] for field in ["title", "scope", "remaining"])
                or not list_of_ids(baseline.get("sourceIds"), source_ids) or not baseline["sourceIds"]):
            return False
    for item in plan["evidence"]:
        if (any(not isinstance(item.get(field), str) or not item[field] for field in ["title", "kind", "sourceRecordId", "interpretation"])
                or item.get("sourceId") not in source_ids or item.get("replayed") is not False):
            return False
    dependencies, reconciliation_dependencies = {}, {}
    criterion_to_task = {criterion["id"]: criterion.get("taskId") for criterion in plan["criteria"]}
    for criterion in plan["criteria"]:
        if (criterion.get("taskId") not in task_ids or criterion.get("execution") != "NOT_RUN"
                or any(not isinstance(criterion.get(field), str) or not criterion[field] for field in ["expectation", "negativeCase"])):
            return False
    for task in plan["tasks"]:
        if ((task.get("status"), task.get("implementation")) != ("PLANNED", "NOT_STARTED")
                or any(not isinstance(task.get(field), str) or not task[field] for field in ["title", "owner", "priority", "phase", "scope", "remaining"])
                or not all(list_of_ids(task.get(field), allowed) for field, allowed in [("dependsOn", task_ids), ("requirementIds", requirement_ids), ("baselineIds", baseline_ids), ("evidenceIds", evidence_ids), ("sourceIds", source_ids), ("criterionIds", criterion_ids)])
                or ("restoredEvidenceDependsOn" in task and (task["id"] != "task:DG04" or not list_of_ids(task["restoredEvidenceDependsOn"], task_ids)))):
            return False
        if (not task["requirementIds"] or not task["baselineIds"] or not task["evidenceIds"] or not task["sourceIds"] or not task["criterionIds"]
                or any(criterion_to_task.get(criterion) != task["id"] for criterion in task["criterionIds"])
                or not isinstance(task.get("plannedOutputs"), list) or not task["plannedOutputs"]
                or len(task["plannedOutputs"]) != len(set(task["plannedOutputs"]))):
            return False
        if any(not isinstance(path, str) or not path or pathlib.PurePosixPath(path).is_absolute() or ".." in pathlib.PurePosixPath(path).parts for path in task["plannedOutputs"]):
            return False
        dependencies[task["id"]] = set(task["dependsOn"])
        reconciliation_dependencies[task["id"]] = set(task.get("restoredEvidenceDependsOn", []))
    if evidence_ids != {value for task in plan["tasks"] for value in task["evidenceIds"]}:
        return False
    effective_dependencies = {task: dependencies[task] | reconciliation_dependencies[task] for task in task_ids}
    if set(criterion_to_task) != {criterion for task in plan["tasks"] for criterion in task["criterionIds"]} or not acyclic(dependencies) or not acyclic(effective_dependencies):
        return False
    if plan.get("firstTask") not in task_ids or dependencies[plan["firstTask"]]:
        return False
    if set(requirement_ids) != {value for task in plan["tasks"] for value in task["requirementIds"]}:
        return False
    included = set()
    for milestone in plan["milestones"]:
        if (milestone.get("status") != "PLANNED" or any(not isinstance(milestone.get(field), str) or not milestone[field] for field in ["title", "gate"])
                or not list_of_ids(milestone.get("taskIds"), task_ids) or not milestone["taskIds"]):
            return False
        included.update(milestone["taskIds"])
    return included == task_ids


def conforms(data, shapes):
    valid, _, report = validate(data, shacl_graph=shapes)
    return valid, report


def clone(graph):
    copied = Graph()
    for triple in graph:
        copied.add(triple)
    return copied


def pairs(graph, query):
    global QUERY_COUNT
    QUERY_COUNT += 1
    return {tuple(map(str, row)) for row in graph.query(query)}


def source_strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for child in value:
            yield from source_strings(child)
    elif isinstance(value, dict):
        for child in value.values():
            yield from source_strings(child)


def history_conforms(plan):
    sources = {s["id"]: json.loads((ROOT / s["path"]).read_text())
               for s in plan["sources"] if s["path"].endswith(".json")}
    for evidence in plan["evidence"]:
        strings = set(source_strings(sources[evidence["sourceId"]]))
        if not all(record in strings for record in evidence["sourceRecordId"].split(",")):
            return False
    for suffix, field in [("worktree-audit", "findings"), ("standards-coverage", "assessments"), ("portability-research", "decisions")]:
        source_id = "source:development:" + suffix
        if {e["sourceRecordId"] for e in plan["evidence"] if e["sourceId"] == source_id} != {x["id"] for x in sources[source_id][field]}:
            return False
    current = {c["id"]: (c["taskId"], c["expectation"], c["negativeCase"]) for c in plan["criteria"]}
    for task in sources["source:development:portability-plan"]["tasks"][1:]:
        for criterion in task["acceptance"]:
            if current.get(criterion["id"]) != (task["id"], criterion["expectation"], criterion["negativeCase"]):
                return False
    for task in sources["source:development:cli-plan"]["tasks"][1:]:
        if [c["expectation"] for c in plan["criteria"] if c["taskId"] == task["id"]] != task["acceptance"]:
            return False
    pt01 = next(b for b in plan["baselines"] if b["id"] == "task:PT01")
    receipt = sources["source:development:transfer-receipt"]
    return all(pt01.get(field) == receipt[field] for field in ["implementation", "evidenceScope"])


def raw_edges_match(raw, expected):
    actual = {key: set() for key in ROLE_CONTRACT}
    link_ids = set()
    for link in raw["links"]:
        if link["id"] in link_ids or link.get("metadata") != {"authority": "SECONDARY_AI", "status": "PLANNING_RELATION"}:
            return False
        link_ids.add(link["id"])
        suffix = link["meaning"].removeprefix(str(D))
        if suffix not in ROLE_CONTRACT:
            return False
        participants = link["participants"]
        roles = dict((p["role"], p["resource"]) for p in participants)
        wanted_roles = tuple(role for role, _ in ROLE_CONTRACT[suffix])
        if len(participants) != 2 or set(roles) != set(wanted_roles):
            return False
        endpoints = tuple(roles[role] for role in wanted_roles)
        if endpoints in actual[suffix]:
            return False
        actual[suffix].add(endpoints)
    return actual == expected


def rdf_binding_rows(graph):
    return pairs(graph, """PREFIX u:<urn:usl:vocab:>
      SELECT ?linkId ?meaningId ?role ?resourceId WHERE {
        ?link a u:Link; u:nativeId ?linkId; u:meaning/u:nativeId ?meaningId; u:participant ?participant.
        ?participant u:role ?role; u:resource/u:nativeId ?resourceId.
      }""")


def profile_shapes(profile):
    shapes = Graph().parse(ROOT / "schemas/resource-graph.shacl.ttl", format="turtle")
    choices = []
    for meaning in profile["meanings"]:
        choice, meaning_path = BNode(), BNode(); choices.append(choice)
        Collection(shapes, meaning_path, [USL.meaning, USL.nativeId])
        property_shape = BNode(); shapes.add((choice, SH.property, property_shape)); shapes.add((property_shape, SH.path, meaning_path)); shapes.add((property_shape, SH.hasValue, Literal(meaning["id"])))
        property_shape = BNode(); shapes.add((choice, SH.property, property_shape)); shapes.add((property_shape, SH.path, USL.participant)); shapes.add((property_shape, SH.minCount, Literal(len(meaning["roles"])))); shapes.add((property_shape, SH.maxCount, Literal(len(meaning["roles"])) ))
        for role in meaning["roles"]:
            property_shape, participant, name, resource = (BNode() for _ in range(4))
            for triple in [(choice, SH.property, property_shape), (property_shape, SH.path, USL.participant), (property_shape, SH.qualifiedMinCount, Literal(1)), (property_shape, SH.qualifiedMaxCount, Literal(1)), (property_shape, SH.qualifiedValueShape, participant), (participant, SH.property, name), (name, SH.path, USL.role), (name, SH.hasValue, Literal(role["role"])), (participant, SH.property, resource), (resource, SH.path, USL.resource)]:
                shapes.add(triple)
            for iri in role["types"]:
                shapes.add((resource, SH["class"], URIRef(iri)))
    choices_list = BNode(); Collection(shapes, choices_list, choices)
    shapes.add((D.BindingShape, RDF.type, SH.NodeShape)); shapes.add((D.BindingShape, SH.targetClass, USL.Link)); shapes.add((D.BindingShape, SH["or"], choices_list))
    return shapes


def trace_literals(graph, predicate, nodes):
    return {(str(node), str(value)) for node, value in graph.subject_objects(D[predicate]) if str(node) in nodes}


def main():
    for name in ["plan.json", "graph.json", "graph.jsonld", "profile.json", "trace.jsonld"]:
        require((BASE / name).is_file(), f"missing generated development-plan artifact: {name}")
    plan = json.loads((BASE / "plan.json").read_text())
    require(plan_conforms(plan, check_pins=True), "development plan structure, pins, references, or planned state is invalid")
    require(history_conforms(plan), "source record, inherited coverage, criterion, or bounded baseline differs from pinned history")
    trace = Graph().parse(BASE / "trace.jsonld", format="json-ld")
    shapes = Graph().parse(ROOT / "schemas/development-plan/plan.shacl.ttl", format="turtle")
    ok, report = conforms(trace, shapes); require(ok, str(report))
    graph_data = Graph().parse(BASE / "graph.jsonld", format="json-ld")
    profile = json.loads((BASE / "profile.json").read_text())
    require(profile.get("closedMeanings") is True and len(profile["meanings"]) == len(ROLE_CONTRACT), "profile must retain closed meanings")
    for meaning in profile["meanings"]:
        name = meaning["id"].removeprefix(str(D))
        require(name in ROLE_CONTRACT and meaning["allowExtraRoles"] is False, "unknown or open profile meaning")
        require(meaning["roles"] == [{"role": role, "required": True, "types": [str(D) + kind], "metadata": []}
                                     for role, kind in ROLE_CONTRACT[name]], "profile named role contract differs")
    ok, report = conforms(graph_data, profile_shapes(profile)); require(ok, str(report))
    raw = json.loads((BASE / "graph.json").read_text())

    expected = {
        "dependsOn": {(task["id"], value) for task in plan["tasks"] for value in task["dependsOn"]},
        "requiresReconciliation": {(task["id"], value) for task in plan["tasks"] for value in task.get("restoredEvidenceDependsOn", [])},
        "addresses": {(task["id"], value) for task in plan["tasks"] for value in task["requirementIds"]},
        "buildsOn": {(task["id"], value) for task in plan["tasks"] for value in task["baselineIds"]},
        "motivatedBy": {(task["id"], value) for task in plan["tasks"] for value in task["evidenceIds"]},
        "usesSource": {(task["id"], value) for task in plan["tasks"] for value in task["sourceIds"]},
        "validatedBy": {(task["id"], value) for task in plan["tasks"] for value in task["criterionIds"]},
        "recordedIn": {(item["id"], item["sourceId"]) for item in plan["evidence"]},
        "derivedFrom": {(item["id"], source) for key in ["requirements", "baselines"] for item in plan[key] for source in item["sourceIds"]},
        "interprets": {(item["id"], statement) for item in plan["requirements"] for statement in item["userStatementIds"]},
        "includes": {(item["id"], task) for item in plan["milestones"] for task in item["taskIds"]},
        "forTask": {(item["id"], item["taskId"]) for item in plan["criteria"]},
    }
    for predicate, wanted in expected.items():
        actual = pairs(trace, f"PREFIX d:<urn:usl:development-plan:> SELECT ?a ?b WHERE {{?a d:{predicate} ?b.}}")
        require(actual == wanted, f"trace {predicate} endpoints differ from plan")
    plan_nodes = {item["id"] for collection in ["sources", "userStatements", "requirements", "baselines", "evidence", "tasks", "criteria", "milestones"] for item in plan[collection]}
    scalar_fields = set()
    for collection in ["sources", "userStatements", "requirements", "baselines", "evidence", "tasks", "criteria", "milestones"]:
        scalar_fields.update(field for item in plan[collection] for field, value in item.items()
                             if field not in {"id", "sourceId", "taskId"} and isinstance(value, (str, bool, int, float)))
    for field in scalar_fields:
        wanted = {(item["id"], str(item[field]).lower() if isinstance(item.get(field), bool) else str(item[field]))
                  for collection in ["sources", "userStatements", "requirements", "baselines", "evidence", "tasks", "criteria", "milestones"]
                  for item in plan[collection] if field in item and isinstance(item[field], (str, bool, int, float))}
        actual = trace_literals(trace, field, plan_nodes)
        require(actual == wanted, f"trace {field} literals differ from plan")
    expected_types = {
        "Source": {item["id"] for item in plan["sources"]},
        "UserStatement": {item["id"] for item in plan["userStatements"]},
        "Requirement": {item["id"] for item in plan["requirements"]},
        "Baseline": {item["id"] for item in plan["baselines"]},
        "Evidence": {item["id"] for item in plan["evidence"]},
        "Task": {item["id"] for item in plan["tasks"]},
        "Criterion": {item["id"] for item in plan["criteria"]},
        "Milestone": {item["id"] for item in plan["milestones"]},
    }
    for class_name, wanted in expected_types.items():
        actual = {row[0] for row in pairs(trace, f"PREFIX d:<urn:usl:development-plan:> SELECT ?node WHERE {{?node a d:{class_name}.}}")}
        require(actual == wanted, f"trace {class_name} class set differs from plan")
    resources = {item["id"]: item for item in raw["resources"]}
    collection_type = {"sources": "Source", "userStatements": "UserStatement", "requirements": "Requirement", "baselines": "Baseline", "evidence": "Evidence", "tasks": "Task", "criteria": "Criterion", "milestones": "Milestone"}
    for collection, class_name in collection_type.items():
        for item in plan[collection]:
            resource = resources.get(item["id"], {})
            require(resource.get("metadata") == item and set(resource.get("types", [])) == {f"urn:usl:development-plan:{class_name}", "http://www.w3.org/ns/prov#Entity"}, "resource graph entity metadata or types differ from plan")
    label = {"dependsOn": "depends_on", "requiresReconciliation": "requires_reconciliation", "buildsOn": "builds_on", "motivatedBy": "motivated_by", "usesSource": "uses_source", "validatedBy": "validated_by", "recordedIn": "recorded_in", "forTask": "for_task", "derivedFrom": None, "addresses": "addresses", "interprets": "interprets", "includes": "includes"}
    expected_raw = {label[key]: value for key, value in expected.items() if label[key] is not None}
    expected_raw["requirement_derived_from"] = {(item["id"], source) for item in plan["requirements"] for source in item["sourceIds"]}
    expected_raw["baseline_derived_from"] = {(item["id"], source) for item in plan["baselines"] for source in item["sourceIds"]}
    require(raw_edges_match(raw, expected_raw), "resource graph meaning or named role endpoints differ from plan")
    wanted_rows = {(link["id"], link["meaning"], participant["role"], participant["resource"])
                   for link in raw["links"] for participant in link["participants"]}
    require(rdf_binding_rows(graph_data) == wanted_rows, "JSON-LD binding meaning/role/native-ID rows differ from plan")
    task_ids = {item["id"] for item in plan["tasks"]}
    states = pairs(trace, "PREFIX d:<urn:usl:development-plan:> SELECT ?task ?status ?implementation WHERE {?task a d:Task;d:status ?status;d:implementation ?implementation.}")
    require(states == {(task, "PLANNED", "NOT_STARTED") for task in task_ids}, "trace task state differs")
    criteria_ids = {item["id"] for item in plan["criteria"]}
    require({row[0] for row in pairs(trace, "PREFIX d:<urn:usl:development-plan:> SELECT ?criterion WHERE {?criterion a d:Criterion;d:execution \"NOT_RUN\".}")} == criteria_ids, "trace criterion execution differs")

    bad = copy.deepcopy(plan); first = next(item for item in bad["tasks"] if item["id"] == bad["firstTask"]); first["dependsOn"] = [bad["tasks"][-1]["id"]]; bad["tasks"][-1]["dependsOn"] = [first["id"]]; require(not plan_conforms(bad), "dependency cycle must be rejected")
    bad = copy.deepcopy(plan); dg04 = next(item for item in bad["tasks"] if item["id"] == "task:DG04"); dg04["restoredEvidenceDependsOn"] = [dg04["id"]]; require(not plan_conforms(bad), "reconciliation dependency cycle must be rejected")
    bad = copy.deepcopy(plan); bad["sources"][0]["sha256"] = "sha256:" + "0" * 64; require(not plan_conforms(bad, check_pins=True), "source pin mismatch must be rejected")
    bad = copy.deepcopy(plan); bad["tasks"][0]["status"] = "COMPLETED"; require(not plan_conforms(bad), "task completion promotion must be rejected")
    bad = copy.deepcopy(plan); bad["criteria"][0]["execution"] = "PASS"; require(not plan_conforms(bad), "criterion PASS promotion must be rejected")
    bad = copy.deepcopy(plan); bad["tasks"][0]["criterionIds"] = []; require(not plan_conforms(bad), "missing criterion must be rejected")
    bad = copy.deepcopy(plan); bad["criteria"][0]["taskId"] = "task:missing"; require(not plan_conforms(bad), "orphan criterion must be rejected")
    evidence = URIRef(plan["evidence"][0]["id"]); bad_trace = clone(trace); bad_trace.remove((evidence, D.recordedIn, None)); require(not conforms(bad_trace, shapes)[0], "missing evidence source must be rejected")
    criterion = URIRef(plan["criteria"][0]["id"]); bad_trace = clone(trace); bad_trace.set((criterion, D.forTask, URIRef("task:wrong"))); require(not conforms(bad_trace, shapes)[0], "wrong criterion endpoint must be rejected")
    bad = copy.deepcopy(plan); bad["evidence"][0]["sourceRecordId"] = "nonexistent:record"; require(not history_conforms(bad), "absent source record must be rejected")
    bad = copy.deepcopy(plan); bad["evidence"] = [e for e in bad["evidence"] if e["sourceRecordId"] != "assessment:rdf-model"]; require(not history_conforms(bad), "dropped standards assessment must be rejected")
    bad = copy.deepcopy(plan); next(c for c in bad["criteria"] if c["taskId"] == "task:C02")["expectation"] = "weakened"; require(not history_conforms(bad), "weakened original CLI criterion must be rejected")
    bad = copy.deepcopy(raw); bad["links"][0]["participants"][0]["role"] = "wrong"; require(not raw_edges_match(bad, expected_raw), "wrong named role must be rejected")
    bad = copy.deepcopy(raw); bad["links"][0]["participants"][0]["resource"] = "task:DG02"; require(not raw_edges_match(bad, expected_raw), "same-class wrong endpoint must be rejected")
    bad_graph = clone(graph_data); participant = next(bad_graph.subjects(USL.role, Literal("task"))); bad_graph.set((participant, USL.role, Literal("wrong"))); require(rdf_binding_rows(bad_graph) != wanted_rows, "JSON-LD role mutation must be detected")
    print(json.dumps({"rdf": "PARSED", "shacl": "CONFORMS", "sparqlQueries": QUERY_COUNT, "negativeCases": 15, "scope": "PLANNED_DEVELOPMENT_GRAPH_ONLY_NO_RUNTIME_TEST_OR_COMPLETION_CLAIM"}))


if __name__ == "__main__":
    main()
