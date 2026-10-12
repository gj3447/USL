#!/usr/bin/env python3
"""Validate the proposed portability work plan; it makes no implementation claim."""
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
PLAN_PATH = ROOT / "research/portability-plan/plan.json"
BASE = ROOT / "research/portability-plan"
P = Namespace("urn:usl:portability-plan:")
USL = Namespace("urn:usl:vocab:")
SH = Namespace("http://www.w3.org/ns/shacl#")

EXPECTED_DEPS = {
    "task:PT01": set(), "task:PT02": {"task:PT01"},
    "task:PT03": {"task:PT01", "task:PT02"},
    "task:PT04": {"task:PT01", "task:PT02", "task:PT03"},
    "task:PT05": {"task:PT01", "task:PT03", "task:PT04"},
    "task:PT06": {"task:PT01", "task:PT02", "task:PT03", "task:PT04"},
    "task:PT07": {"task:PT03", "task:PT06"},
}
EXPECTED_MILESTONES = {
    "milestone:MVP": {"task:PT01", "task:PT02", "task:PT03", "task:PT04"},
    "milestone:FOLLOW_UP": {"task:PT05", "task:PT06", "task:PT07"},
}


def digest_bytes(value):
    return "sha256:" + hashlib.sha256(value).hexdigest()


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def acyclic(dependencies):
    seen, active = set(), set()
    def visit(task):
        if task in active or task not in dependencies:
            return False
        if task in seen:
            return True
        active.add(task)
        valid = all(visit(dep) for dep in dependencies[task])
        active.remove(task)
        if valid:
            seen.add(task)
        return valid
    return all(visit(task) for task in dependencies)


def plan_conforms(plan, check_pins=False):
    if plan.get("schema") != "usl-portability-work-plan/v1" or plan.get("authority") != "SECONDARY_AI":
        return False
    if plan.get("status") != "PLANNED" or not isinstance(plan.get("sourceCommit"), str):
        return False
    requirements, tasks, milestones = plan.get("requirements", []), plan.get("tasks", []), plan.get("milestones", [])
    requirement_ids = [item.get("id") for item in requirements]
    task_ids = [item.get("id") for item in tasks]
    milestone_ids = [item.get("id") for item in milestones]
    if (len(requirement_ids) != len(set(requirement_ids)) or len(task_ids) != len(set(task_ids))
            or len(milestone_ids) != len(set(milestone_ids)) or set(task_ids) != set(EXPECTED_DEPS)):
        return False
    if any(item.get("authority") != "SECONDARY_AI" for item in requirements):
        return False
    sources = plan.get("currentSources", [])
    if (not sources or len({item.get("id") for item in sources}) != len(sources)
            or len({item.get("path") for item in sources}) != len(sources)
            or any(item.get("sourceCommit") != plan["sourceCommit"]
                   or not isinstance(item.get("sha256"), str)
                   or not re.fullmatch(r"sha256:[a-f0-9]{64}", item["sha256"])
                   for item in sources)):
        return False
    dependencies = {item["id"]: set(item.get("dependsOn", [])) for item in tasks}
    if dependencies != EXPECTED_DEPS or not acyclic(dependencies):
        return False
    if {item["id"]: set(item.get("tasks", [])) for item in milestones} != EXPECTED_MILESTONES:
        return False
    criteria = set()
    for task in tasks:
        if (task.get("status"), task.get("implementation"), task.get("proofStatus")) != ("PLANNED", "NOT_STARTED", "NOT_PROVEN"):
            return False
        if (not task.get("plannedOutputs") or len(task["plannedOutputs"]) != len(set(task["plannedOutputs"]))
                or any(pathlib.PurePosixPath(path).is_absolute() or ".." in pathlib.PurePosixPath(path).parts
                       for path in task["plannedOutputs"])):
            return False
        task_criteria = task.get("acceptance", [])
        if not task_criteria or {item.get("requirement") for item in task_criteria} != set(task.get("requirements", [])):
            return False
        for criterion in task_criteria:
            if (criterion.get("id") in criteria or criterion.get("requirement") not in requirement_ids
                    or criterion.get("execution") != "NOT_RUN" or not isinstance(criterion.get("expectation"), str)
                    or not criterion["expectation"] or not isinstance(criterion.get("negativeCase"), str) or not criterion["negativeCase"]):
                return False
            criteria.add(criterion["id"])
    if set(requirement_ids) != {requirement for task in tasks for requirement in task.get("requirements", [])}:
        return False
    if any(item.get("status") != "PLANNED" for item in milestones):
        return False
    if check_pins:
        for source in sources:
            path = source.get("path")
            if not isinstance(path, str) or pathlib.PurePosixPath(path).is_absolute() or ".." in pathlib.PurePosixPath(path).parts:
                return False
            # Historical plan snapshot: verify bytes at the recorded commit, not the working tree.
            if source.get("sourceCommit") != plan["sourceCommit"]:
                return False
            result = subprocess.run(["git", "show", f"{plan['sourceCommit']}:{path}"], cwd=ROOT, capture_output=True)
            if result.returncode != 0 or source["sha256"] != digest_bytes(result.stdout):
                return False
    return True


