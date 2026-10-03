#!/usr/bin/env python3
"""Record real DG01 tests and a typed progress observation separate from the plan."""
import argparse
import hashlib
import json
import pathlib
import platform
import re
import subprocess
from datetime import datetime, timezone

from pyshacl import validate
from rdflib import Graph, Literal, Namespace, RDF, URIRef

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE = ROOT / "research/development-progress"
D = Namespace("urn:usl:development-progress:")
PROV = Namespace("http://www.w3.org/ns/prov#")
TEST_FILES = ["test/checkout-guard.test.ts", "test/binding-inspection.test.ts", "test/worktree-lifecycle.test.ts", "test/worktree-execution.test.ts", "test/worktree-graph-cli.test.ts"]
COMMAND = ["node", "--import", "tsx", "--test", "--test-reporter=tap", *TEST_FILES]
CRITERIA = [f"criterion:DG01-C{i}" for i in range(1, 4)]


def require(value, message):
    if not value:
        raise AssertionError(message)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def sha(value):
    return "sha256:" + hashlib.sha256(value).hexdigest()


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def pins():
    paths = {str(p.relative_to(ROOT)) for p in (ROOT / "src").rglob("*.ts")}
    paths.update(TEST_FILES + ["test/fixtures.ts", "package.json", "package-lock.json", "tsconfig.json",
                              "docs/CHECKOUT_GUARD.md", "scripts/record-development-progress.py",
                              "schemas/development-progress/progress.shacl.ttl", "research/development-plan/plan.json"])
    return [{"path": path, "sha256": sha((ROOT / path).read_bytes())} for path in sorted(paths)]


def parse_tests(log):
    tests = [{"id": "test:" + hashlib.sha256(name.encode()).hexdigest(), "name": name, "status": "PASS"}
             for name in re.findall(r"^ok \d+ - (.+)$", log, re.M)]
    totals = {}
    for key in ["tests", "pass", "fail", "cancelled", "skipped", "todo"]:
        match = re.search(rf"^# {key} (\d+)$", log, re.M)
        require(match, f"missing TAP {key}")
        totals[key] = int(match[1])
    require(totals["tests"] == totals["pass"] == len(tests) > 0 and not any(totals[k] for k in ["fail", "cancelled", "skipped", "todo"]), "tests did not all pass")
    require(len({t["name"] for t in tests}) == len(tests), "duplicate test name")
    for criterion in CRITERIA:
        require(any(t["name"].startswith(criterion.removeprefix("criterion:") + ":") for t in tests), f"no executed evidence for {criterion}")
    return tests, totals


