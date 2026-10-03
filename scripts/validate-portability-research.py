#!/usr/bin/env python3
"""Validate bounded portability research trace structure; no runtime or external-conformance claim."""
import copy
import hashlib
import json
import pathlib
import re
import subprocess
import sys

from pyshacl import validate
from rdflib import Graph, Literal, Namespace, RDF, URIRef

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE = ROOT / "research" / "portability-research"
DATA_PATH, TRACE_PATH = BASE / "research.json", BASE / "trace.jsonld"
SHAPES_PATH = ROOT / "schemas" / "portability-research" / "research.shacl.ttl"
R = Namespace("urn:usl:portability-research:")
MAX_BYTES = 2 * 1024 * 1024
ID_PATTERNS = {"sources": r"reference:[A-Za-z0-9._-]+", "localSources": r"source:[A-Za-z0-9._/-]+", "decisions": r"decision:PR[0-9]+", "checks": r"check:PR[0-9]+-[0-9]+", "observations": r"observation:[A-Za-z0-9._-]+"}

def require(value, message):
    if not value: raise AssertionError(message)

def read_json(path):
    raw = path.read_bytes(); require(len(raw) <= MAX_BYTES, f"input exceeds byte budget: {path.name}")
    try: value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error: raise AssertionError(f"invalid UTF-8 JSON: {path.name}") from error
    require(isinstance(value, dict), f"object required: {path.name}")
    return value

def sha(path): return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
def clone(graph):
    result = Graph()
    for triple in graph: result.add(triple)
    return result
def conforms(data, shapes): return validate(data, shacl_graph=shapes, advanced=True)[0]
def query(data, text): return list(data.query(text))
def rejected(action, message):
    try: action()
    except AssertionError: return
    raise AssertionError(message)
def ids(items, kind):
    result = [item.get("id") for item in items]
    require(all(isinstance(value, str) and re.fullmatch(ID_PATTERNS[kind], value) for value in result), f"invalid {kind} ID")
    require(len(result) == len(set(result)), f"duplicate {kind} ID")
    return set(result)

