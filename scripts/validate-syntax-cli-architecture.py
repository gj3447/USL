"""Validate current/proposed architecture claims, RDF projection and SHACL role constraints."""
import hashlib, json, pathlib
from rdflib import Graph, Namespace, RDF, Literal
from pyshacl import validate

root = pathlib.Path(__file__).resolve().parents[1]
graph_path = root / "research/architecture/syntax-cli.graph.json"
jsonld_path = root / "research/architecture/syntax-cli.graph.jsonld"
assert jsonld_path.is_file(), "NOT_HYDRATED (regenerated, not committed); run node --import tsx scripts/build-syntax-cli-architecture.ts: research/architecture/syntax-cli.graph.jsonld"
shape_path = root / "research/architecture/syntax-cli.shacl.ttl"
raw = json.loads(graph_path.read_text())
profile = json.loads((root / "research/architecture/syntax-cli.profile.json").read_text())
catalog = json.loads((root / "research/architecture/syntax-cli.catalog.json").read_text())
work_plan_path = root / "research/architecture/hswm-like.plan.json"
work_plan = json.loads(work_plan_path.read_text())
core_plan_path = root / "research/architecture/core-cli.plan.json"
core_plan = json.loads(core_plan_path.read_text())
receipt_path = root / "research/architecture/binding-delivery.receipt.json"
receipt = json.loads(receipt_path.read_text())
compression_sources_path = root / "research/compression/sources.json"
compression_sources = json.loads(compression_sources_path.read_text())
compression_benchmark_path = root / "research/compression/benchmark-results.json"
compression_benchmark = json.loads(compression_benchmark_path.read_text())
kg_bridge_path = root / "research/architecture/kg-bridge.json"
kg_publication_path = root / "research/architecture/kg-bridge.publication.json"
kg_bridge = json.loads(kg_bridge_path.read_text())
kg_publication = json.loads(kg_publication_path.read_text())
compression_inputs_path = root / "research/compression/benchmark-inputs.json"
benchmark_script_path = root / "scripts/benchmark-compression.ts"
token_script_path = root / "scripts/count-compression-tokens.py"
requirements_path = root / "scripts/requirements-compression.txt"
def sha256_file(path): return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
# Dated receipts and plan/catalog pins are verified at the commit they name, not the working tree.
def sha256_commit(commit, path):
    result = __import__("subprocess").run(["git", "show", f"{commit}:{path}"], cwd=root, capture_output=True)
    return "sha256:" + hashlib.sha256(result.stdout).hexdigest() if result.returncode == 0 else None
resources = {r["id"]: r for r in raw["resources"]}
links = raw["links"]
assert len(resources) >= 25 and len(links) >= 20
assert resources["user:syntax-cli"]["metadata"]["authority"] == "USER_PRIMARY"
assert resources["user:weighted-hypergraph"]["metadata"]["authority"] == "USER_PRIMARY"
assert any(l["meaning"].endswith("trace") and len(l["participants"]) == 3 for l in links)
assert all("sourceDigest" in r.get("metadata", {}) for r in resources.values() if r["id"].startswith("artifact:"))
assert all("file://" not in r["locator"] for r in resources.values())
jsonld = json.loads(jsonld_path.read_text())
assert "@graph" in jsonld and any("usl:Link" in n.get("@type", []) for n in jsonld["@graph"])
shapes = shape_path.read_text()
assert "ArchitectureRoleShape" in shapes and "qualifiedMinCount 1" in shapes
for path, pin in catalog["sourcePins"].items():
    artifact = resources["artifact:" + path]
    assert artifact["metadata"]["sourceDigest"] == pin
    assert artifact["locator"].startswith("git://github.com/gj3447/USL@" + catalog["sourceCommit"] + ":")
assert resources["source:hswm-plan"]["metadata"]["sourceDigest"] == "sha256:" + hashlib.sha256(work_plan_path.read_bytes()).hexdigest()
assert resources["source:core-cli-plan"]["metadata"]["sourceDigest"] == "sha256:" + hashlib.sha256(core_plan_path.read_bytes()).hexdigest()
assert resources["source:binding-delivery-receipt"]["metadata"]["sourceDigest"] == "sha256:" + hashlib.sha256(receipt_path.read_bytes()).hexdigest()
assert resources["source:kg-bridge"]["metadata"]["sourceDigest"] == sha256_file(kg_bridge_path)
assert resources["source:kg-bridge-publication"]["metadata"]["sourceDigest"] == sha256_file(kg_publication_path)
assert resources["user:hswm-plan"]["metadata"] == {"status":"USER_PRIMARY", "text":work_plan["userRequest"]["text"], "authority":"USER_PRIMARY", "locationStatus":"DECLARED_PUBLIC_LOCATION", "remoteObservation":"NOT_PERFORMED"}
assert resources["user:core-cli-next"]["metadata"] == {"status":"USER_PRIMARY", "text":core_plan["userRequest"]["text"], "authority":"USER_PRIMARY", "locationStatus":"DECLARED_PUBLIC_LOCATION", "remoteObservation":"NOT_PERFORMED"}
for correction in work_plan.get("scopeCorrections", []):
    assert resources[correction["id"]]["metadata"]["authority"] == "USER_PRIMARY"
