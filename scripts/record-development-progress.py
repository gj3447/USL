#!/usr/bin/env python3
"""Record real DG01/PT02 tests and typed progress observations separate from the plan."""
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
TEST_FILES = ["test/checkout-guard.test.ts", "test/binding-inspection.test.ts", "test/worktree-lifecycle.test.ts", "test/worktree-execution.test.ts", "test/worktree-graph-cli.test.ts", "test/portable-transfer-export.test.ts"]
COMMAND = ["node", "--import", "tsx", "--test", "--test-reporter=tap", *TEST_FILES]
TASKS = {
    "DG01": {
        "criteria": [f"criterion:DG01-C{i}" for i in range(1, 4)],
        "title": "선택형 checkout guard", "guide": "CHECKOUT_GUARD.md",
        "scope": "OWNER_OPT_IN_CHECKOUT_GUARD_AND_LOCAL_COMPATIBILITY",
        "description": "owner가 지정한 바인딩·checkout·HEAD·dirty 조건을 검사하고 prepare 이후 변경을 재검사한다. owner 코드가 guard를 명시적으로 호출한다.",
        "limits": "원자적 snapshot·모든 OS·실제 기기 간 이동의 검증은 아니다.",
    },
    "PT02": {
        "criteria": [f"criterion:PT02-C{i}" for i in range(1, 5)],
        "title": "고정 파일 집합 내보내기", "guide": "PORTABLE_TRANSFER_EXPORT.md",
        "scope": "PINNED_FILES_EXPORT_AND_EXPLICIT_EXTERNAL_DEPENDENCIES",
        "description": "명시적으로 선택한 파일의 독립적인 해시·크기·의존성 pin을 확인하고 새 번들을 만든다. 원본 owner ID와 상대 복원 경로를 보존한다.",
        "limits": "CLI의 PINNED_BYTE_SET은 원자적 파일시스템 snapshot이 아니다. Git object/ref/index·submodule·LFS·alternates의 자동 수집과 실제 복원은 구현하지 않는다. Git 복구는 외부 의존성으로 남는다.",
    },
}
CRITERIA = [criterion for task in TASKS.values() for criterion in task["criteria"]]
BOUNDARIES = {"authority": "SECONDARY_AI", "atomicSnapshot": "NOT_CLAIMED",
              "crossPlatformAcceptance": "NOT_RUN", "transfer": "PINNED_FILES_LOCAL_SCOPE",
              "restore": "NOT_IMPLEMENTED", "executionAuthority": "NOT_GRANTED"}


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
                              "docs/CHECKOUT_GUARD.md", "docs/PORTABLE_TRANSFER_EXPORT.md", "scripts/usl-transfer-export.ts",
                              "scripts/record-development-progress.py",
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
        receipt = {"schema": "usl-development-progress/v2", **BOUNDARIES,
                   "observations": [{"task": "task:" + task, "implementation": "IMPLEMENTED_LOCAL_SCOPE",
                                     "status": "LOCAL_CASES_PASS", "scope": config["scope"], "criteria": config["criteria"]}
                                    for task, config in TASKS.items()],
                   "recordedAt": datetime.now(timezone.utc).isoformat(), "sourceCommit": commit,
                   "environment": {"system": platform.system(), "machine": platform.machine(),
                                   "node": subprocess.check_output(["node", "--version"], text=True).strip(),
                                   "git": git("--version").decode().strip()},
                   "command": COMMAND, "pins": source_pins, "tapDigest": sha(result.stdout.encode()),
                   "tests": tests, "totals": totals, "criteria": CRITERIA, "nextTask": "task:PT03"}
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
    expected_observations = [{"task": "task:" + task, "implementation": "IMPLEMENTED_LOCAL_SCOPE",
                              "status": "LOCAL_CASES_PASS", "scope": config["scope"], "criteria": config["criteria"]}
                             for task, config in TASKS.items()]
    require(receipt["schema"] == "usl-development-progress/v2"
            and receipt["observations"] == expected_observations and receipt["nextTask"] == "task:PT03"
            and receipt["criteria"] == CRITERIA and receipt["command"] == COMMAND
            and all(receipt[k] == v for k, v in BOUNDARIES.items()), "scope or result promoted")
    p = str(D)
    ref = lambda value: {"@id": value}
    trace = {"@context": {"d": p, "prov": str(PROV)}, "@graph": [
        *[{"@id": p + observation["task"].removeprefix("task:"), "@type": ["d:ProgressObservation", "prov:Entity"],
           "d:task": ref(observation["task"]), "d:status": observation["status"],
           "d:implementation": observation["implementation"], "d:scope": observation["scope"],
           "d:recordedAt": receipt["recordedAt"], "d:authority": receipt["authority"],
           "d:sourceCommit": receipt["sourceCommit"], "d:criterion": list(map(ref, observation["criteria"])),
           "d:evidence": [ref(t["id"]) for t in tests if any(t["name"].startswith(c.removeprefix("criterion:") + ":") for c in observation["criteria"])],
           "prov:wasDerivedFrom": ref(p + "receipt")} for observation in receipt["observations"]],
        *[{"@id": "task:" + task, "@type": "d:Task"} for task in TASKS],
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
    bad.set((URIRef(p + "DG01"), D.status, Literal("PROVEN_ALL_PLATFORMS")))
    require(not conform(bad, shapes), "scope promotion must fail")
    bad.set((URIRef(p + "DG01"), D.status, Literal("LOCAL_CASES_PASS")))
    bad.remove((URIRef(CRITERIA[0]), D.checkedBy, None))
    require(not conform(bad, shapes), "missing criterion evidence must fail")
    bad = Graph()
    for triple in graph:
        bad.add(triple)
    bad.remove((URIRef(p + "PT02"), D.criterion, URIRef("criterion:PT02-C4")))
    require(not conform(bad, shapes), "PT02 requires all four declared criteria")
    lines = [
        "# USL 개발 진행", "",
        "[원래 개발 계획](DEVELOPMENT_PLAN.md)은 당시의 PLANNED/NOT_RUN 스냅샷으로 보존한다. 이 문서는 별도 실행 기록으로 구현 진행을 나타낸다.", "",
        f"기록 {receipt['recordedAt']}; 소스 `{receipt['sourceCommit']}`.", "",
        f"실제 로컬 검사 **{totals['tests']}개 PASS**, 실패/건너뜀 0. 실행 환경: {receipt['environment']['system']} / {receipt['environment']['node']} / {receipt['environment']['git']}.", "",
    ]
    for task, config in TASKS.items():
        lines += [f"## {task} · {config['title']}", "",
                  "상태: **IMPLEMENTED_LOCAL_SCOPE / LOCAL_CASES_PASS**. " + config["description"], "",
                  f"[사용법과 한계]({config['guide']}). " + config["limits"], "",
                  "| 계획 완료 조건 | 실행한 검사 |", "|---|---|"]
        lines += [f"| {c} | " + "<br>".join(t["name"] for t in tests if t["name"].startswith(c.removeprefix("criterion:") + ":")) + " |" for c in config["criteria"]]
        lines += [""]
    lines += [
        "다음 순차 구현 대상은 **PT03: 새 목적지에 검증 후 복원**이다. 실제 다른 컴퓨터에서의 복원·재연결 인수검사는 후속 단계다. 실행·owner 권한은 이 기록으로 부여되지 않는다.", "",
        "[실행 receipt](../research/development-progress/receipt.json) · [TAP 원문](../research/development-progress/tests.tap) · [typed RDF](../research/development-progress/trace.jsonld) · [SHACL](../schemas/development-progress/progress.shacl.ttl). 실행 당시 source pin과 현재 bytes를 함께 검사하므로 구현 변경 후에는 실제 검사를 다시 실행해야 한다.", "",
        "```sh", "python3 scripts/record-development-progress.py --record", "python3 scripts/record-development-progress.py --check", "```", "",
    ]
    document = "\n".join(lines)
    target = ROOT / "docs/DEVELOPMENT_PROGRESS.md"
    if args.check:
        require(target.read_text() == document, "progress document drift")
    else:
        target.write_text(document)
    print(encoded({"mode": "CHECKED" if args.check else "RECORDED", "tasks": list(TASKS), "tests": totals["tests"], "shacl": "CONFORMS", "negativeCases": 3, "nextTask": receipt["nextTask"]}))


if __name__ == "__main__":
    main()