def dataset_ok(value, pins=False):
    require(value.get("schema") == "usl-portability-research/v1", "research schema mismatch")
    require(value.get("authority") == "SECONDARY_AI" and value.get("status") == "RESEARCHED_PROPOSAL", "research authority/status mismatch")
    require(isinstance(value.get("sourceCommit"), str) and re.fullmatch(r"[0-9a-f]{7,64}", value["sourceCommit"]), "invalid baseline commit")
    groups = {name: value.get(name) for name in ID_PATTERNS}
    require(all(isinstance(items, list) and items for items in groups.values()), "research arrays required")
    source_ids, local_ids, decision_ids, check_ids, observation_ids = (ids(groups[name], name) for name in ID_PATTERNS)
    require(len(observation_ids) == len(groups["observations"]), "duplicate observation IDs")
    task_ids = {f"task:PT{number:02d}" for number in range(1, 8)}
    requirement_ids = {f"requirement:R{number:02d}" for number in range(1, 8)}
    require(isinstance(value.get("tasks"), list) and {item.get("id") for item in value["tasks"]} == task_ids, "imported task ID set differs from portability plan")
    require(isinstance(value.get("requirements"), list) and {item.get("id") for item in value["requirements"]} == requirement_ids, "imported requirement ID set differs from portability plan")
    for source in groups["sources"]:
        require(all(isinstance(source.get(key), str) and source[key] for key in ("title", "url", "publicationStatus", "sections", "checkedOn", "fact", "limit")), "incomplete external source")
        require(source["url"].startswith("https://"), "external source URL must be HTTPS")
        if "statusUrl" in source: require(isinstance(source["statusUrl"], str) and source["statusUrl"].startswith("https://"), "invalid source status URL")
        if source["id"] == "reference:idempotency": require(source["publicationStatus"] == "IETF_EXPIRED_INTERNET_DRAFT", "idempotency draft status mislabelled")
        if source["id"] == "reference:shacl12": require(source["publicationStatus"] == "W3C_WORKING_DRAFT", "SHACL 1.2 status mislabelled")
        if source["id"] == "reference:shacl2017": require(source["publicationStatus"] == "W3C_RECOMMENDATION", "SHACL 2017 status mislabelled")
    for source in groups["localSources"]:
        require(all(isinstance(source.get(key), str) and source[key] for key in ("path", "sha256", "sourceCommit")), "incomplete local source")
        require(not pathlib.PurePosixPath(source["path"]).is_absolute() and ".." not in pathlib.PurePosixPath(source["path"]).parts, "unsafe local source path")
        require(re.fullmatch(r"sha256:[0-9a-f]{64}", source["sha256"]) is not None and source["sourceCommit"] == value["sourceCommit"], "invalid local source pin")
        if pins:
            path = ROOT / source["path"]; require(path.is_file() and sha(path) == source["sha256"], "local source file pin drift")
            shown = subprocess.run(["git", "show", f"{value['sourceCommit']}:{source['path']}"], cwd=ROOT, capture_output=True)
            require(shown.returncode == 0 and "sha256:" + hashlib.sha256(shown.stdout).hexdigest() == source["sha256"], "local source Git pin drift")
    for decision in groups["decisions"]:
        require(decision.get("authority") == "SECONDARY_AI" and decision.get("status") == "PROPOSED" and decision.get("derivation") == "INFERENCE", "decision state promoted")
        require(decision.get("priority") in {"P0", "P1", "P2"} and isinstance(decision.get("claim"), str) and decision["claim"], "incomplete decision")
        if "currentCoverage" in decision: require(isinstance(decision["currentCoverage"], str) and decision["currentCoverage"], "invalid current coverage claim")
        for field, permitted in [("sourceIds", source_ids), ("localSourceIds", local_ids), ("taskIds", task_ids), ("requirementIds", requirement_ids), ("checkIds", check_ids), ("dependsOn", decision_ids)]:
            values = decision.get(field, []); require(isinstance(values, list), f"decision {field} must be array")
            if field != "dependsOn": require(values, f"decision {field} required")
            require(len(values) == len(set(values)) and set(values) <= permitted and decision["id"] not in values, f"unsupported decision {field}")
    for check in groups["checks"]:
        require(check.get("decisionId") in decision_ids and check.get("execution") == "NOT_RUN", "misdirected or promoted acceptance check")
        require(all(isinstance(check.get(key), str) and check[key] for key in ("expectation", "negativeCase")), "incomplete acceptance check")
    declared_checks = {(decision["id"], check) for decision in groups["decisions"] for check in decision["checkIds"]}
    actual_checks = {(check["decisionId"], check["id"]) for check in groups["checks"]}
    require(declared_checks == actual_checks, "decision/check coverage differs")
    for observation in groups["observations"]:
        require(observation.get("method") in {"PURE_RUNTIME_PROBE", "STATIC_CODE_REVIEW"} and observation.get("status") == "OBSERVED", "observation state/method mismatch")
        values = observation.get("localSourceIds"); require(isinstance(values, list) and values and set(values) <= local_ids, "unsupported observation local source")
        require(all(isinstance(observation.get(key), str) and observation[key] for key in ("result", "scope")), "incomplete observation")
    edges = {item["id"]: set(item["dependsOn"]) for item in groups["decisions"]}
    active, done = set(), set()
    def visit(node):
        if node in active: return False
        if node in done: return True
        active.add(node); valid = all(visit(parent) for parent in edges[node]); active.remove(node)
        if valid: done.add(node)
        return valid
    require(all(visit(node) for node in edges), "decision dependency cycle")
    return groups