assert resources["user:cli-programs"]["metadata"]["authority"] == "USER_PRIMARY"
assert resources["user:compression-cost"]["metadata"]["authority"] == "USER_PRIMARY"
assert kg_bridge["schema"] == "usl-kg-bridge/v1" and kg_bridge["authority"] == "SECONDARY_AI"
assert kg_bridge["subject"] == {"uid": "sym:Concept:usl", "locator": "kg://personal/sym:Concept:usl"}
assert kg_bridge["observation"]["method"] == "ontology_get" and kg_bridge["observation"]["uidMatchCount"] == 1 and kg_bridge["observation"]["uidCollision"] is False
assert kg_bridge["repository"]["subject"] == "subject:usl" and kg_bridge["repository"]["url"] == "https://github.com/gj3447/USL"
assert kg_publication["schema"] == "usl-kg-publication/v1" and kg_publication["status"] == "PUBLISHED_DRAFT"
assert kg_publication["verifiedAt"] == kg_bridge["publication"]["verifiedAt"]
assert "sha256:" + hashlib.sha256(kg_publication["saveRequest"]["body"].encode()).hexdigest() == kg_bridge["publication"]["bodySha256"]
assert kg_publication["saveResult"]["uid"] == "sym:Note:chatgpt-" + kg_publication["saveRequest"]["name"]
assert kg_publication["saveResult"]["title"] == kg_publication["saveRequest"]["title"]
assert kg_publication["saveResult"]["uid"] == kg_bridge["publication"]["noteUid"] == kg_publication["readback"]["uid"]
assert kg_publication["readback"]["bodySha256"] == kg_bridge["publication"]["bodySha256"]
assert kg_publication["readback"]["authorityClass"] == kg_publication["readback"]["relationshipAuthority"] == "SECONDARY_AI"
assert kg_publication["readback"]["canonicalScope"] == "PENDING_OR_PRELIMINARY" and kg_publication["readback"]["reviewRequired"] is True and kg_publication["readback"]["relationshipReviewRequired"] is True
assert kg_publication["readback"]["relationshipStatus"] == kg_bridge["publication"]["relationshipStatus"] == "PROPOSED"
assert kg_publication["readback"]["targetVersion"] == kg_publication["saveResult"]["target_version"]
assert kg_publication["subjectPreservation"] == {"uid": kg_bridge["subject"]["uid"], "targetVersion": kg_bridge["observation"]["targetVersion"], "userUtteranceSha256": kg_bridge["observation"]["userUtteranceSha256"], "descriptionSha256": kg_bridge["observation"]["descriptionSha256"], "unchanged": True}
# The published note names repository files as of its pinned revision. Some of those
# (e.g. the regenerated JSON-LD) are no longer committed; resolve them at that commit.
published_commit = kg_bridge["repository"]["sourceCommit"]
assert ("로컬 Git revision: " + published_commit) in kg_publication["saveRequest"]["body"]
for name in ["syntax-cli.graph.json", "syntax-cli.graph.jsonld", "syntax-cli.profile.json", "syntax-cli.shacl.ttl"]:
    assert name in kg_publication["saveRequest"]["body"]
    assert sha256_commit(published_commit, "research/architecture/" + name) is not None, f"published path missing at {published_commit}: {name}"
assert resources["source:compression-sources"]["metadata"]["sourceDigest"] == sha256_file(compression_sources_path)
benchmark = resources["artifact:compression-benchmark"]
assert benchmark["metadata"]["sourceDigest"] == sha256_file(compression_benchmark_path)
assert benchmark["metadata"]["resultStatus"] == "OFFLINE_PAYLOAD_MEASUREMENT_NOT_RUNTIME_MEMORY_OR_BILLED_USAGE"
assert benchmark["metadata"]["billing"] == "NOT_MEASURED" and benchmark["metadata"]["llmQuality"] == "NOT_MEASURED"
assert compression_benchmark["scope"] == benchmark["metadata"]["resultStatus"]
assert compression_benchmark["validationStatus"] == benchmark["metadata"]["validationStatus"] == "FIXTURE_ROUNDTRIPS_PASSED"
assert compression_benchmark["inputs"] == {
    "digest": sha256_file(compression_inputs_path),
    "benchmarkScriptDigest": sha256_file(benchmark_script_path),
    "tokenScriptDigest": sha256_file(token_script_path),
    "requirementsDigest": sha256_file(requirements_path),
}
for fixture in compression_benchmark["fixtures"]:
    fixture_input = fixture["input"]
    if fixture_input["path"] is not None:
        source_digest = fixture_input["baseSourceDigest"] or fixture_input["sourceDigest"]
        assert sha256_file(root / fixture_input["path"]) == source_digest
