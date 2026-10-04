"""Validate a proposed USL completion roadmap; never execute its packages."""
import copy
import hashlib
import json
import subprocess
from pathlib import Path

from pyshacl import validate
from rdflib import Graph, Namespace, URIRef, Literal

ROOT = Path(__file__).resolve().parent.parent
PLAN_DIR = ROOT / "research/completion-plan"
C = Namespace("urn:usl:completion-plan:")
PROV = Namespace("http://www.w3.org/ns/prov#")


class PlanError(AssertionError):
    pass


def reject(condition, message):
    if not condition:
        raise PlanError(message)


def blob(commit, path):
    return subprocess.check_output(["git", "show", f"{commit}:{path}"], cwd=ROOT)


def ids(items):
    return [item["id"] for item in items]


def source_data(plan):
    source = {item["id"]: item for item in plan["sources"]}
    reject(len(source) == len(plan["sources"]) and source, "duplicate or absent source")
    for item in source.values():
        reject(item["sourceCommit"] == plan["sourceCommit"], "source commit differs from plan header")
        actual = "sha256:" + hashlib.sha256(blob(item["sourceCommit"], item["path"])).hexdigest()
        reject(actual == item["sha256"], f"bad pin {item['id']}")
    required = {item["path"]: item for item in source.values()}
    old = required.get("research/development-plan/plan.json")
    standards = required.get("research/standards-coverage/coverage.json")
    catalog = required.get("research/engineering/catalog.json")
    reject(old and standards and catalog, "missing required pinned source")
    return source, old, json.loads(blob(old["sourceCommit"], old["path"])), json.loads(blob(standards["sourceCommit"], standards["path"])), json.loads(blob(catalog["sourceCommit"], catalog["path"]))


