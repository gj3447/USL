#!/usr/bin/env python3
"""Build a local development view from reviewed inputs; never refresh evidence pins."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "research/native-development"
ND = "urn:usl:native-development:"
PREFIX = "urn:usl:dev:"


def encoded(value):
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def digest(value):
    return "sha256:" + hashlib.sha256(value).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def indexed(items, label):
    result = {item["id"]: item for item in items}
    require(len(result) == len(items), f"duplicate {label} identity")
    return result


def validate(plan, request, references):
    require(plan["schema"] == "usl-native-development-plan/v1", "plan schema")
    require(plan["status"] == "DESIGN_ONLY", "plan must not claim implementation")
    require(plan["authorityClass"] == "SECONDARY_AI", "plan authority")
    require(request["publication"] == plan["publication"] == "LOCAL_ONLY", "local scope")
    sources = indexed(request["sources"], "source")
    for source in sources.values():
        require(source["authorityClass"] == "USER_PRIMARY", "source authority")
        require(digest(source["text"].encode()) == source["textDigest"], "source text digest")
    requirements = indexed(plan["requirements"], "requirement")
    work = indexed(plan["workItems"], "work")
    tests = indexed(plan["acceptanceTests"], "acceptance")
    constraints = indexed(plan["constraints"], "constraint")
    artifacts = indexed(references["artifacts"], "artifact")
    prior = {p["key"]: p for p in plan["priorWork"]}
    require(len(prior) == len(plan["priorWork"]), "duplicate prior-work key")
    for original in prior.values():
        require(original["artifact"] in artifacts, "unknown prior-work artifact")
        require(original["sourceSelector"].startswith("/resources/"), "prior-work selector")
        require(original["status"] == "PROPOSED" and original["authorityClass"] == "SECONDARY_AI", "prior-work status/authority")
    for artifact in artifacts.values():
        scope = artifact["evidenceScope"]
        require(artifact["runtimeTestedThisResearch"] is False, "artifact is not current execution evidence")
        require(scope in ["PINNED_SOURCE", "HISTORICAL_OBSERVATION", "LOCAL_UNTRACKED_SNAPSHOT", "PUBLIC_STANDARD", "PUBLIC_DOCUMENTATION"], "artifact evidence scope")
        if scope in ["PUBLIC_STANDARD", "PUBLIC_DOCUMENTATION"]:
            require(artifact["url"].startswith("https://") and artifact["reviewedOn"], "public source provenance")
            require(artifact["sourceState"] == "PREVIOUSLY_REVIEWED_PRIMARY_DOCUMENTATION", "public source state")
        else:
            require(re.fullmatch(r"sha256:[0-9a-f]{64}", artifact["byteDigest"]) is not None, "artifact byte pin")
            require(type(artifact["bytes"]) is int and artifact["bytes"] > 0, "artifact byte length")
            require(artifact["repository"] in ["USL", "what-is-git", "HSWM_LIKENESS"], "source repository alias")
            path = Path(artifact["path"])
            require(not path.is_absolute() and ".." not in path.parts and artifact["observedAt"], "source path/time")
            if scope == "LOCAL_UNTRACKED_SNAPSHOT":
                require(artifact["sourceState"] == "UNTRACKED_WORKING_FILE" and "contentRevision" not in artifact, "untracked is not commit-pinned")
            else:
                require(artifact["sourceState"] == "TRACKED_CLEAN" and re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", artifact["contentRevision"]) is not None, "source content revision")
    for requirement in requirements.values():
        require(requirement["authorityClass"] == "SECONDARY_AI", "interpretation authority")
        require(requirement["derivedFrom"] and set(requirement["derivedFrom"]) <= sources.keys(), "requirement provenance")
        require(any(requirement["id"] in w["realizes"] for w in work.values()), "uncovered requirement")
    for test in tests.values():
        require(test["status"] == "SPECIFIED_NOT_RUN", "acceptance is a specification")
        require(test["kind"] in ["POSITIVE", "ADVERSARIAL"], "acceptance kind")
        require(test["scenario"].strip() and test["expected"].strip(), "empty acceptance")
        require(sum(test["id"] in w["verifiedBy"] for w in work.values()) == 1, "acceptance ownership")
    for item in work.values():
        require(item["status"] == "PLANNED" and item["authorityClass"] == "SECONDARY_AI", "work must remain a plan")
        for field in ["title", "ownerBoundary", "deliverable", "remaining"]:
            require(item[field].strip(), f"work missing {field}")
        for field, targets in [("realizes", requirements), ("verifiedBy", tests), ("groundedIn", artifacts), ("constrainedBy", constraints), ("refines", prior)]:
            require(item[field] and set(item[field]) <= targets.keys(), f"invalid {field}")
        require({tests[t]["kind"] for t in item["verifiedBy"]} == {"POSITIVE", "ADVERSARIAL"}, "both acceptance kinds required")
        require(set(item["dependsOn"]) <= work.keys(), "unknown dependency")
        for dep in item.get("conditionalDependencies", []):
            require(dep["work"] in work and dep["condition"].strip(), "invalid conditional dependency")
    # Include conditional edges in cycle detection but not in unconditional readiness.
    visited, active, order = set(), set(), []

    def visit(key):
        require(key not in active, "dependency cycle")
        if key in visited:
            return
        active.add(key)
        for dep in work[key]["dependsOn"] + [d["work"] for d in work[key].get("conditionalDependencies", [])]:
            visit(dep)
        active.remove(key)
        visited.add(key)
        order.append(key)

    for key in work:
        visit(key)
    ready = [w["id"] for w in work.values() if not w["dependsOn"] and not w.get("conditionalDependencies")]
    require(ready == [plan["firstWorkItem"]], "first executable plan item")
    return order


# Roles are native USL declarations. The RDF view below projects these declared relations.
RELATIONS = {
    "realizes": [("work", "WorkItem"), ("requirement", "Requirement")],
    "verifiedBy": [("work", "WorkItem"), ("test", "AcceptanceTest")],
    "groundedIn": [("work", "WorkItem"), ("artifact", "Artifact")],
    "dependsOn": [("work", "WorkItem"), ("prerequisite", "WorkItem")],
    "conditionallyDependsOn": [("work", "WorkItem"), ("prerequisite", "WorkItem")],
    "constrainedBy": [("work", "WorkItem"), ("constraint", "Constraint")],
    "derivedFrom": [("requirement", "Requirement"), ("source", "UserSource")],
    "refines": [("work", "WorkItem"), ("prior", "PriorWork")],
    "originallyDeclaredIn": [("prior", "PriorWork"), ("artifact", "Artifact")],
}
PROFILE_METADATA = {
    "WorkItem": [("authorityClass", "SECONDARY_AI"), ("status", "PLANNED")],
    "Requirement": [("authorityClass", "SECONDARY_AI")],
    "AcceptanceTest": [("authorityClass", "SECONDARY_AI"), ("status", "SPECIFIED_NOT_RUN")],
    "UserSource": [("authorityClass", "USER_PRIMARY")],
    "Constraint": [("authorityClass", "SECONDARY_AI")],
    "PriorWork": [("authorityClass", "SECONDARY_AI"), ("status", "PROPOSED")],
    "Artifact": [("runtimeTestedThisResearch", False)],
}


def build(plan, request, references):
    resources, links, bindings, selections = [], [], [], []
    node_maps = {}

    def nodes(items, kind, filename, field, prefix):
        result = {}
        document_digest = digest((BASE / filename).read_bytes())
        for index, item in enumerate(items):
            key = item.get("key", item["id"])
            identity = item["id"] if prefix is None else PREFIX + prefix + ":" + item["id"]
            result[key] = identity
            selector = f"/{field}/{index}"
            metadata = {**item, "selector": {"jsonPointer": selector, "documentDigest": document_digest},
                        "selectorStatus": "OWNER_READ_REQUIRED", "viewScope": "LOCAL_DEVELOPMENT_PLAN"}
            path = "research/native-development/" + filename
            resources.append({"id": identity, "types": [ND + kind], "locator": "file://usl-root/" + path, "metadata": metadata})
            representation = "rep_" + hashlib.sha256(identity.encode()).hexdigest()
            bindings.append({"id": identity, "representations": [{"id": representation, "relation": "working-copy", "kind": "workspace", "workspace": "usl", "path": path, "digest": document_digest}]})
            selections.append({"resource": identity, "representation": representation})
        node_maps[kind] = result
        return result

    sources = nodes(request["sources"], "UserSource", "request.json", "sources", None)
    requirements = nodes(plan["requirements"], "Requirement", "plan.json", "requirements", "req")
    works = nodes(plan["workItems"], "WorkItem", "plan.json", "workItems", "work")
    tests = nodes(plan["acceptanceTests"], "AcceptanceTest", "plan.json", "acceptanceTests", "test")
    artifacts = nodes(references["artifacts"], "Artifact", "references.json", "artifacts", "artifact")
    constraints = nodes(plan["constraints"], "Constraint", "plan.json", "constraints", "constraint")
    prior = nodes(plan["priorWork"], "PriorWork", "plan.json", "priorWork", None)

    def link(meaning, left, right, extra=None):
        links.append({"id": PREFIX + "link:" + hashlib.sha256(f"{meaning}|{left}|{right}".encode()).hexdigest(),
                      "meaning": meaning, "participants": [{"role": RELATIONS[meaning][0][0], "resource": left}, {"role": RELATIONS[meaning][1][0], "resource": right}],
                      "metadata": {"authorityClass": "SECONDARY_AI", "status": "DECLARED", **(extra or {})}})

    for requirement in plan["requirements"]:
        for source in requirement["derivedFrom"]:
            link("derivedFrom", requirements[requirement["id"]], sources[source])
    for original in plan["priorWork"]:
        artifact = next(a for a in references["artifacts"] if a["id"] == original["artifact"])
        link("originallyDeclaredIn", prior[original["key"]], artifacts[original["artifact"]],
             {"sourceSelector": original["sourceSelector"], "sourceDocumentDigest": artifact["byteDigest"], "sourceRevision": artifact["contentRevision"]})
    targets = {"realizes": requirements, "verifiedBy": tests, "groundedIn": artifacts, "dependsOn": works, "constrainedBy": constraints, "refines": prior}
    for work in plan["workItems"]:
        for meaning, mapping in targets.items():
            for target in work[meaning]:
                link(meaning, works[work["id"]], mapping[target])
        for dep in work.get("conditionalDependencies", []):
            link("conditionallyDependsOn", works[work["id"]], works[dep["work"]], {"condition": dep["condition"]})
    graph = {"schema": "usl-resource-graph/v1", "resources": resources,
             "meanings": [{"id": k, "description": f"Declared development relation: {k}; no access or execution implied"} for k in RELATIONS],
             "links": links, "provenance": {"sources": list(sources.values())}}
    profile = {"schema": "usl-domain-profile/v1", "id": ND + "profile", "version": plan["version"], "closedMeanings": True,
               "meanings": [{"id": meaning, "allowExtraRoles": False, "roles": [{"role": role, "required": True, "types": [ND + kind],
                             "metadata": [{"key": key, "equals": value} for key, value in PROFILE_METADATA.get(kind, [])]} for role, kind in roles]} for meaning, roles in RELATIONS.items()]}
    rdf_nodes = {}
    for resource in resources:
        rdf_nodes[resource["id"]] = {"@id": resource["id"], "@type": resource["types"],
            **{"nd:" + key: value for key, value in resource["metadata"].items() if isinstance(value, (str, bool, int))}}
        selector = resource["metadata"]["selector"]
        rdf_nodes[resource["id"]]["nd:documentDigest"] = selector["documentDigest"]
        rdf_nodes[resource["id"]]["nd:jsonPointer"] = selector["jsonPointer"]
    for edge in links:
        left, right = [p["resource"] for p in edge["participants"]]
        rdf_nodes[left].setdefault("nd:" + edge["meaning"], []).append({"@id": right})
        if edge["meaning"] in ["derivedFrom", "groundedIn", "refines", "originallyDeclaredIn"]:
            rdf_nodes[left].setdefault("prov:wasDerivedFrom", []).append({"@id": right})
        if edge["meaning"] == "conditionallyDependsOn":
            rdf_nodes[edge["id"]] = {"@id": edge["id"], "@type": "nd:ConditionalDependency", "nd:work": {"@id": left},
                "nd:prerequisite": {"@id": right}, "nd:condition": edge["metadata"]["condition"]}
    trace = {"@context": {"nd": ND, "prov": "http://www.w3.org/ns/prov#", "xsd": "http://www.w3.org/2001/XMLSchema#"}, "@graph": list(rdf_nodes.values())}
    connection = {"allowedLocators": [], "maxResources": 128, "maxInputBytes": 4194304, "maxOutputBytes": 4194304, "programs": {},
                  "connections": {"usl-native-development-v1": {"graph": "../../research/native-development/graph.json", "profile": "../../research/native-development/profile.json", "namespace": plan["namespace"], "format": "resource-graph"}}}
    host = {"schema": "usl-cli-host/v1", "bindings": "bindings.json", "workspaces": {"usl": "../.."}, "maxSourceBytes": 1048576, "actions": []}
    return graph, profile, trace, {"schema": "usl-resource-bindings/v1", "resources": bindings}, selections, host, connection


def check_negative_inputs(inputs):
    """Reject plausible evidence/authority/dependency corruption without writing fixtures."""
    mutations = [
        ("dependency cycle", lambda p, r, e: p["workItems"][0]["dependsOn"].append("P12")),
        ("unknown dependency", lambda p, r, e: p["workItems"][0]["dependsOn"].append("P99")),
        ("lost positive acceptance", lambda p, r, e: p["workItems"][0].update(verifiedBy=["P01-adversarial"])),
        ("user source misattribution", lambda p, r, e: r["sources"][0].update(authorityClass="SECONDARY_AI")),
        ("quote mutation", lambda p, r, e: r["sources"][0].update(text="changed")),
        ("completed work claim", lambda p, r, e: p["workItems"][0].update(status="DONE")),
        ("executed acceptance claim", lambda p, r, e: p["acceptanceTests"][0].update(status="PASSED")),
        ("runtime proof promotion", lambda p, r, e: e["artifacts"][0].update(runtimeTestedThisResearch=True)),
        ("untracked commit claim", lambda p, r, e: next(a for a in e["artifacts"] if a["evidenceScope"] == "LOCAL_UNTRACKED_SNAPSHOT").update(contentRevision="0" * 40)),
        ("unknown original artifact", lambda p, r, e: p["priorWork"][0].update(artifact="missing")),
        ("uncovered requirement", lambda p, r, e: [w.update(realizes=[q for q in w["realizes"] if q != "R10"]) for w in p["workItems"]]),
        ("missing condition", lambda p, r, e: p["workItems"][4]["conditionalDependencies"][0].update(condition="")),
    ]
    for label, mutate in mutations:
        changed = copy.deepcopy(inputs)
        mutate(*changed)
        try:
            validate(*changed)
        except (ValueError, KeyError):
            continue
        raise ValueError("negative input accepted: " + label)
    return [label for label, _ in mutations]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="compare generated artifacts without writing")
    parser.add_argument("--self-test", action="store_true", help="validate inputs and reject adversarial mutations without writing or exporting")
    parser.add_argument("--check-evidence", action="store_true", help="verify pinned Git blobs and explicit untracked file snapshots in sibling repositories; missing evidence fails")
    args = parser.parse_args()
    plan, request, refs = [json.loads((BASE / f).read_text()) for f in ["plan.json", "request.json", "references.json"]]
    order = validate(plan, request, refs)
    if args.self_test:
        cases = check_negative_inputs([plan, request, refs])
        print(json.dumps({"builderNegativeCases": len(cases), "all": "REJECTED", "cases": cases}))
        return
    graph, profile, trace, bindings, selections, host, connection = build(plan, request, refs)
    # Use USL's actual exporter, not a second implementation of its native JSON-LD contract.
    program = """import {Either} from 'effect'; import {resourceGraphJsonLd} from './src/integrations/resource-graph.ts';