assert len(compression_sources) >= 4
rules = {m["id"]: m for m in profile["meanings"]}
def conforms(candidate):
    known = {r["id"]: set(r["types"]) for r in candidate["resources"]}
    for item in candidate["links"]:
        rule = rules.get(item["meaning"])
        if rule is None: return False
        participants = {p["role"]: p.get("resource") for p in item["participants"]}
        if len(participants) != len(item["participants"]): return False
        if not rule["allowExtraRoles"] and set(participants) != {r["role"] for r in rule["roles"]}: return False
        for role in rule["roles"]:
            resource = participants.get(role["role"])
            if role["required"] and resource not in known: return False
            if resource and not set(role["types"]).issubset(known[resource]): return False
    return True
def claims_conform(candidate):
    by_id = {r["id"]: r for r in candidate["resources"]}
    current = [r for r in by_id.values() if "urn:usl:syntax-cli:ImplementedFeature" in r["types"]]
    proposals = [r for r in by_id.values() if "urn:usl:syntax-cli:Proposal" in r["types"]]
    if not current or not proposals: return False
    if any(r["metadata"].get("status") != "IMPLEMENTED_CURRENT_SOURCE" for r in current): return False
    if any(r["metadata"].get("status") != "PROPOSED" or r["metadata"].get("authority") != "SECONDARY_AI" or r["metadata"].get("placement") not in {"ADDON_RESPONSIBILITY", "MINIMAL_BINDING_CLI"} for r in proposals): return False
    def participants(link): return {p["role"]: p["resource"] for p in link["participants"]}
    implementation = [l for l in candidate["links"] if l["meaning"].endswith("implemented_by")]
    for feature in current:
        bound = [participants(l).get("artifact") for l in implementation if participants(l).get("feature") == feature["id"]]
        if not bound or any(not artifact or artifact not in by_id or not by_id[artifact]["id"].startswith("artifact:") or "sourceDigest" not in by_id[artifact].get("metadata", {}) for artifact in bound): return False
    addressed = [l for l in candidate["links"] if l["meaning"].endswith("addresses")]
    for proposal in proposals:
        matched = [l for l in addressed if participants(l).get("proposal") == proposal["id"]]
        if not matched or any(l.get("metadata", {}).get("authority") != "SECONDARY_AI" or participants(l).get("requirement") not in by_id or by_id[participants(l)["requirement"]].get("metadata", {}).get("authority") != "USER_PRIMARY" for l in matched): return False
    return True
def task_dag_acyclic(graph):
    seen, visiting = set(), set()
    def visit(task):
        if task in visiting: return False
        if task in seen: return True
        visiting.add(task)
        ok = all(dep in graph and visit(dep) for dep in graph[task])
        visiting.remove(task)
        if ok: seen.add(task)
        return ok
    return all(visit(task) for task in graph)