def conform(graph, shapes):
    return validate(graph, shacl_graph=shapes)[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--record", action="store_true")
    mode.add_argument("--check", action="store_true")
    args = parser.parse_args()
    BASE.mkdir(parents=True, exist_ok=True)
    if args.record:
        source_pins = pins()
        commit = git("rev-parse", "HEAD").decode().strip()
        for pin in source_pins:
            require(sha(git("show", f"{commit}:{pin['path']}")) == pin["sha256"], "commit source changes before recording a current execution")
        result = subprocess.run(COMMAND, cwd=ROOT, capture_output=True, text=True, timeout=180)
        require(result.returncode == 0, result.stdout + result.stderr)
        tests, totals = parse_tests(result.stdout)
        require(pins() == source_pins, "sources changed during execution")
        receipt = {"schema": "usl-development-progress/v1", "authority": "SECONDARY_AI",
                   "task": "task:DG01", "implementation": "IMPLEMENTED_LOCAL_SCOPE", "status": "LOCAL_CASES_PASS",
                   "recordedAt": datetime.now(timezone.utc).isoformat(), "sourceCommit": commit,
                   "environment": {"system": platform.system(), "machine": platform.machine(),
                                   "node": subprocess.check_output(["node", "--version"], text=True).strip(),
                                   "git": git("--version").decode().strip()},
                   "command": COMMAND, "pins": source_pins, "tapDigest": sha(result.stdout.encode()),
                   "tests": tests, "totals": totals, "criteria": CRITERIA, "nextTask": "task:PT02",
                   "scope": "OWNER_OPT_IN_CHECKOUT_GUARD_AND_LOCAL_COMPATIBILITY",
                   "atomicSnapshot": "NOT_CLAIMED", "crossPlatformAcceptance": "NOT_RUN",
                   "transfer": "NOT_IMPLEMENTED", "restore": "NOT_IMPLEMENTED", "executionAuthority": "NOT_GRANTED"}
        (BASE / "tests.tap").write_text(result.stdout)
        (BASE / "receipt.json").write_text(encoded(receipt))
    else:
        receipt = json.loads((BASE / "receipt.json").read_text())
    require(receipt["pins"] == pins(), "progress evidence is stale; rerun --record after committing the new sources")
    for pin in receipt["pins"]:
        require(sha(git("show", f"{receipt['sourceCommit']}:{pin['path']}")) == pin["sha256"], "historical execution pin mismatch")
    log = (BASE / "tests.tap").read_text()
    tests, totals = parse_tests(log)
    require(receipt["tests"] == tests and receipt["totals"] == totals and receipt["tapDigest"] == sha(log.encode()), "receipt/TAP mismatch")
    require(receipt["schema"] == "usl-development-progress/v1" and receipt["task"] == "task:DG01"
            and receipt["implementation"] == "IMPLEMENTED_LOCAL_SCOPE" and receipt["status"] == "LOCAL_CASES_PASS"
            and receipt["criteria"] == CRITERIA and receipt["command"] == COMMAND
            and all(receipt[k] == v for k, v in {"authority": "SECONDARY_AI", "atomicSnapshot": "NOT_CLAIMED", "crossPlatformAcceptance": "NOT_RUN", "transfer": "NOT_IMPLEMENTED", "restore": "NOT_IMPLEMENTED", "executionAuthority": "NOT_GRANTED"}.items()), "scope or result promoted")
    p = str(D)
    ref = lambda value: {"@id": value}
    observation = p + "DG01"
    trace = {"@context": {"d": p, "prov": str(PROV)}, "@graph": [
        {"@id": observation, "@type": ["d:ProgressObservation", "prov:Entity"],
         "d:task": ref("task:DG01"), "d:status": receipt["status"], "d:implementation": receipt["implementation"],
         "d:scope": receipt["scope"], "d:recordedAt": receipt["recordedAt"], "d:authority": receipt["authority"],
         "d:sourceCommit": receipt["sourceCommit"], "d:criterion": list(map(ref, CRITERIA)),
         "d:evidence": list(map(lambda t: ref(t["id"]), tests)), "prov:wasDerivedFrom": ref(p + "receipt")},
        {"@id": "task:DG01", "@type": "d:Task"},
        {"@id": p + "receipt", "@type": ["d:Receipt", "prov:Entity"], "d:path": "research/development-progress/receipt.json",
         "d:sha256": sha((BASE / "receipt.json").read_bytes()), "d:tapDigest": receipt["tapDigest"]},
        *[{"@id": criterion, "@type": "d:Criterion", "d:checkedBy": [ref(t["id"]) for t in tests if t["name"].startswith(criterion.removeprefix("criterion:") + ":")]} for criterion in CRITERIA],
        *[{"@id": t["id"], "@type": ["d:TestResult", "prov:Entity"], "d:name": t["name"], "d:status": "PASS"} for t in tests],
    ]}
    content = encoded(trace)
    if args.check:
        require((BASE / "trace.jsonld").read_text() == content, "progress trace drift")
    else:
        (BASE / "trace.jsonld").write_text(content)
    graph = Graph().parse(data=content, format="json-ld")
    shapes = Graph().parse(ROOT / "schemas/development-progress/progress.shacl.ttl", format="turtle")
    require(conform(graph, shapes), "progress SHACL violation")
    rows = {(str(r.criterion), str(r.test)) for r in graph.query("PREFIX d:<urn:usl:development-progress:> SELECT ?criterion ?test WHERE {?criterion a d:Criterion; d:checkedBy ?test. ?test a d:TestResult; d:status 'PASS'.}")}
    require(rows == {(c, t["id"]) for c in CRITERIA for t in tests if t["name"].startswith(c.removeprefix("criterion:") + ":")}, "criterion evidence endpoint mismatch")
    bad = Graph()
    for triple in graph:
        bad.add(triple)
    bad.set((URIRef(observation), D.status, Literal("PROVEN_ALL_PLATFORMS")))
    require(not conform(bad, shapes), "scope promotion must fail")
    bad.set((URIRef(observation), D.status, Literal("LOCAL_CASES_PASS")))
    bad.remove((URIRef(CRITERIA[0]), D.checkedBy, None))
    require(not conform(bad, shapes), "missing criterion evidence must fail")
    document = "\n".join([
        "# USL 개발 진행", "",
        "[원래 개발 계획](DEVELOPMENT_PLAN.md)은 당시의 PLANNED/NOT_RUN 스냅샷으로 보존한다. 이 문서는 별도 실행 기록으로 구현 진행을 나타낸다.", "",
        "## DG01 · 선택형 checkout guard", "",
        f"상태: **{receipt['implementation']} / {receipt['status']}**. 기록 {receipt['recordedAt']}; 소스 `{receipt['sourceCommit']}`.", "",
        "[사용법과 한계](CHECKOUT_GUARD.md). owner가 지정한 바인딩·checkout·HEAD·dirty 조건을 검사하고 prepare 이후 변경을 재검사한다. 기본 inspect와 CLI 실행은 기존 동작을 유지하며 owner 코드가 guard를 명시적으로 호출한다.", "",
        f"실제 로컬 검사 **{totals['tests']}개 PASS**, 실패/건너뜀 0. 실행 환경: {receipt['environment']['system']} / {receipt['environment']['node']} / {receipt['environment']['git']}.", "",
        "| 계획 완료 조건 | 실행한 검사 |", "|---|---|",
        *[f"| {c} | " + "<br>".join(t["name"] for t in tests if t["name"].startswith(c.removeprefix("criterion:") + ":")) + " |" for c in CRITERIA], "",
        "이 기록은 선택한 로컬 fixture의 검증이다. 원자적 snapshot·모든 OS·실제 기기 간 이동·backup/restore 완료를 주장하지 않는다. 다음 순차 구현 대상은 **PT02: 실제 snapshot/export**다.", "",
        "[실행 receipt](../research/development-progress/receipt.json) · [TAP 원문](../research/development-progress/tests.tap) · [typed RDF](../research/development-progress/trace.jsonld) · [SHACL](../schemas/development-progress/progress.shacl.ttl). 실행 당시 source pin과 현재 bytes를 함께 검사하므로 구현 변경 후에는 실제 검사를 다시 실행해야 한다.", "",
        "```sh", "python3 scripts/record-development-progress.py --record", "python3 scripts/record-development-progress.py --check", "```", "",
    ])
    target = ROOT / "docs/DEVELOPMENT_PROGRESS.md"
    if args.check:
        require(target.read_text() == document, "progress document drift")
    else:
        target.write_text(document)
    print(encoded({"mode": "CHECKED" if args.check else "RECORDED", "task": receipt["task"], "tests": totals["tests"], "shacl": "CONFORMS", "negativeCases": 2, "nextTask": receipt["nextTask"]}))


if __name__ == "__main__":
    main()