def conform(plan):
    """Reusable semantic contract used for the real plan and rejected mutations."""
    reject(plan["schema"] == "usl-completion-plan/v1" and plan["id"] == "plan:usl-completion-2026-10-04", "header")
    reject(plan["authority"] == "SECONDARY_AI" and plan["status"] == "PLANNED", "future authority/status")
    reject(plan["userRequest"]["authority"] == "USER_PRIMARY" and plan["userRequest"]["text"].strip(), "user authority")
    for group in ("sources", "baselines", "packages", "coverage", "prerequisites", "milestones", "competencyQuestions"):
        reject(len(ids(plan[group])) == len(set(ids(plan[group]))), f"duplicate {group} id")
    source, old_source, old, standards, catalog = source_data(plan)
    tasks = {x["id"] for x in old["tasks"]}
    criteria = {x["id"] for x in old["criteria"]}
    requirements = {x["id"] for x in old["requirements"]}
    assessments = {x["id"] for x in standards["assessments"]}
    technologies = {x["id"] for x in catalog["technologies"]}
    controls = {x["id"] for x in catalog["controls"]}
    reject((len(tasks), len(criteria), len(requirements), len(assessments), len(technologies), len(controls)) == (14, 47, 13, 22, 40, 12), "historical source shape")

    packages = {x["id"]: x for x in plan["packages"]}
    reject(len(packages) == len(plan["packages"]) and 20 <= len(packages) <= 25, "package count/id")
    reject(plan["firstPackage"] in packages and not packages[plan["firstPackage"]]["dependsOn"] and not packages[plan["firstPackage"]]["conditionalDependsOn"], "first package")
    prereqs = {x["id"]: x for x in plan["prerequisites"]}
    reject(len(prereqs) == len(plan["prerequisites"]) and prereqs, "prerequisite id")
    acceptance_ids = []
    for package in packages.values():
        reject(package["status"] == "PLANNED", f"future package {package['id']}")
        reject(package["sourceIds"] and package["acceptance"] and package["plannedOutputs"], f"package omission {package['id']}")
        reject(set(package["sourceIds"]) <= set(source) and set(package["dependsOn"] + package["conditionalDependsOn"]) <= set(packages), f"dangling package ref {package['id']}")
        reject(set(package["canonicalTaskIds"]) <= tasks and set(package["criterionIds"]) <= criteria and set(package["prerequisiteIds"]) <= set(prereqs), f"bad package ref {package['id']}")
        for output in package["plannedOutputs"]:
            reject(isinstance(output, str) and output and not output.startswith("/") and ".." not in output.split("/"), f"unsafe output {package['id']}")
        for acceptance in package["acceptance"]:
            reject(acceptance["execution"] == "NOT_RUN" and acceptance["expectation"].strip() and acceptance["negativeCase"].strip(), f"future acceptance {acceptance['id']}")
            acceptance_ids.append(acceptance["id"])
    reject(len(acceptance_ids) == len(set(acceptance_ids)) and len(acceptance_ids) == 44, "cross-package acceptance ids")

    color = {}
    def visit(package_id):
        reject(color.get(package_id) != 1, "package dependency cycle")
        if color.get(package_id) == 2:
            return
        color[package_id] = 1
        for prior in packages[package_id]["dependsOn"] + packages[package_id]["conditionalDependsOn"]:
            visit(prior)
        color[package_id] = 2
    for package_id in packages:
        visit(package_id)

    reject(len(plan["baselines"]) == 14 and {x["taskId"] for x in plan["baselines"]} == tasks, "baseline task coverage")
    for baseline in plan["baselines"]:
        reject(set(baseline["sourceIds"]) <= set(source), f"baseline source {baseline['id']}")
    expected = {**{x: ("CRITERION", "research/development-plan/plan.json") for x in criteria}, **{x: ("ASSESSMENT", "research/standards-coverage/coverage.json") for x in assessments}, **{x: ("TECHNOLOGY", "research/engineering/catalog.json") for x in technologies}, **{x: ("CONTROL", "research/engineering/catalog.json") for x in controls}}
    records = [x["sourceRecordId"] for x in plan["coverage"]]
    reject(len(plan["coverage"]) == 121 and len(records) == len(set(records)) and set(records) == set(expected), "coverage exactness")
    for item in plan["coverage"]:
        reject(item["kind"] in {"CRITERION", "ASSESSMENT", "TECHNOLOGY", "CONTROL"}, "coverage kind enum")
        kind, path = expected.get(item["sourceRecordId"], (None, None))
        reject(item["kind"] == kind and item["sourceId"] in source and source[item["sourceId"]]["path"] == path and item["packageIds"] and set(item["packageIds"]) <= set(packages), f"coverage endpoint {item['id']}")
        if item["kind"] == "CRITERION":
            mapped = {p for p, package in packages.items() if item["sourceRecordId"] in package["criterionIds"]}
            reject(set(item["packageIds"]) == mapped, f"criterion package parity {item['id']}")

    reverse = {p: set() for p in packages}
    for prereq in prereqs.values():
        reject(prereq["status"] == "NEEDED" and prereq["neededFor"] and set(prereq["neededFor"]) <= set(packages), f"prerequisite {prereq['id']}")
        for package_id in prereq["neededFor"]:
            reverse[package_id].add(prereq["id"])
    for package_id, package in packages.items():
        reject(set(package["prerequisiteIds"]) == reverse[package_id], f"prerequisite parity {package_id}")
    milestone_packages = set()
    for milestone in plan["milestones"]:
        reject(milestone["status"] == "PLANNED" and milestone["packageIds"] and set(milestone["packageIds"]) <= set(packages), f"milestone {milestone['id']}")
        milestone_packages.update(milestone["packageIds"])
    reject(milestone_packages == set(packages) and len(plan["competencyQuestions"]) >= 8 and len(plan["decisions"]) >= 8, "milestone/CQ/decision completeness")
    return {"old": old, "source": source, "oldSource": old_source, "packages": packages, "requirements": requirements}


plan = json.loads((PLAN_DIR / "plan.json").read_text())
facts = conform(plan)


def expect_rejected(label, mutate):
    candidate = copy.deepcopy(plan)
    mutate(candidate)
    try:
        conform(candidate)
    except PlanError:
        return label
    raise PlanError(f"negative mutation accepted: {label}")