def completed_binding_work_conforms(candidate):
    by_id = {r["id"]: r for r in candidate["resources"]}
    plan_tasks = work_plan["tasks"]
    if len({t["id"] for t in plan_tasks}) != len(plan_tasks): return False
    if receipt.get("schema") != "usl-binding-delivery-receipt/v1" or receipt.get("authority") != "SECONDARY_AI" or receipt.get("status") != "PASS" or not isinstance(receipt.get("sourcePins"), dict): return False
    if any(t["status"] != "COMPLETED" or t["implementation"] != "COMPLETE" or t["proofStatus"] != "NOT_PROVEN" or not t["acceptance"] or not t["deliverables"] for t in plan_tasks): return False
    if any(by_id.get(t["id"], {}).get("metadata", {}).get("status") != "COMPLETED" or by_id.get(t["id"], {}).get("metadata", {}).get("implementation") != "COMPLETE" or by_id.get(t["id"], {}).get("metadata", {}).get("proofStatus") != "NOT_PROVEN" for t in plan_tasks): return False
    receipt_tasks = {t.get("id"): t for t in receipt.get("tasks", [])}
    expected_tests = {"task:P01": "test/navigation.test.ts", "task:P02": "test/addon-binding-cli.test.ts", "task:P03": "test/addon-binding-cli.test.ts"}
    for path, digest in receipt["sourcePins"].items():
        if not isinstance(path, str) or not isinstance(digest, str) or not (path.startswith(("src/", "docs/", "examples/", "test/", "scripts/", "research/")) or path in {"package.json", "package-lock.json", "tsconfig.json"}) or not isinstance(receipt.get("sourceCommit"), str) or sha256_commit(receipt["sourceCommit"], path) != digest: return False
    links_by_meaning = {}
    for link in candidate["links"]: links_by_meaning.setdefault(link["meaning"].split(":")[-1], []).append(link)
    def parts(link): return {p["role"]: p["resource"] for p in link["participants"]}
    for task in plan_tasks:
        criterion = "criterion:" + task["id"].split(":", 1)[1]
        if by_id.get(criterion, {}).get("metadata", {}).get("checks") != task["acceptance"] or by_id.get(criterion, {}).get("metadata", {}).get("status") != "PASS_RECORDED": return False
        receipt_task = receipt_tasks.get(task["id"], {})
        evidence = receipt_task.get("evidence", [])
        commands = [item for item in evidence if item.get("kind") == "command"]
        sources = [item for item in evidence if item.get("kind") == "source"]
        if receipt_task.get("status") != "PASS" or not any(item.get("exitCode") == 0 and isinstance(item.get("command"), str) and item["command"].strip() and isinstance(item.get("observed"), str) and item["observed"].strip() for item in commands): return False
        if any(receipt["sourcePins"].get(path) is None or not any(item.get("path") == path and item.get("sha256") == receipt["sourcePins"][path] for item in sources) for path in task["deliverables"]): return False
        expected_test = expected_tests[task["id"]]
        if receipt["sourcePins"].get(expected_test) is None or not any(item.get("path") == expected_test and item.get("sha256") == receipt["sourcePins"][expected_test] for item in sources) or not any(expected_test in item.get("command", "") for item in commands): return False
        work = [l for l in links_by_meaning.get("planned_work", []) if parts(l).get("task") == task["id"]]
        if {parts(l).get("requirement") for l in work} != set(task["requirements"]) or any(parts(l).get("criterion") != criterion or l.get("metadata", {}).get("authority") != "SECONDARY_AI" for l in work): return False
        complete = [l for l in links_by_meaning.get("completed_by", []) if parts(l).get("task") == task["id"]]
        if len(complete) != 1 or parts(complete[0]) != {"task": task["id"], "criterion": criterion, "evidence": "source:binding-delivery-receipt"} or complete[0].get("metadata", {}).get("proofStatus") != "NOT_PROVEN": return False
        deps = [parts(l).get("prerequisite") for l in links_by_meaning.get("task_depends_on", []) if parts(l).get("task") == task["id"]]
        if set(deps) != set(task["dependsOn"]): return False
    graph = {t["id"]: t["dependsOn"] for t in plan_tasks}
    return task_dag_acyclic(graph)
assert conforms(raw)
assert claims_conform(raw)
def kg_bridge_conforms(candidate):
    by_id = {r["id"]: r for r in candidate["resources"]}
    def parts(link): return {p["role"]: p["resource"] for p in link["participants"]}
    external = by_id.get("sym:Concept:usl", {})
    note = by_id.get(kg_bridge["publication"]["noteUid"], {})
    if "urn:usl:syntax-cli:ExternalSubject" not in external.get("types", []) or external.get("locator") != "kg://personal/sym:Concept:usl": return False
    if external.get("metadata", {}).get("nativeUid") != "sym:Concept:usl" or external.get("metadata", {}).get("authority") != "USER_PRIMARY" or external.get("metadata", {}).get("uidCollision") is not False: return False
    if not {"urn:usl:syntax-cli:Source", "urn:usl:syntax-cli:ExternalSubject"}.issubset(set(note.get("types", []))) or note.get("locator") != "kg://personal/" + kg_bridge["publication"]["noteUid"] or note.get("metadata", {}).get("authority") != "SECONDARY_AI" or note.get("metadata", {}).get("canonicalScope") != "PENDING_OR_PRELIMINARY" or note.get("metadata", {}).get("reviewRequired") is not True: return False
    links_by_meaning = {}
    for link in candidate["links"]: links_by_meaning.setdefault(link["meaning"].split(":")[-1], []).append(link)
    described = [link for link in links_by_meaning.get("describes_subject", []) if parts(link) == {"subject": "subject:usl", "external": "sym:Concept:usl"}]
    if len(described) != 1 or described[0].get("metadata", {}).get("authority") != "SECONDARY_AI" or described[0].get("metadata", {}).get("equivalence") != "NOT_CLAIMED": return False
    decisions = {parts(link).get("statement") for link in links_by_meaning.get("current_decision", []) if parts(link).get("subject") == "subject:usl"}
    if decisions != set(kg_bridge["currentDecisions"]): return False
    tracked = {parts(link).get("task") for link in links_by_meaning.get("tracks_work", []) if parts(link).get("subject") == "subject:usl"}
    if tracked != set(kg_bridge["trackedTasks"]) or "task:C02" not in tracked: return False
    published = [link for link in links_by_meaning.get("published_note", []) if parts(link) == {"record": kg_bridge["publication"]["noteUid"], "external": "sym:Concept:usl"}]
    if len(published) != 1: return False
    metadata = published[0].get("metadata", {})
    return metadata.get("status") == "PUBLISHED_DRAFT" and metadata.get("relationshipStatus") == "PROPOSED" and metadata.get("canonicalScope") == "PENDING_OR_PRELIMINARY" and metadata.get("reviewRequired") is True and metadata.get("sharedKgRelation") == "RECORDED_FROM_READBACK_NOT_RATIFIED"