def rdf_conforms(data, shapes):
    result, _, report = validate(data, shacl_graph=shapes)
    return result, report


def values(graph, subject, predicate):
    return {str(value) for value in graph.objects(URIRef(subject), predicate)}


def profile_shapes(profile):
    shapes = Graph().parse(ROOT / "schemas/resource-graph.shacl.ttl", format="turtle")
    choices = []
    for meaning in profile["meanings"]:
        node, path = BNode(), BNode(); choices.append(node)
        Collection(shapes, path, [USL.meaning, USL.nativeId])
        prop = BNode(); shapes.add((node, SH.property, prop)); shapes.add((prop, SH.path, path)); shapes.add((prop, SH.hasValue, Literal(meaning["id"])))
        prop = BNode(); shapes.add((node, SH.property, prop)); shapes.add((prop, SH.path, USL.participant)); shapes.add((prop, SH.minCount, Literal(len(meaning["roles"])))); shapes.add((prop, SH.maxCount, Literal(len(meaning["roles"]))))
        for role in meaning["roles"]:
            prop, participant, name, resource = (BNode() for _ in range(4))
            for triple in [(node, SH.property, prop), (prop, SH.path, USL.participant), (prop, SH.qualifiedMinCount, Literal(1)), (prop, SH.qualifiedMaxCount, Literal(1)), (prop, SH.qualifiedValueShape, participant), (participant, SH.property, name), (name, SH.path, USL.role), (name, SH.hasValue, Literal(role["role"])), (participant, SH.property, resource), (resource, SH.path, USL.resource)]:
                shapes.add(triple)
            for iri in role["types"]:
                shapes.add((resource, SH["class"], URIRef(iri)))
    choices_list = BNode(); Collection(shapes, choices_list, choices)
    shapes.add((P.BindingShape, RDF.type, SH.NodeShape)); shapes.add((P.BindingShape, SH.targetClass, USL.Link)); shapes.add((P.BindingShape, SH["or"], choices_list))
    return shapes