def main():
    for path in (DATA_PATH, TRACE_PATH, SHAPES_PATH): require(path.is_file(), f"missing research input: {path.relative_to(ROOT)}")
    dataset = read_json(DATA_PATH); groups = dataset_ok(dataset, pins=True)
    data, shapes = Graph().parse(TRACE_PATH, format="json-ld"), Graph().parse(SHAPES_PATH, format="turtle")
    require(conforms(data, shapes), "research RDF does not conform to SHACL")
    # Exact endpoint and state tuples: graph counts alone cannot prove a decision's evidence chain.
    expected_support = {(d["id"], x) for d in groups["decisions"] for x in d["sourceIds"]}
    expected_inspects = {(d["id"], x) for d in groups["decisions"] for x in d["localSourceIds"]}
    expected_tasks = {(d["id"], x) for d in groups["decisions"] for x in d["taskIds"]}
    expected_reqs = {(d["id"], x) for d in groups["decisions"] for x in d["requirementIds"]}
    expected_checks = {(d["id"], x) for d in groups["decisions"] for x in d["checkIds"]}
    expected_deps = {(d["id"], x) for d in groups["decisions"] for x in d["dependsOn"]}
    def edges(predicate): return {(str(row.decision), str(row.value)) for row in query(data, f"PREFIX r:<urn:usl:portability-research:> SELECT ?decision ?value WHERE {{ ?decision a r:Decision ; r:{predicate} ?value }}")}
    for predicate, expected in [("supportedBy", expected_support), ("inspects", expected_inspects), ("implementsTask", expected_tasks), ("addresses", expected_reqs), ("validatedBy", expected_checks), ("dependsOn", expected_deps)]: require(edges(predicate) == expected, f"exact decision {predicate} endpoints differ")
    expected_checks_detail = {(x["id"], x["decisionId"], x["execution"], x["expectation"], x["negativeCase"]) for x in groups["checks"]}
    actual_checks_detail = {(str(x.check), str(x.decision), str(x.execution), str(x.expectation), str(x.negative)) for x in query(data, "PREFIX r:<urn:usl:portability-research:> SELECT ?check ?decision ?execution ?expectation ?negative WHERE {?check a r:AcceptanceCheck;r:forDecision ?decision;r:execution ?execution;r:expectation ?expectation;r:negativeCase ?negative}")}
    require(actual_checks_detail == expected_checks_detail, "task/requirement/check chain differs")
    expected_chain = {(requirement, decision["id"], task, check) for decision in groups["decisions"] for requirement in decision["requirementIds"] for task in decision["taskIds"] for check in decision["checkIds"]}
    actual_chain = {(str(x.requirement), str(x.decision), str(x.task), str(x.check)) for x in query(data, "PREFIX r:<urn:usl:portability-research:> SELECT ?requirement ?decision ?task ?check WHERE {?requirement a r:Requirement . ?decision a r:Decision;r:addresses ?requirement;r:implementsTask ?task;r:validatedBy ?check . ?task a r:Task . ?check a r:AcceptanceCheck;r:forDecision ?decision}")}
    require(actual_chain == expected_chain, "requirement/decision/task/check typed chain differs")
    expected_observations = {(o["id"], x, o["method"], o["status"], o["result"], o["scope"]) for o in groups["observations"] for x in o["localSourceIds"]}
    actual_observations = {(str(x.observation), str(x.source), str(x.method), str(x.status), str(x.result), str(x.scope)) for x in query(data, "PREFIX r:<urn:usl:portability-research:> SELECT ?observation ?source ?method ?status ?result ?scope WHERE {?observation a r:Observation;r:about ?source;r:method ?method;r:status ?status;r:result ?result;r:scope ?scope}")}
    require(actual_observations == expected_observations, "observation/source endpoints differ")
    expected_states = {(d["id"], d["authority"], d["status"], d["derivation"], d["priority"], d["claim"]) for d in groups["decisions"]}
    actual_states = {(str(x.decision), str(x.authority), str(x.status), str(x.derivation), str(x.priority), str(x.claim)) for x in query(data, "PREFIX r:<urn:usl:portability-research:> SELECT ?decision ?authority ?status ?derivation ?priority ?claim WHERE {?decision a r:Decision;r:authority ?authority;r:status ?status;r:derivation ?derivation;r:priority ?priority;r:claim ?claim}")}
    require(actual_states == expected_states, "decision authority/state tuples differ")
    expected_sources = {(x["id"], x["url"], x["publicationStatus"], x["checkedOn"], x["fact"], x["limit"]) for x in groups["sources"]}
    actual_sources = {(str(x.source), str(x.url), str(x.status), str(x.checked), str(x.fact), str(x.limit)) for x in query(data, "PREFIX r:<urn:usl:portability-research:> SELECT ?source ?url ?status ?checked ?fact ?limit WHERE {?source a r:Source;r:url ?url;r:publicationStatus ?status;r:checkedOn ?checked;r:fact ?fact;r:limit ?limit}")}
    require(actual_sources == expected_sources, "external source metadata tuples differ")
    expected_local = {(x["id"], x["path"], x["sha256"], x["sourceCommit"]) for x in groups["localSources"]}
    actual_local = {(str(x.source), str(x.path), str(x.digest), str(x.commit)) for x in query(data, "PREFIX r:<urn:usl:portability-research:> SELECT ?source ?path ?digest ?commit WHERE {?source a r:LocalSource;r:path ?path;r:sha256 ?digest;r:sourceCommit ?commit}")}
    require(actual_local == expected_local, "local source metadata tuples differ")
    # Negative cases: malformed dataset and graph variants must not silently become research evidence.
    bad = copy.deepcopy(dataset); bad["decisions"][0]["sourceIds"] = ["reference:missing"]
    rejected(lambda: dataset_ok(bad), "broken source reference accepted")
    bad = copy.deepcopy(dataset); bad["decisions"][0]["dependsOn"] = [bad["decisions"][-1]["id"]]; bad["decisions"][-1]["dependsOn"] = [bad["decisions"][0]["id"]]
    rejected(lambda: dataset_ok(bad), "decision cycle accepted")
    bad = clone(data); source = next(data.subjects(RDF.type, R.Source)); bad.remove((source, RDF.type, R.Source)); require(not conforms(bad, shapes), "wrong source RDF type accepted")
    decision = next(data.subjects(RDF.type, R.Decision)); bad = clone(data); bad.set((decision, R.status, Literal("RATIFIED"))); require(not conforms(bad, shapes), "decision state promotion accepted")
    check = next(data.subjects(RDF.type, R.AcceptanceCheck)); bad = clone(data); bad.set((check, R.forDecision, URIRef(next(x for x in groups["decisions"] if x["id"] != str(next(data.objects(check, R.forDecision)) ))["id"]))); require(not conforms(bad, shapes), "misdirected check accepted")
    bad = copy.deepcopy(dataset); bad["localSources"][0]["sha256"] = "sha256:" + "0" * 64
    rejected(lambda: dataset_ok(bad, pins=True), "local source pin drift accepted")
    bad = copy.deepcopy(dataset); next(x for x in bad["sources"] if x["id"] == "reference:idempotency")["publicationStatus"] = "IETF_STANDARDS_TRACK"
    rejected(lambda: dataset_ok(bad), "expired draft mislabel accepted")
    bad = clone(data); bad.add((decision, R.dependsOn, decision)); require(not conforms(bad, shapes), "RDF dependency cycle accepted")
    print(json.dumps({"rdf":"PARSED","shacl":"CONFORMS","competencyQueries":12,"negativeCases":8,"scope":"RESEARCH_TRACE_ONLY_NO_RUNTIME_EXTERNAL_CONFORMANCE_OR_EFFECT_CLAIM"}))

if __name__ == "__main__":
    try: main()
    except AssertionError as error: print(f"portability-research validation failed: {error}", file=sys.stderr); raise SystemExit(1)