assert kg_bridge_conforms(raw)
assert completed_binding_work_conforms(raw)

def core_cli_work_conforms(candidate):
    by_id = {r["id"]: r for r in candidate["resources"]}
    tasks = core_plan.get("tasks", [])
    if core_plan.get("schema") != "usl-core-cli-work-plan/v1" or core_plan.get("authority") != "SECONDARY_AI" or core_plan.get("status") not in {"PLANNED", "IN_PROGRESS", "COMPLETED"} or not tasks: return False
    completed = [task for task in tasks if task.get("status") == "COMPLETED" and task.get("implementation") == "COMPLETE"]
    planned = [task for task in tasks if task.get("status") == "PLANNED" and task.get("implementation") == "NOT_STARTED"]
    expected_status = "PLANNED" if not completed else "COMPLETED" if len(completed) == len(tasks) else "IN_PROGRESS"
    if core_plan.get("status") != expected_status or len(completed) + len(planned) != len(tasks) or any(t.get("proofStatus") != "NOT_PROVEN" or not t.get("acceptance") or bool(t.get("verificationReceipt")) != (t in completed) for t in tasks): return False
    expected_sources = core_plan.get("sourceEvidence", [])
    if not expected_sources or any(source.get("kind") != "LOCAL_SNAPSHOT" or not source.get("path", "").startswith("src/") or (sha256_commit(catalog["sourceCommit"], source["path"]) or "").removeprefix("sha256:") != source.get("sha256") for source in expected_sources): return False
    links_by_meaning = {}
    for link in candidate["links"]: links_by_meaning.setdefault(link["meaning"].split(":")[-1], []).append(link)
    def parts(link): return {p["role"]: p["resource"] for p in link["participants"]}
    source_ids = {"artifact:core-cli:" + source["path"] for source in expected_sources}
    for task in tasks:
        criterion = "criterion:" + task["id"].split(":", 1)[1]
        task_metadata = by_id.get(task["id"], {}).get("metadata", {})
        is_completed = task in completed
        if task_metadata.get("status") != task["status"] or task_metadata.get("implementation") != task["implementation"] or task_metadata.get("proofStatus") != "NOT_PROVEN" or task_metadata.get("dependsOn") != task["dependsOn"] or by_id.get(criterion, {}).get("metadata", {}).get("status") != ("PASS_RECORDED" if is_completed else "PLANNED_NOT_EXECUTED"): return False
        work = [l for l in links_by_meaning.get("planned_work", []) if parts(l).get("task") == task["id"]]
        if len(work) != 1 or parts(work[0]) != {"task": task["id"], "criterion": criterion, "requirement": "user:core-cli-next"}: return False
        deps = {parts(l).get("prerequisite") for l in links_by_meaning.get("task_depends_on", []) if parts(l).get("task") == task["id"]}
        if deps != set(task["dependsOn"]): return False
        evidence = {parts(l).get("artifact") for l in links_by_meaning.get("planned_evidence", []) if parts(l).get("task") == task["id"]}
        if not is_completed:
            if evidence != source_ids: return False
            continue
        if evidence: return False
        receipt_path = task["verificationReceipt"]
        if not isinstance(receipt_path, str) or not receipt_path.startswith("research/architecture/") or not receipt_path.endswith(".receipt.json"): return False
        receipt_file = root / receipt_path
        if not receipt_file.is_file(): return False
        core_receipt = json.loads(receipt_file.read_text())
        if core_receipt.get("schema") != "usl-core-cli-verification-receipt/v1" or core_receipt.get("authority") != "SECONDARY_AI" or core_receipt.get("status") != "PASS" or not isinstance(core_receipt.get("sourcePins"), dict) or not isinstance(core_receipt.get("sourceCommit"), str): return False
        try:
            commit_sources = set(__import__("subprocess").check_output(["git", "ls-tree", "-r", "--name-only", core_receipt["sourceCommit"], "src"], cwd=root, text=True).splitlines())
        except Exception:
            return False
        required_pins = commit_sources | {"package.json", "package-lock.json", "tsconfig.json", "test/cli.test.ts", "test/cli-help.test.ts"}
        if not required_pins.issubset(core_receipt["sourcePins"]): return False
        for path, digest in core_receipt["sourcePins"].items():
            if not (path.startswith(("src/", "docs/", "test/")) or path in {"package.json", "package-lock.json", "tsconfig.json"}): return False
            try:
                committed = __import__("subprocess").check_output(["git", "show", f'{core_receipt["sourceCommit"]}:{path}'], cwd=root)
            except Exception:
                return False
            if "sha256:" + hashlib.sha256(committed).hexdigest() != digest: return False
        receipt_task = next((item for item in core_receipt.get("tasks", []) if item.get("id") == task["id"]), {})
        commands = [item for item in receipt_task.get("evidence", []) if item.get("kind") == "command"]
        sources = [item for item in receipt_task.get("evidence", []) if item.get("kind") == "source"]
        tests = [path for path in task["deliverables"] if path.startswith("test/")]
        if receipt_task.get("status") != "PASS" or not any(item.get("exitCode") == 0 and item.get("command", "").strip() and item.get("observed", "").strip() for item in commands) or not all(path in core_receipt["sourcePins"] and any(item.get("path") == path and item.get("sha256") == core_receipt["sourcePins"][path] for item in sources) for path in task["deliverables"]) or not all(any(path in item.get("command", "") for item in commands) for path in tests): return False
        receipt_id = "source:core-cli-receipt:" + task["id"].split(":", 1)[1]
        receipt_resource = by_id.get(receipt_id, {})
        if receipt_resource.get("metadata", {}).get("sourceDigest") != sha256_file(receipt_file) or receipt_resource.get("metadata", {}).get("sourceCommit") != core_receipt["sourceCommit"]: return False
        complete = [l for l in links_by_meaning.get("completed_by", []) if parts(l).get("task") == task["id"]]
        if len(complete) != 1 or parts(complete[0]) != {"task": task["id"], "criterion": criterion, "evidence": receipt_id} or complete[0].get("metadata", {}).get("proofStatus") != "NOT_PROVEN": return False
    return task_dag_acyclic({t["id"]: t["dependsOn"] for t in tasks})
