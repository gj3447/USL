#!/usr/bin/env python3
"""Record actual CP01 tests; preserve the original completion-plan snapshot."""
import argparse
import hashlib
import json
import platform
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from pyshacl import validate
from rdflib import Graph, Literal, Namespace, URIRef

ROOT = Path(__file__).resolve().parent.parent
FOLDER = ROOT / "research/clean-git-progress"
NS = Namespace("urn:usl:clean-git-progress:")
TESTS = ["test/portable-transfer-git.test.ts", "test/portable-transfer-git-cli.test.ts", "test/portable-transfer-git-adversarial.test.ts"]
COMMAND = ["node", "--import", "tsx", "--test", "--test-reporter=tap", *TESTS]
SOURCES = ["src/addons/portable-transfer-git.ts", "src/contract-core.ts", "src/json-data.ts", "scripts/usl-git-export.ts",
           "scripts/record-clean-git-progress.py", "schemas/clean-git-progress/progress.shacl.ttl",
           "docs/PORTABLE_TRANSFER_GIT.md", "research/completion-plan/plan.json", "package.json", "package-lock.json", *TESTS]
BOUNDARIES = {"profile": "CLEAN_GIT_WORKTREE_V1", "restore": "CP02_NOT_IMPLEMENTED", "atomicSnapshot": "NOT_CLAIMED",
              "fullWorkspace": "CP03_CP04_PENDING", "macos": "NOT_RUN", "windows": "NOT_RUN", "authority": "NOT_GRANTED"}


def require(value, message):
    if not value:
        raise AssertionError(message)