let raw=''; for await (const chunk of process.stdin) raw+=chunk;
const input=JSON.parse(raw); const result=Either.getOrThrowWith(resourceGraphJsonLd(input.raw,{namespace:input.namespace,profile:input.profile}),e=>e);
process.stdout.write(JSON.stringify(result));"""
    result = subprocess.run(["node", "--import", "tsx", "--input-type=module", "-e", program], cwd=ROOT,
        env={**os.environ, "TSX_DISABLE_CACHE": "1", "TMPDIR": "/dev/shm"},
        input=json.dumps({"raw": encoded(graph), "profile": profile, "namespace": plan["namespace"]}), text=True, capture_output=True, timeout=60)
    require(result.returncode == 0, "USL exporter failed: " + result.stderr)
    native = json.loads(result.stdout)
    outputs = {BASE / name: value for name, value in [("graph.json", graph), ("profile.json", profile), ("trace.jsonld", trace), ("graph.jsonld", native), ("bindings.json", bindings), ("selections.json", selections), ("host.json", host)]}
    outputs[ROOT / "connections/native-development/connection.json"] = connection
    for path, value in outputs.items():
        text = encoded(value)
        if args.check:
            require(path.is_file() and path.read_text() == text, f"generated artifact differs: {path.relative_to(ROOT)}")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
    checked = 0
    if args.check_evidence:
        for source in refs["artifacts"]:
            if "byteDigest" not in source:
                continue
            repository = ROOT.parent / source["repository"]
            if source["evidenceScope"] == "LOCAL_UNTRACKED_SNAPSHOT":
                data = (repository / source["path"]).read_bytes()
            else:
                # Read the reviewed immutable revision even when the working tree has moved.
                data = subprocess.check_output(["git", "cat-file", "blob", source["contentRevision"] + ":" + source["path"]], cwd=repository, timeout=10)
            require(len(data) == source["bytes"] and digest(data) == source["byteDigest"], "evidence drift: " + source["id"])
            for original in plan["priorWork"]:
                if original["artifact"] == source["id"]:
                    selected = json.loads(data)
                    for part in original["sourceSelector"].lstrip("/").split("/"):
                        selected = selected[int(part)] if isinstance(selected, list) else selected[part]
                    require(selected["id"] == original["id"], "prior-work selector identity differs")
            checked += 1
    print(json.dumps({"status": "CHECKED" if args.check else "BUILT", "resources": len(graph["resources"]), "links": len(graph["links"]), "requirements": len(plan["requirements"]), "workItems": len(plan["workItems"]), "acceptanceSpecifications": len(plan["acceptanceTests"]), "evidencePinsChecked": checked, "topologicalOrder": order, "runtimeAcceptanceExecuted": False}))


if __name__ == "__main__":
    main()