assert core_cli_work_conforms(raw)
def compression_trace_conforms(candidate):
    by_id = {r["id"]: r for r in candidate["resources"]}
    def parts(link): return {p["role"]: p["resource"] for p in link["participants"]}
    traces = [l for l in candidate["links"] if l["meaning"].endswith("evaluated_by")]
    expected_source_pairs = {("technique:compression:" + source["id"], "source:compression:" + source["id"]) for source in compression_sources}
    if {(parts(link).get("technique"), parts(link).get("evidence")) for link in traces} != expected_source_pairs: return False
    for link in traces:
        p = parts(link)
        if set(p) != {"requirement", "technique", "evidence"} or p["requirement"] != "user:compression-cost": return False
        if not p["technique"].startswith("technique:compression:") or not p["evidence"].startswith("source:compression:"): return False
        if link.get("metadata", {}).get("claimStatus") != "MEASUREMENT_REQUIRED": return False
        source = by_id.get(p["evidence"], {}).get("metadata", {})
        if source.get("sourceReview") != "DOCUMENT_READ_" + source.get("checkedAt", "") or source.get("remoteObservation") != "NOT_PERFORMED_BY_USL_RUNTIME": return False
    measured = [l for l in candidate["links"] if l["meaning"].endswith("measured_by")]
    expected_measured = {"openai-token-counting", "source-minification", "compact-full", "dictionary-table", "compact-unchanged", "binary-transport"}
    measured_techniques = {parts(link).get("technique", "").removeprefix("technique:compression:") for link in measured}
    if measured_techniques != expected_measured: return False
    for link in measured:
        p = parts(link)
        if p.get("requirement") != "user:compression-cost" or p.get("benchmark") != "artifact:compression-benchmark" or set(p) != {"requirement", "technique", "benchmark"}: return False
        if link.get("metadata", {}).get("claimStatus") != "NO_BILLING_OR_QUALITY_CLAIM": return False
    local_expected = {
        "source-minification": ("source-original", "BENCHMARK_EXPERIMENT_NOT_USL_RUNTIME_FEATURE"),
        "compact-full": ("context-minified", "IMPLEMENTED_CURRENT_USL_FEATURE"),
        "dictionary-table": ("context-minified", "BENCHMARK_EXPERIMENT_NOT_USL_RUNTIME_FEATURE"),
        "compact-unchanged": ("compact-full", "IMPLEMENTED_CURRENT_USL_FEATURE"),
        "binary-transport": ("each text payload lane", "BENCHMARK_TRANSPORT_COMPARISON_NOT_USL_RUNTIME_FEATURE"),
    }
    for technique, (baseline, implementation_status) in local_expected.items():
        metadata = by_id.get("technique:compression:" + technique, {}).get("metadata", {})
        if metadata.get("status") != "LOCAL_OFFLINE_MEASUREMENT" or metadata.get("baseline") != baseline or metadata.get("implementationStatus") != implementation_status or not metadata.get("lanes") or not metadata.get("limitation"): return False
    return True