negative_cases = [
    expect_rejected("cycle", lambda p: p["packages"][1]["dependsOn"].append(p["packages"][2]["id"])),
    expect_rejected("dangling-dependency", lambda p: p["packages"][1]["dependsOn"].append("package:missing")),
    expect_rejected("coverage-omission", lambda p: p["coverage"].pop()),
    expect_rejected("duplicate-coverage-record", lambda p: p["coverage"].__setitem__(1, {**p["coverage"][1], "sourceRecordId": p["coverage"][0]["sourceRecordId"]})),
    expect_rejected("promoted-acceptance", lambda p: p["packages"][0]["acceptance"][0].__setitem__("execution", "PASS")),
    expect_rejected("bad-pin", lambda p: p["sources"][0].__setitem__("sha256", "sha256:" + "0" * 64)),
    expect_rejected("missing-acceptance", lambda p: p["packages"][0].__setitem__("acceptance", [])),
    expect_rejected("authority-confusion", lambda p: p["userRequest"].__setitem__("authority", "SECONDARY_AI")),
    expect_rejected("prerequisite-parity", lambda p: p["packages"][0]["prerequisiteIds"].pop()),
]

resource_graph = json.loads((PLAN_DIR / "graph.json").read_text())
resource_ids = [x["id"] for x in resource_graph["resources"]]
reject(len(resource_ids) == len(set(resource_ids)) and all(x in resource_ids for x in facts["requirements"]), "original node collision/omission")
profile = json.loads((PLAN_DIR / "profile.json").read_text())


def graph_conforms(value):
    resources = {x["id"]: x for x in value["resources"]}
    reject(len(resources) == len(value["resources"]), "duplicate graph resource")
    meanings = {x["id"]: x for x in profile["meanings"]}
    reject(set(meanings) == {x["id"] for x in value["meanings"]}, "meaning registry mismatch")
    link_ids = []
    for link in value["links"]:
        link_ids.append(link["id"])
        reject(link["meaning"] in meanings, "unregistered meaning")
        roles = {x["role"]: x for x in meanings[link["meaning"]]["roles"]}
        participants = {x["role"]: x["resource"] for x in link["participants"]}
        reject(len(participants) == len(link["participants"]) and set(participants) == set(roles), "role cardinality")
        for role, resource in participants.items():
            reject(resource in resources and set(roles[role]["types"]) <= set(resources[resource]["types"]), "endpoint domain/range")
        reject(link["metadata"] == {"authority": "SECONDARY_AI", "status": "PLANNING_RELATION"}, "link authority/status")
    reject(len(link_ids) == len(set(link_ids)), "duplicate graph link")


graph_conforms(resource_graph)
links = resource_graph["links"]
def graph_edge(meaning, participants):
    return any(link["meaning"] == str(C) + meaning and {q["role"]: q["resource"] for q in link["participants"]} == participants for link in links)
for task in facts["old"]["tasks"]:
    for requirement in task["requirementIds"]:
        reject(graph_edge("original_task_addresses", {"originalTask": task["id"], "requirement": requirement}), "requirement-to-task navigation")
    for criterion in task["criterionIds"]:
        reject(graph_edge("original_criterion_for", {"originalCriterion": criterion, "originalTask": task["id"]}), "task-to-criterion navigation")

# The first edge is historical task -> requirement; swap its typed endpoints.
for label, mutate in [
    ("reversed-role-endpoints", lambda g: g["links"][0]["participants"].__setitem__(slice(None), [
        {**g["links"][0]["participants"][0], "resource": g["links"][0]["participants"][1]["resource"]},
        {**g["links"][0]["participants"][1], "resource": g["links"][0]["participants"][0]["resource"]}])),
    ("duplicate-role", lambda g: g["links"][0]["participants"].append(copy.deepcopy(g["links"][0]["participants"][0]))),
    ("dangling-graph-endpoint", lambda g: g["links"][0]["participants"][0].__setitem__("resource", "missing:node")),
]:
    candidate = copy.deepcopy(resource_graph)
    mutate(candidate)
    try:
        graph_conforms(candidate)
    except PlanError:
        negative_cases.append(label)
    else:
        raise PlanError(f"graph mutation accepted: {label}")