def main():
    for name in ["graph.json", "graph.jsonld", "profile.json", "trace.jsonld"]:
        require((BASE / name).is_file(), f"missing generated portability-plan artifact: {name}")
    plan = json.loads(PLAN_PATH.read_text())
    require(plan_conforms(plan, check_pins=True), "plan structure, source pins, DAG, coverage, or PLANNED state is invalid")

    trace = Graph().parse(BASE / "trace.jsonld", format="json-ld")
    typed_shapes = Graph().parse(ROOT / "schemas/portability-plan/plan.shacl.ttl", format="turtle")
    ok, report = rdf_conforms(trace, typed_shapes); require(ok, str(report))
    graph_data = Graph().parse(BASE / "graph.jsonld", format="json-ld")
    profile = json.loads((BASE / "profile.json").read_text())
    ok, report = rdf_conforms(graph_data, profile_shapes(profile)); require(ok, str(report))
    raw = json.loads((BASE / "graph.json").read_text())

    task_map = {item["id"]: item for item in plan["tasks"]}
    expected_criteria = {(task["id"], criterion["id"], criterion["requirement"]) for task in plan["tasks"] for criterion in task["acceptance"]}
    query = """PREFIX p:<urn:usl:portability-plan:> SELECT ?task ?criterion ?requirement WHERE {?task a p:Task;p:acceptance ?criterion;p:addresses ?requirement. ?criterion p:forTask ?task;p:forRequirement ?requirement.}"""
    actual_criteria = {(str(row.task), str(row.criterion), str(row.requirement)) for row in trace.query(query)}
    require(actual_criteria == expected_criteria, "criterion/task/requirement graph coverage differs from plan")
    actual_deps = {(str(row.task), str(row.dep)) for row in trace.query("PREFIX p:<urn:usl:portability-plan:> SELECT ?task ?dep WHERE {?task a p:Task;p:dependsOn ?dep.}")}
    actual_deps = {(task, tuple(sorted(dep for current, dep in actual_deps if current == task))) for task in task_map}
    require(actual_deps == {(task, tuple(sorted(deps))) for task, deps in EXPECTED_DEPS.items()}, "task dependency graph differs from plan")
    actual_milestones = {(str(row.task), str(row.milestone)) for row in trace.query("PREFIX p:<urn:usl:portability-plan:> SELECT ?task ?milestone WHERE {?task a p:Task;p:milestone ?milestone.}")}
    expected_milestones = {(task, milestone) for milestone, tasks in EXPECTED_MILESTONES.items() for task in tasks}
    require(actual_milestones == expected_milestones, "task milestones differ from plan")
    states = {(str(row.task), str(row.status), str(row.implementation), str(row.proof)) for row in trace.query("PREFIX p:<urn:usl:portability-plan:> SELECT ?task ?status ?implementation ?proof WHERE {?task a p:Task;p:status ?status;p:implementation ?implementation;p:proofStatus ?proof.}")}
    require(states == {(task, "PLANNED", "NOT_STARTED", "NOT_PROVEN") for task in task_map}, "task trace promotes planned work")
    requirements = {item["id"] for item in plan["requirements"]}
    require({str(row.requirement) for row in trace.query("PREFIX p:<urn:usl:portability-plan:> SELECT ?requirement WHERE {?requirement a p:Requirement;p:authority \"SECONDARY_AI\".}")} == requirements, "requirement authority set differs from plan")
    outputs = {(str(row.task), str(row.artifact)) for row in trace.query("PREFIX p:<urn:usl:portability-plan:> SELECT ?task ?artifact WHERE {?task a p:Task;p:plannedOutput ?artifact.}")}
    expected_outputs = {(task["id"], "planned:" + path) for task in plan["tasks"] for path in task["plannedOutputs"]}
    require(outputs == expected_outputs, "planned output graph coverage differs from plan")

    resources = {item["id"]: item for item in raw["resources"]}
    for task in plan["tasks"]:
        resource = resources.get(task["id"], {})
        require(set(resource.get("types", [])) == {"urn:usl:status:Task"} and all(resource.get("metadata", {}).get(key) == task[key] for key in ["status", "implementation", "proofStatus"]), "task resource metadata differs from plan")
        for criterion in task["acceptance"]:
            resource = resources.get(criterion["id"], {})
            require(set(resource.get("types", [])) == {"urn:usl:status:AcceptanceCriterion"} and resource.get("metadata") == criterion, "criterion resource metadata differs from plan")
    for source in plan["currentSources"]:
        resource = resources.get(source["id"], {})
        metadata = resource.get("metadata", {})
        require({"urn:usl:status:Source", "urn:usl:status:Artifact"}.issubset(set(resource.get("types", []))) and all(metadata.get(key) == value for key, value in source.items()) and metadata.get("remoteObservation") == "NOT_PERFORMED", "source resource pin differs from plan")
    def parts(link): return {item["role"]: item["resource"] for item in link["participants"]}
    expected_links = set()
    for task in plan["tasks"]:
        expected_links |= {("urn:usl:portability-plan:addresses", task["id"], requirement) for requirement in task["requirements"]}
        expected_links |= {("urn:usl:portability-plan:depends_on", task["id"], prerequisite) for prerequisite in task["dependsOn"]}
        expected_links |= {("urn:usl:portability-plan:planned_output", task["id"], "planned:" + output) for output in task["plannedOutputs"]}
        expected_links |= {("urn:usl:portability-plan:reuses", task["id"], source) for source in task["reuses"]}
        expected_links |= {("urn:usl:portability-plan:informed_by", task["id"], source) for source in task["informedBy"]}
        expected_links |= {("urn:usl:portability-plan:scheduled_in", task["id"], next(milestone["id"] for milestone in plan["milestones"] if task["id"] in milestone["tasks"]))}
        expected_links |= {("urn:usl:portability-plan:acceptance_for", task["id"], criterion["requirement"], criterion["id"]) for criterion in task["acceptance"]}
    actual_links = set()
    for link in raw["links"]:
        role_map = parts(link); require(link.get("metadata") == {"authority": "SECONDARY_AI", "planningState": "PROPOSED", "execution": "NOT_CLAIMED"}, "plan link claims execution or unapproved authority")
        if link["meaning"].endswith("acceptance_for"):
            actual_links.add((link["meaning"], role_map.get("task"), role_map.get("requirement"), role_map.get("criterion")))
        elif link["meaning"].endswith(("addresses", "depends_on", "planned_output", "reuses", "informed_by", "scheduled_in")):
            endpoint = role_map.get("requirement") or role_map.get("prerequisite") or role_map.get("artifact") or role_map.get("source") or role_map.get("milestone")
            actual_links.add((link["meaning"], role_map.get("task"), endpoint))
    require(actual_links == expected_links, "resource graph task/criterion/source link chain differs from plan")

    # Counterexamples exercise semantic plan and RDF role/cardinality checks without writing files.
    bad = copy.deepcopy(plan); next(task for task in bad["tasks"] if task["id"] == "task:PT01")["dependsOn"] = ["task:PT07"]; require(not acyclic({item["id"]: set(item.get("dependsOn", [])) for item in bad["tasks"]}) and not plan_conforms(bad), "cycle must be rejected")
    bad = copy.deepcopy(plan); bad["currentSources"][0]["sha256"] = "sha256:" + "0" * 64; require(not plan_conforms(bad, check_pins=True), "source pin mismatch must be rejected")
    bad = copy.deepcopy(plan); bad["tasks"][0]["status"] = "COMPLETED"; require(not plan_conforms(bad), "status promotion must be rejected")
    bad = copy.deepcopy(plan); bad["tasks"][0]["acceptance"].pop(); require(not plan_conforms(bad), "criterion coverage loss must be rejected")
    bad = copy.deepcopy(plan); bad["requirements"].append({"id": "requirement:orphan", "authority": "SECONDARY_AI"}); require(not plan_conforms(bad), "orphan requirement must be rejected")
    criterion = next(trace.subjects(RDF.type, P.AcceptanceCriterion)); bad_trace = Graph(); [bad_trace.add(item) for item in trace]; bad_trace.remove((criterion, P.forTask, None)); require(not rdf_conforms(bad_trace, typed_shapes)[0], "missing criterion endpoint must be rejected")
    bad_trace = Graph(); [bad_trace.add(item) for item in trace]; bad_trace.set((criterion, P.forTask, URIRef("task:PT02"))); require(not rdf_conforms(bad_trace, typed_shapes)[0], "misdirected criterion must be rejected")
    task = URIRef("task:PT01"); artifact = next(trace.objects(task, P.plannedOutput)); bad_trace = Graph(); [bad_trace.add(item) for item in trace]; bad_trace.set((artifact, RDF.type, P.Requirement)); require(not rdf_conforms(bad_trace, typed_shapes)[0], "planned output type swap must be rejected")
    participant = next(graph_data.subjects(USL.role, None)); bad_graph = Graph(); [bad_graph.add(item) for item in graph_data]; bad_graph.set((participant, USL.role, Literal("wrongRole"))); require(not rdf_conforms(bad_graph, profile_shapes(profile))[0], "binding role swap must be rejected")
    print(json.dumps({"rdf": "PARSED", "shacl": "CONFORMS", "competencyQueries": 6, "negativeCases": 9, "scope": "PLANNED_PORTABILITY_WORK_PLAN_ONLY_NO_RUNTIME_TRANSFER_OR_RESTORE_CLAIM"}))


if __name__ == "__main__":
    main()