assert compression_trace_conforms(raw)
def clone(): return json.loads(json.dumps(raw))
broken_ref = clone(); broken_ref["links"][0]["participants"][0]["resource"] = "missing:resource"
assert not conforms(broken_ref)
broken_role = clone(); broken_role["links"][0]["participants"][0]["role"] = "wrong_role"
assert not conforms(broken_role)
wrong_proposal_claim = clone()
for resource in wrong_proposal_claim["resources"]:
    if resource["id"] == "proposal:m-map": resource["metadata"]["status"] = "IMPLEMENTED_CURRENT_SOURCE"
assert not claims_conform(wrong_proposal_claim)
cycle = {task["id"]: list(task["dependsOn"]) for task in work_plan["tasks"]}
cycle["task:P01"].append("task:P03")
assert not task_dag_acyclic(cycle)
missing_criterion = clone()
missing_criterion["resources"] = [r for r in missing_criterion["resources"] if r["id"] != "criterion:P01"]
assert not completed_binding_work_conforms(missing_criterion)
false_completed = clone()
for resource in false_completed["resources"]:
    if resource["id"] == "task:P01": resource["metadata"]["status"] = "PLANNED"
assert not completed_binding_work_conforms(false_completed)
missing_completion_evidence = clone()
missing_completion_evidence["links"] = [link for link in missing_completion_evidence["links"] if not (link["meaning"].endswith("completed_by") and any(participant["resource"] == "task:P01" for participant in link["participants"]))]
assert not completed_binding_work_conforms(missing_completion_evidence)
missing_core_dependency = clone()
for resource in missing_core_dependency["resources"]:
    if resource["id"] == "task:C03": resource["metadata"]["dependsOn"] = []
assert not core_cli_work_conforms(missing_core_dependency)
if any(task["id"] == "task:C01" and task["status"] == "COMPLETED" for task in core_plan["tasks"]):
    missing_c01_completion = clone()
    missing_c01_completion["links"] = [link for link in missing_c01_completion["links"] if not (link["meaning"].endswith("completed_by") and any(participant["resource"] == "task:C01" for participant in link["participants"]))]
    assert not core_cli_work_conforms(missing_c01_completion)
    forged_c01_proof = clone()
    for link in forged_c01_proof["links"]:
        if link["meaning"].endswith("completed_by") and any(participant["resource"] == "task:C01" for participant in link["participants"]): link["metadata"]["proofStatus"] = "PROVEN"
    assert not core_cli_work_conforms(forged_c01_proof)
old_test_only = json.loads(json.dumps(receipt))
for task in old_test_only["tasks"]:
    if task["id"] == "task:P02":
        task["evidence"] = [item for item in task["evidence"] if item.get("kind") != "command"] + [{"kind":"command", "command":"node --import tsx --test test/navigation.test.ts", "exitCode":0, "observed":"old test only"}]
saved_receipt = receipt
receipt = old_test_only
assert not completed_binding_work_conforms(raw)
receipt = saved_receipt
broken_compression = clone()
broken_compression["links"] = [link for link in broken_compression["links"] if not (link["meaning"].endswith("measured_by") and any(participant["resource"] == "technique:compression:compact-full" for participant in link["participants"]))]
assert not compression_trace_conforms(broken_compression)
wrong_kg_native_uid = clone()
for resource in wrong_kg_native_uid["resources"]:
    if resource["id"] == "sym:Concept:usl": resource["metadata"]["nativeUid"] = "sym:Concept:not-usl"
assert not kg_bridge_conforms(wrong_kg_native_uid)
wrong_kg_authority = clone()
for resource in wrong_kg_authority["resources"]:
    if resource["id"] == kg_bridge["publication"]["noteUid"]: resource["metadata"]["authority"] = "USER_PRIMARY"
assert not kg_bridge_conforms(wrong_kg_authority)
forged_publication_claim = clone()
for link in forged_publication_claim["links"]:
    if link["meaning"].endswith("published_note"): link["metadata"]["relationshipStatus"] = "ACTIVE"
