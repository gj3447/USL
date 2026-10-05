#!/usr/bin/env python3
"""Record executed CP01/CP02 local cases, preserving the original completion plan."""
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
TESTS = ["test/portable-transfer-git.test.ts", "test/portable-transfer-git-cli.test.ts", "test/portable-transfer-git-adversarial.test.ts",
         "test/portable-transfer-git-import.test.ts", "test/portable-transfer-git-bindings.test.ts",
         "test/portable-transfer-git-restore-adversarial.test.ts", "test/portable-transfer-git-import-cli.test.ts"]
COMMAND = ["node", "--import", "tsx", "--test", "--test-reporter=tap", *TESTS]
SOURCES = sorted({str(p.relative_to(ROOT)) for p in (ROOT / "src").rglob("*.ts")} | set([
    "scripts/usl-git-export.ts", "scripts/usl-git-import.ts", "scripts/record-clean-git-progress.py",
    "schemas/clean-git-progress/progress.shacl.ttl", "docs/PORTABLE_TRANSFER_GIT.md", "docs/PORTABLE_TRANSFER_GIT_IMPORT.md",
    "research/completion-plan/plan.json", "package.json", "package-lock.json", "test/clean-git-fixture.ts", *TESTS]))
IMPLEMENTATIONS = {"CP01": "CLEAN_EXPORT_LOCAL_SCOPE", "CP02": "CLEAN_RESTORE_REBIND_LOCAL_SCOPE"}
ACCEPTANCE = [f"{p}-{i}" for p in IMPLEMENTATIONS for i in (1, 2)]
BOUNDARIES = {"profile": "CLEAN_GIT_WORKTREE_V1", "restore": "RAW_REGULAR_CLEAN_TREES_ONLY", "atomicSnapshot": "NOT_CLAIMED",
              "fullWorkspace": "CP03_CP04_PENDING", "macos": "NOT_RUN", "windows": "NOT_RUN", "authority": "NOT_GRANTED",
              "registration": "LOCAL_PROPOSAL_ONLY", "crashRecovery": "NOT_IMPLEMENTED"}


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
    require(all(any(name.startswith(a + ":") for name in names) for a in ACCEPTANCE), "missing acceptance evidence")
    require(all(any(name.startswith(a + ":") for a in ACCEPTANCE) for name in names), "unmapped executed test")
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
        receipt = {"schema": "usl-clean-git-progress/v2", "authority": "SECONDARY_AI", "recordedAt": datetime.now(timezone.utc).isoformat(),
                   "sourceCommit": commit, "implementations": IMPLEMENTATIONS, "nextPackage": "package:CP03", "boundaries": BOUNDARIES, "command": COMMAND,
                   "environment": {"system": platform.system(), "node": subprocess.check_output(["node", "--version"], text=True).strip(), "git": git("--version").decode().strip()},
                   "sources": pins, "tests": names, "totals": totals, "tapDigest": sha(run.stdout.encode())}
        FOLDER.mkdir(parents=True, exist_ok=True)
        (FOLDER / "tests.tap").write_text(run.stdout)
        (FOLDER / "receipt.json").write_text(encoded(receipt))
    receipt = json.loads((FOLDER / "receipt.json").read_text())
    tap = (FOLDER / "tests.tap").read_text()
    names, totals = parse_tap(tap)
    require(receipt["schema"] == "usl-clean-git-progress/v2" and receipt["authority"] == "SECONDARY_AI", "receipt identity drift")
    require(receipt["command"] == COMMAND and receipt["boundaries"] == BOUNDARIES and receipt["environment"]["system"] == "Linux", "scope promoted")
    require(receipt["implementations"] == IMPLEMENTATIONS and receipt["nextPackage"] == "package:CP03", "implementation scope drift")
    require(receipt["tapDigest"] == sha(tap.encode()) and receipt["tests"] == names and receipt["totals"] == totals, "test evidence drift")
    require([s["path"] for s in receipt["sources"]] == SOURCES, "source coverage drift")
    for source in receipt["sources"]:
        require(sha((ROOT / source["path"]).read_bytes()) == source["sha256"], f"current source changed: {source['path']}")
        require(sha(git("show", f"{receipt['sourceCommit']}:{source['path']}")) == source["sha256"], "historical source mismatch")
    ref = lambda value: {"@id": value}
    test_id = lambda name: "test:clean-git:" + hashlib.sha256(name.encode()).hexdigest()
    trace = {"@context": {"g": str(NS), "prov": "http://www.w3.org/ns/prov#"}, "@graph": [
        *[{"@id": "observation:" + p, "@type": ["g:Observation", "prov:Entity"], "g:package": ref("package:" + p),
           "g:implementation": scope, "g:sourceCommit": receipt["sourceCommit"], "g:recordedAt": receipt["recordedAt"],
           **{"g:" + k: v for k, v in BOUNDARIES.items()}, "prov:wasDerivedFrom": ref("receipt:clean-git")} for p, scope in IMPLEMENTATIONS.items()],
        *[{"@id": "package:" + p, "@type": "g:Package", "g:acceptance": [ref(f"acceptance:{p}-{i}") for i in (1, 2)]} for p in IMPLEMENTATIONS],
        {"@id": "receipt:clean-git", "@type": ["g:Receipt", "prov:Entity"], "g:sha256": sha((FOLDER / "receipt.json").read_bytes()), "g:tapDigest": receipt["tapDigest"], "g:authority": "SECONDARY_AI"},
        *[{"@id": "acceptance:" + a, "@type": "g:Acceptance", "g:coverage": "LOCAL_CASES_PASS", "g:checkedBy": [ref(test_id(n)) for n in names if n.startswith(a + ":")]} for a in ACCEPTANCE],
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
    rows = {(str(r.p), str(r.a), str(r.t)) for r in rdf.query("PREFIX g:<urn:usl:clean-git-progress:> SELECT ?p ?a ?t WHERE {?p a g:Package; g:acceptance ?a. ?a g:checkedBy ?t. ?t g:status 'PASS'.}")}
    require(rows == {("package:" + a.split("-")[0], "acceptance:" + a, test_id(n)) for a in ACCEPTANCE for n in names if n.startswith(a + ":")}, "package/acceptance/test mapping drift")
    negatives = 0
    for key, value in [("restore", "FULL_WORKSPACE"), ("atomicSnapshot", "PROVEN"), ("macos", "PASS"), ("windows", "PASS"), ("authority", "GRANTED"), ("registration", "INSTALLED"), ("crashRecovery", "COMPLETE")]:
        bad = Graph()
        for triple in rdf:
            bad.add(triple)
        bad.set((URIRef("observation:CP02"), NS[key], Literal(value)))
        require(not validate(bad, shacl_graph=shapes)[0], f"scope promotion accepted: {key}")
        negatives += 1
    # Shape validation must also reject crossing the two packages' acceptance identities.
    bad = Graph()
    for triple in rdf:
        bad.add(triple)
    bad.set((URIRef("package:CP02"), NS.acceptance, URIRef("acceptance:CP01-1")))
    require(not validate(bad, shacl_graph=shapes)[0], "wrong acceptance package accepted")
    negatives += 1
    document = "\n".join([
        "# USL 완료 계획의 실행 진행", "", "[완료 계획](COMPLETION_PLAN.md)은 원래 PLANNED/NOT_RUN snapshot으로 유지하고 실제 실행 관측을 여기에 연결한다.", "",
        "## CP01 · clean Git 계약과 export", "", "상태: **CLEAN_EXPORT_LOCAL_SCOPE**. 독립 pin의 refs/HEAD와 도달 가능한 Git objects를 prerequisites 없는 bundle로 내보낸다. [계약과 사용법](PORTABLE_TRANSFER_GIT.md).", "",
        "## CP02 · clean Git 복원과 선택 바인딩", "", "상태: **CLEAN_RESTORE_REBIND_LOCAL_SCOPE**. 복사한 bundle에서 새 bare 객체 저장소와 branch/detached worktree들을 만든다. 원본과 backup 삭제 뒤 Git topology·전체 파일·메타데이터를 검사하고, owner가 선택한 binding과 graph locator만 갱신하는 로컬 제안을 반환한다. [계약과 사용법](PORTABLE_TRANSFER_GIT_IMPORT.md).", "",
        f"소스 `{receipt['sourceCommit']}`; 기록 {receipt['recordedAt']}. Linux / {receipt['environment']['node']} / {receipt['environment']['git']}에서 **{totals['tests']}개 PASS**, 실패·건너뜀 0.", "",
        "인수 범위는 raw regular clean trees다. checkout attributes·dirty/index/untracked 보존·submodule/LFS/alternates·원자 snapshot·프로세스 crash 복구·타 OS·실기기 이동은 이 결과로 완료 처리하지 않는다. 실제 registry에는 쓰지 않으며 권한을 부여하지 않는다.", "",
        "다음은 **CP03: dirty/index/untracked 작업 상태 보존**이다. CP04의 고급 Git 의존성 폐쇄와 함께 전체 작업환경 범위를 확장한다.", "",
        "| 인수 조건 | 실행한 검사 |", "|---|---|",
        *["| " + a + " · LOCAL_CASES_PASS | " + "<br>".join(n for n in names if n.startswith(a + ":")) + " |" for a in ACCEPTANCE], "",
        "[실행 receipt](../research/clean-git-progress/receipt.json) · [TAP](../research/clean-git-progress/tests.tap) · [RDF](../research/clean-git-progress/trace.jsonld) · [SHACL](../schemas/clean-git-progress/progress.shacl.ttl).", "",
        "```sh", "python3 -B scripts/record-clean-git-progress.py --check", "```", "",
    ])
    if args.record:
        (ROOT / "docs/COMPLETION_PROGRESS.md").write_text(document)
    else:
        require((ROOT / "docs/COMPLETION_PROGRESS.md").read_text() == document, "progress document drift")
    print(encoded({"mode": "RECORDED" if args.record else "CHECKED", "packages": list(IMPLEMENTATIONS), "tests": totals["tests"], "shacl": "CONFORMS", "negativeCases": negatives, "nextPackage": "package:CP03"}))


if __name__ == "__main__":
    main()