def sha(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def encoded(value):
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def parse_tap(text):
    names = re.findall(r"^ok \d+ - (.+)$", text, re.M)
    totals = {}
    for key in ["tests", "pass", "fail", "cancelled", "skipped", "todo"]:
        match = re.search(rf"^# {key} (\d+)$", text, re.M)
        require(match, f"missing TAP total {key}")
        totals[key] = int(match[1])
    require(totals["pass"] == totals["tests"] == len(names) > 0 and not any(totals[k] for k in ["fail", "cancelled", "skipped", "todo"]), "tests must pass without skips")
    require(len(names) == len(set(names)), "duplicate test names")
    require(all(any(name.startswith(f"CP01-{i}:") for name in names) for i in (1, 2)), "missing acceptance evidence")
    return names, totals


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--record", action="store_true")
    mode.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.record:
        require(platform.system() == "Linux", "this recorder describes Linux only")
        commit = git("rev-parse", "HEAD").decode().strip()
        pins = [{"path": p, "sha256": sha((ROOT / p).read_bytes())} for p in SOURCES]
        for source in pins:
            require(sha(git("show", f"{commit}:{source['path']}")) == source["sha256"], f"commit source first: {source['path']}")
        run = subprocess.run(COMMAND, cwd=ROOT, capture_output=True, text=True, timeout=240)
        require(run.returncode == 0, run.stdout + run.stderr)
        names, totals = parse_tap(run.stdout)
        for source in pins:
            require(sha((ROOT / source["path"]).read_bytes()) == source["sha256"], "source changed during test run")
        receipt = {"schema": "usl-clean-git-progress/v1", "authority": "SECONDARY_AI", "recordedAt": datetime.now(timezone.utc).isoformat(),
                   "sourceCommit": commit, "package": "package:CP01", "implementation": "CLEAN_EXPORT_LOCAL_SCOPE",
                   "nextPackage": "package:CP02", "boundaries": BOUNDARIES, "command": COMMAND,
                   "environment": {"system": platform.system(), "node": subprocess.check_output(["node", "--version"], text=True).strip(),
                                   "git": git("--version").decode().strip()},
                   "sources": pins, "tests": names, "totals": totals, "tapDigest": sha(run.stdout.encode())}
        FOLDER.mkdir(parents=True, exist_ok=True)
        (FOLDER / "tests.tap").write_text(run.stdout)
        (FOLDER / "receipt.json").write_text(encoded(receipt))
    receipt = json.loads((FOLDER / "receipt.json").read_text())
    tap = (FOLDER / "tests.tap").read_text()
    names, totals = parse_tap(tap)
    require(receipt["schema"] == "usl-clean-git-progress/v1" and receipt["authority"] == "SECONDARY_AI", "receipt identity drift")
    require(receipt["command"] == COMMAND and receipt["boundaries"] == BOUNDARIES and receipt["environment"]["system"] == "Linux", "scope promoted")
    require(receipt["package"] == "package:CP01" and receipt["nextPackage"] == "package:CP02" and receipt["implementation"] == "CLEAN_EXPORT_LOCAL_SCOPE", "implementation scope drift")
    require(receipt["tapDigest"] == sha(tap.encode()) and receipt["tests"] == names and receipt["totals"] == totals, "test evidence drift")
    require([s["path"] for s in receipt["sources"]] == SOURCES, "source coverage drift")
    for source in receipt["sources"]:
        require(sha((ROOT / source["path"]).read_bytes()) == source["sha256"], f"current source changed: {source['path']}")
        require(sha(git("show", f"{receipt['sourceCommit']}:{source['path']}")) == source["sha256"], "historical source mismatch")
    ref = lambda value: {"@id": value}
    test_id = lambda name: "test:clean-git:" + hashlib.sha256(name.encode()).hexdigest()
    trace = {"@context": {"g": str(NS), "prov": "http://www.w3.org/ns/prov#"}, "@graph": [
        {"@id": "observation:clean-git-export", "@type": ["g:Observation", "prov:Entity"], "g:package": ref("package:CP01"),
         "g:implementation": "CLEAN_EXPORT_LOCAL_SCOPE", "g:sourceCommit": receipt["sourceCommit"], "g:recordedAt": receipt["recordedAt"],
         **{"g:" + k: v for k, v in BOUNDARIES.items()}, "prov:wasDerivedFrom": ref("receipt:clean-git-export")},
        {"@id": "package:CP01", "@type": "g:Package", "g:acceptance": [ref("acceptance:CP01-1"), ref("acceptance:CP01-2")]},
        {"@id": "receipt:clean-git-export", "@type": "g:Receipt", "g:sha256": sha((FOLDER / "receipt.json").read_bytes()),
         "g:tapDigest": receipt["tapDigest"], "g:authority": "SECONDARY_AI"},
        *[{"@id": f"acceptance:CP01-{i}", "@type": "g:Acceptance", "g:coverage": "LOCAL_EXPORT_CASES_PASS",
           "g:checkedBy": [ref(test_id(name)) for name in names if name.startswith(f"CP01-{i}:")]} for i in (1, 2)],
        *[{"@id": test_id(name), "@type": "g:TestResult", "g:name": name, "g:status": "PASS"} for name in names],
    ]}
    trace_text = encoded(trace)
    if args.record:
        (FOLDER / "trace.jsonld").write_text(trace_text)
    else:
        require((FOLDER / "trace.jsonld").read_text() == trace_text, "trace drift")
    rdf = Graph().parse(data=trace_text, format="json-ld")
    shapes = Graph().parse(ROOT / "schemas/clean-git-progress/progress.shacl.ttl", format="turtle")
    require(validate(rdf, shacl_graph=shapes)[0], "progress SHACL violation")
    rows = {(str(r.a), str(r.t)) for r in rdf.query("PREFIX g:<urn:usl:clean-git-progress:> SELECT ?a ?t WHERE {?a a g:Acceptance; g:checkedBy ?t. ?t g:status 'PASS'.}")}
    require(rows == {(f"acceptance:CP01-{i}", test_id(name)) for i in (1, 2) for name in names if name.startswith(f"CP01-{i}:")}, "acceptance/test mapping drift")
    negatives = 0
    for key, value in [("restore", "COMPLETE"), ("atomicSnapshot", "PROVEN"), ("macos", "PASS"), ("authority", "GRANTED")]:
        bad = Graph()
        for triple in rdf:
            bad.add(triple)
        bad.set((URIRef("observation:clean-git-export"), NS[key], Literal(value)))
        require(not validate(bad, shacl_graph=shapes)[0], f"scope promotion accepted: {key}")
        negatives += 1
    document = "\n".join([
        "# USL 완료 계획의 실행 진행", "", "[완료 계획](COMPLETION_PLAN.md)은 원래 PLANNED/NOT_RUN snapshot으로 유지하고 실행 관측을 여기에 연결한다.", "",
        "## CP01 · clean Git 계약과 export", "", "상태: **CLEAN_EXPORT_LOCAL_SCOPE**. 독립 pin으로 선택한 refs/HEAD의 Git objects를 export하고 비어 있는 저장소에서 prerequisites 없는 bundle을 검증한다.", "",
        f"소스 `{receipt['sourceCommit']}`; 기록 {receipt['recordedAt']}. Linux / {receipt['environment']['node']} / {receipt['environment']['git']}에서 **{totals['tests']}개 PASS**, 실패·건너뜀 0.", "",
        "[사용법과 정확한 범위](PORTABLE_TRANSFER_GIT.md). dirty/index/untracked·submodule/LFS/alternates·원자 snapshot·타 OS·실기기 복구는 이 결과로 완료 처리하지 않는다.", "",
        "다음은 **CP02: clean Git·여러 worktree 복원과 재바인딩**이다. Native Git로 source 없는 bundle을 검증하는 테스트는 USL importer나 링크 재바인딩 구현 완료가 아니다.", "",
        "| 인수 조건 | 실행한 검사 |", "|---|---|",
        *[f"| CP01-{i} · LOCAL_EXPORT_CASES_PASS | " + "<br>".join(name for name in names if name.startswith(f"CP01-{i}:")) + " |" for i in (1, 2)], "",
        "[실행 receipt](../research/clean-git-progress/receipt.json) · [TAP](../research/clean-git-progress/tests.tap) · [RDF](../research/clean-git-progress/trace.jsonld) · [SHACL](../schemas/clean-git-progress/progress.shacl.ttl).", "",
        "```sh", "python3 -B scripts/record-clean-git-progress.py --check", "```", "",
    ])
    if args.record:
        (ROOT / "docs/COMPLETION_PROGRESS.md").write_text(document)
    else:
        require((ROOT / "docs/COMPLETION_PROGRESS.md").read_text() == document, "progress document drift")
    print(encoded({"mode": "RECORDED" if args.record else "CHECKED", "package": "package:CP01", "tests": totals["tests"], "shacl": "CONFORMS", "negativeCases": negatives, "nextPackage": "package:CP02"}))


if __name__ == "__main__":
    main()