rdf = Graph()
rdf.parse(data=(PLAN_DIR / "trace.jsonld").read_text(), format="json-ld")
shapes = Graph()
shapes.parse(ROOT / "schemas/completion-plan/plan.shacl.ttl", format="turtle")
ok, _, report = validate(rdf, shacl_graph=shapes, advanced=True)
reject(ok, str(report))
# Exercise SHACL itself, independently from the JSON contract.
for label, subject, predicate, replacement in [
    ("shacl-future-pass", URIRef("acceptance:CP01-1"), C.execution, Literal("PASS")),
    ("shacl-wrong-source-range", URIRef("coverage:criterion:DG01-C1"), C.covers_source_record, URIRef("package:CP01")),
    ("shacl-missing-source-pin", URIRef("source:completion:plan"), C.sha256, None),
]:
    candidate = Graph()
    for triple in rdf:
        candidate.add(triple)
    candidate.remove((subject, predicate, None))
    if replacement is not None:
        candidate.add((subject, predicate, replacement))
    conforms, _, _ = validate(candidate, shacl_graph=shapes, advanced=True)
    reject(not conforms, f"SHACL mutation accepted: {label}")
    negative_cases.append(label)

queries = {
    "coverage": "SELECT ?coverage ?source ?package WHERE { ?coverage a c:Coverage; c:covers_source_record ?source; c:covers ?package . }",
    "acceptance": "SELECT ?package ?acceptance WHERE { ?package a c:Package; c:has_acceptance ?acceptance . ?acceptance c:execution 'NOT_RUN' . }",
    "provenance": "SELECT ?plan ?activity ?agent WHERE { ?plan a c:Plan; prov:wasGeneratedBy ?activity . ?activity prov:wasAssociatedWith ?agent . }",
    "historical": "SELECT ?task ?requirement ?criterion WHERE { ?task a c:OriginalTask; c:original_task_addresses ?requirement . ?criterion a c:OriginalCriterion; c:original_criterion_for ?task . }",
    "baseline": "SELECT ?baseline ?source WHERE { ?baseline a c:Baseline; c:derived_from ?source . }",
    "dependency": "SELECT ?package ?prior WHERE { ?package a c:Package; c:depends_on ?prior . }",
    "prerequisite": "SELECT ?package ?prerequisite WHERE { ?package a c:Package; c:requires ?prerequisite . }",
    "conditional": "SELECT ?package ?prior WHERE { ?package a c:Package; c:conditionally_depends_on ?prior . }",
    "authority": "SELECT ?request ?plan WHERE { ?request a c:UserStatement; c:authority 'USER_PRIMARY' . ?plan a c:Plan; c:authority 'SECONDARY_AI'; c:status 'PLANNED' . }",
}
expected_rows = {
    "coverage": {(x["id"], x["sourceId"], package_id) for x in plan["coverage"] for package_id in x["packageIds"]},
    "acceptance": {(package["id"], a["id"]) for package in plan["packages"] for a in package["acceptance"]},
    "provenance": {(plan["id"], "activity:completion-plan", "agent:completion-plan")},
    "historical": {(task["id"], requirement, criterion) for task in facts["old"]["tasks"] for requirement in task["requirementIds"] for criterion in task["criterionIds"]},
    "baseline": {(item["id"], source_id) for item in plan["baselines"] for source_id in item["sourceIds"]},
    "dependency": {(item["id"], prior) for item in plan["packages"] for prior in item["dependsOn"]},
    "prerequisite": {(item["id"], prerequisite) for item in plan["packages"] for prerequisite in item["prerequisiteIds"]},
    "conditional": {(item["id"], prior) for item in plan["packages"] for prior in item["conditionalDependsOn"]},
    "authority": {("user:completion-request", plan["id"])},
}
results = {}
for label, query in queries.items():
    rows = list(rdf.query(query, initNs={"c": C, "prov": PROV}))
    actual = {tuple(str(value) for value in row) for row in rows}
    reject(actual == expected_rows[label], f"CQ tuple mismatch: {label}")
    results[label] = len(actual)
print(json.dumps({"rdf": "PARSED", "shacl": "CONFORMS", "competencyQueries": results, "negativeCases": negative_cases, "packages": len(facts["packages"]), "coverage": 121, "scope": "FUTURE_COMPLETION_PLAN_ONLY_NO_RUNTIME_COMPLETION_OR_STANDARD_SUPERSET_CLAIM"}))