assert not kg_bridge_conforms(forged_publication_claim)
# Query the actual JSON-LD projection and run both shared and task-specific shapes.
data = Graph().parse(jsonld_path, format="json-ld")
shape_graph = Graph().parse(root / "schemas/resource-graph.shacl.ttl", format="turtle")
shape_graph.parse(shape_path, format="turtle")
assert validate(data, shacl_graph=shape_graph)[0]
usl, prov = Namespace("urn:usl:vocab:"), Namespace("http://www.w3.org/ns/prov#")
links_rdf = list(data.subjects(RDF.type, usl.Link))
assert links_rdf
def native(node): return str(next(data.objects(node, usl.nativeId)))
meaning_ids = {native(next(data.objects(link, usl.meaning))) for link in links_rdf}
assert {"urn:usl:syntax-cli:interpreted_as", "urn:usl:syntax-cli:addresses", "urn:usl:syntax-cli:trace"}.issubset(meaning_ids)
trace = next(link for link in links_rdf if native(next(data.objects(link, usl.meaning))).endswith("trace"))
assert len(list(data.objects(trace, usl.participant))) == 3
assert any(data.triples((None, RDF.type, prov.Activity))) and any(data.triples((None, RDF.type, prov.Agent)))
assert any(link["meaning"].endswith("interpreted_as") and link.get("metadata", {}).get("authority") == "SECONDARY_AI" for link in links)
assert any(link["meaning"].endswith("addresses") and link["participants"][0]["resource"] == "proposal:graph-cli" and link["participants"][1]["resource"] == "user:syntax-cli" for link in links)
assert any(link["meaning"].endswith("evaluated_by") and len(link["participants"]) == 3 for link in links)
task_resources = [r for r in resources.values() if "urn:usl:syntax-cli:Task" in r["types"]]
assert {r["id"] for r in task_resources} == {"task:P01", "task:P02", "task:P03", "task:C01", "task:C02", "task:C03", "task:C04"}
task_meta = {r["id"]: r["metadata"] for r in task_resources}
assert task_meta["task:P02"]["dependsOn"] == ["task:P01"]
assert task_meta["task:P03"]["dependsOn"] == ["task:P02"]
assert task_meta["task:C02"]["dependsOn"] == ["task:C01"]
assert task_meta["task:C03"]["dependsOn"] == ["task:C01"]
assert task_meta["task:C04"]["dependsOn"] == ["task:C01"]
ready_core_tasks = sorted(task for task, metadata in task_meta.items()
    if task.startswith("task:C") and metadata["status"] == "PLANNED"
    and all(task_meta[dependency]["status"] == "COMPLETED" for dependency in metadata["dependsOn"]))
expected_ready_core_tasks = ["task:C01"] if core_plan["status"] == "PLANNED" else ["task:C02", "task:C03", "task:C04"] if core_plan["status"] == "IN_PROGRESS" else []
assert ready_core_tasks == expected_ready_core_tasks
for proposal in ["proposal:weighted-assertion", "proposal:hierarchy", "proposal:m-map"]:
    assert resources[proposal]["metadata"]["placement"] == "ADDON_RESPONSIBILITY"
for boundary in ["limitation:weights", "limitation:m-map", "limitation:hierarchy"]:
    assert resources[boundary]["metadata"]["status"] == "SCOPE_BOUNDARY"
def copy_graph():
    result = Graph()
    for triple in data: result.add(triple)
    return result
broken_ref_rdf = copy_graph(); participant = next(broken_ref_rdf.objects(links_rdf[0], usl.participant)); broken_ref_rdf.remove((participant, usl.resource, None))
assert not validate(broken_ref_rdf, shacl_graph=shape_graph, abort_on_first=True)[0]
broken_role_rdf = copy_graph(); participant = next(broken_role_rdf.objects(links_rdf[0], usl.participant)); broken_role_rdf.set((participant, usl.role, Literal("wrong_role")))
assert not validate(broken_role_rdf, shacl_graph=shape_graph, abort_on_first=True)[0]
wrong_status_rdf = copy_graph(); wrong_status_rdf.set((links_rdf[0], usl.status, Literal("IMPLEMENTED_AND_PROVEN")))
assert not validate(wrong_status_rdf, shacl_graph=shape_graph, abort_on_first=True)[0]
negative_cases = 16 + (2 if core_plan["status"] != "PLANNED" else 0)
print(json.dumps({"scope":"ARCHITECTURE_GRAPH_STRUCTURE_AND_COMPETENCY_QUERIES_ONLY","resources":len(resources),"links":len(links),"tasks":len(task_resources),"readyCoreTasks":ready_core_tasks,"compressionSources":len(compression_sources),"triples":len(data),"negative_cases":negative_cases,"graph_sha256":hashlib.sha256(graph_path.read_bytes()).hexdigest()}, ensure_ascii=False))
