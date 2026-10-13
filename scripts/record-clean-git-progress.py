#!/usr/bin/env python3
"""Record bounded CP01–CP03 local cases without promoting workspace restore."""
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
         "test/portable-transfer-git-restore-adversarial.test.ts", "test/portable-transfer-git-import-cli.test.ts", "test/portable-transfer-git-state.test.ts", "test/portable-transfer-git-state-adversarial.test.ts", "test/portable-transfer-git-state-restore.test.ts", "test/portable-transfer-git-state-integration.test.ts"]
COMMAND = ["node", "--import", "tsx", "--test", "--test-reporter=tap", *TESTS]
# Executed tests and spawned CLIs plus the local code they import or spawn
# (scripts/source-closure.ts); unrelated src/ files are not evidence inputs.
CODE_ENTRIES = ["scripts/usl-git-export.ts", "scripts/usl-git-import.ts", "test/clean-git-fixture.ts", *TESTS]
SOURCE_DATA = sorted(set([
    "scripts/record-clean-git-progress.py",
    "schemas/clean-git-progress/progress.shacl.ttl", "docs/PORTABLE_TRANSFER_GIT.md", "docs/PORTABLE_TRANSFER_GIT_IMPORT.md", "docs/PORTABLE_TRANSFER_GIT_STATE.md",
    "research/completion-plan/plan.json", "package.json", "package-lock.json"]))
IMPLEMENTATIONS = {"CP01": "CLEAN_EXPORT_LOCAL_SCOPE", "CP02": "CLEAN_RESTORE_REBIND_LOCAL_SCOPE", "CP03": "STATE_RESTORE_REBIND_LOCAL_SCOPE"}
ACCEPTANCE = [f"{p}-{i}" for p in IMPLEMENTATIONS for i in (1, 2)]
BOUNDARIES = {"profile": "CLEAN_GIT_WORKTREE_V1", "restore": "RAW_REGULAR_CLEAN_TREES_ONLY", "atomicSnapshot": "NOT_CLAIMED",
              "fullWorkspace": "CP03_CP04_PENDING", "macos": "NOT_RUN", "windows": "NOT_RUN", "authority": "NOT_GRANTED",
              "registration": "LOCAL_PROPOSAL_ONLY", "crashRecovery": "NOT_IMPLEMENTED"}
PACKAGE_BOUNDARIES = {p: ({**BOUNDARIES, "profile": "RAW_REGULAR_GIT_STATE_V1", "restore": "RAW_REGULAR_SELECTED_STATE_ONLY", "registration": "LOCAL_PROPOSAL_ONLY", "combinedDirtyExport": "NOT_IMPLEMENTED", "emptyDirectories": "NOT_RECONSTRUCTED"}
                          if p == "CP03" else BOUNDARIES) for p in IMPLEMENTATIONS}


def coverage(acceptance):
    return "LOCAL_STATE_PROFILE_CASES_PASS" if acceptance.startswith("CP03-") else "LOCAL_CASES_PASS"


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


def source_closure(entries):
    """Entries plus the local code they import or spawn (scripts/source-closure.ts)."""
    result = subprocess.run(["node", "--import", "tsx", "scripts/source-closure.ts", *entries], cwd=ROOT, capture_output=True, text=True, timeout=120, check=True)
    return json.loads(result.stdout)


def sources():
    return sorted(set(source_closure(CODE_ENTRIES)) | set(SOURCE_DATA))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--record", action="store_true")
    mode.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.record:
        require(platform.system() == "Linux", "this recorder describes Linux only")
        commit = git("rev-parse", "HEAD").decode().strip()
        pins = [{"path": p, "sha256": sha((ROOT / p).read_bytes())} for p in sources()]
        for source in pins:
            require(sha(git("show", f"{commit}:{source['path']}")) == source["sha256"], f"commit source first: {source['path']}")
        run = subprocess.run(COMMAND, cwd=ROOT, capture_output=True, text=True, timeout=240)
        require(run.returncode == 0, run.stdout + run.stderr)
        names, totals = parse_tap(run.stdout)
        for source in pins:
            require(sha((ROOT / source["path"]).read_bytes()) == source["sha256"], "source changed during test run")
        receipt = {"schema": "usl-clean-git-progress/v4", "authority": "SECONDARY_AI", "recordedAt": datetime.now(timezone.utc).isoformat(),
                   "sourceCommit": commit, "implementations": IMPLEMENTATIONS, "nextPackage": "package:CP03", "nextStep": "COORDINATED_DIRTY_EXPORT_AND_CLI", "boundaries": PACKAGE_BOUNDARIES, "command": COMMAND,
                   "environment": {"system": platform.system(), "node": subprocess.check_output(["node", "--version"], text=True).strip(), "git": git("--version").decode().strip()},
                   "sources": pins, "tests": names, "totals": totals, "tapDigest": sha(run.stdout.encode())}
        FOLDER.mkdir(parents=True, exist_ok=True)
        (FOLDER / "tests.tap").write_text(run.stdout)
        (FOLDER / "receipt.json").write_text(encoded(receipt))
    receipt = json.loads((FOLDER / "receipt.json").read_text())
    tap = (FOLDER / "tests.tap").read_text()
    names, totals = parse_tap(tap)
    require(receipt["schema"] == "usl-clean-git-progress/v4" and receipt["authority"] == "SECONDARY_AI", "receipt identity drift")
    require(receipt["command"] == COMMAND and receipt["boundaries"] == PACKAGE_BOUNDARIES and receipt["environment"]["system"] == "Linux", "scope promoted")
    require(receipt["implementations"] == IMPLEMENTATIONS and receipt["nextPackage"] == "package:CP03" and receipt["nextStep"] == "COORDINATED_DIRTY_EXPORT_AND_CLI", "implementation scope drift")
    require(receipt["tapDigest"] == sha(tap.encode()) and receipt["tests"] == names and receipt["totals"] == totals, "test evidence drift")
    require([s["path"] for s in receipt["sources"]] == sources(), "source coverage drift")
    for source in receipt["sources"]:
        require(sha((ROOT / source["path"]).read_bytes()) == source["sha256"], f"current source changed: {source['path']}")
        require(sha(git("show", f"{receipt['sourceCommit']}:{source['path']}")) == source["sha256"], "historical source mismatch")
    ref = lambda value: {"@id": value}
    test_id = lambda name: "test:clean-git:" + hashlib.sha256(name.encode()).hexdigest()
    trace = {"@context": {"g": str(NS), "prov": "http://www.w3.org/ns/prov#"}, "@graph": [
        *[{"@id": "observation:" + p, "@type": ["g:Observation", "prov:Entity"], "g:package": ref("package:" + p),
           "g:implementation": scope, "g:sourceCommit": receipt["sourceCommit"], "g:recordedAt": receipt["recordedAt"],
           **{"g:" + k: v for k, v in PACKAGE_BOUNDARIES[p].items()}, "prov:wasDerivedFrom": ref("receipt:clean-git")} for p, scope in IMPLEMENTATIONS.items()],
        *[{"@id": "package:" + p, "@type": "g:Package", "g:acceptance": [ref(f"acceptance:{p}-{i}") for i in (1, 2)]} for p in IMPLEMENTATIONS],
        {"@id": "receipt:clean-git", "@type": ["g:Receipt", "prov:Entity"], "g:sha256": sha((FOLDER / "receipt.json").read_bytes()), "g:tapDigest": receipt["tapDigest"], "g:authority": "SECONDARY_AI"},
        *[{"@id": "acceptance:" + a, "@type": "g:Acceptance", "g:coverage": coverage(a), "g:checkedBy": [ref(test_id(n)) for n in names if n.startswith(a + ":")]} for a in ACCEPTANCE],
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
    for subject, key, value in [("acceptance:CP03-1", "coverage", "LOCAL_CASES_PASS"), ("acceptance:CP03-2", "coverage", "FULL_RESTORE_PASS"),
                                ("observation:CP03", "restore", "RAW_REGULAR_CLEAN_TREES_ONLY"), ("observation:CP03", "registration", "INSTALLED"), ("observation:CP03", "combinedDirtyExport", "IMPLEMENTED"), ("observation:CP03", "emptyDirectories", "RESTORED")]:
        bad = Graph()
        for triple in rdf:
            bad.add(triple)
        bad.set((URIRef(subject), NS[key], Literal(value)))
        require(not validate(bad, shacl_graph=shapes)[0], f"CP03 scope promotion accepted: {subject}/{key}")
        negatives += 1
    document = "\n".join([
        "# USL 완료 계획의 실행 진행", "", "[완료 계획](COMPLETION_PLAN.md)은 원래 PLANNED/NOT_RUN snapshot으로 유지하고 실제 실행 관측을 여기에 연결한다.", "",
        "## CP01 · clean Git 계약과 export", "", "상태: **CLEAN_EXPORT_LOCAL_SCOPE**. 독립 pin의 refs/HEAD와 도달 가능한 Git objects를 prerequisites 없는 bundle로 내보낸다. [계약과 사용법](PORTABLE_TRANSFER_GIT.md).", "",
        "## CP02 · clean Git 복원과 선택 바인딩", "", "상태: **CLEAN_RESTORE_REBIND_LOCAL_SCOPE**. 복사한 bundle에서 새 bare 객체 저장소와 branch/detached worktree들을 만든다. 원본과 backup 삭제 뒤 Git topology·전체 파일·메타데이터를 검사하고, owner가 선택한 binding과 graph locator만 갱신하는 로컬 제안을 반환한다. [계약과 사용법](PORTABLE_TRANSFER_GIT_IMPORT.md).", "",
        "## CP03 · index/working/untracked 복원과 선택 바인딩", "", "상태: **STATE_RESTORE_REBIND_LOCAL_SCOPE**. 독립 Git bundle과 sidecar를 연결해 HEAD tree를 대조하고, index stage 0–3 mode/OID와 working bytes·삭제·선택 untracked를 새 worktree에 분리 복원한다. 상태 receipt를 revision으로 삼아 선택 binding과 graph locator의 로컬 재연결 제안을 만든다. [계약과 사용법](PORTABLE_TRANSFER_GIT_STATE.md).", "",
        f"소스 `{receipt['sourceCommit']}`; 기록 {receipt['recordedAt']}. Linux / {receipt['environment']['node']} / {receipt['environment']['git']}에서 **{totals['tests']}개 PASS**, 실패·건너뜀 0.", "",
        "CP01/02 인수 범위는 raw regular clean trees다. CP03는 raw regular 선택 작업 상태의 수집·검증·복원·로컬 재연결 제안까지 포함한다. base clean bundle은 독립적으로 준비되어 있어야 한다. submodule/LFS/alternates·원자 snapshot·프로세스 crash 복구·타 OS·실기기 이동은 이 결과로 완료 처리하지 않는다. 실제 registry에는 쓰지 않으며 권한을 부여하지 않는다.", "",
        "CP03에서 symlink/special file, sparse, attributes/filter/LFS, intent-to-add, skip/assume flags, 진행 중 merge/rebase는 HOLD다. stash/reflog, ignored·미선택 untracked, config/hooks는 수집 범위 밖이며 history는 독립 base bundle로 검증한다. 이 결과는 전체 workspace 복원 성공이 아니다.", "",
        "다음은 **CP03의 base bundle·sidecar 통합 내보내기와 CLI 연결**이다. CP04의 고급 Git 의존성 폐쇄도 남아 있다.", "",
        "| 인수 조건 | 실행한 검사 |", "|---|---|",
        *["| " + a + " · " + coverage(a) + " | " + "<br>".join(n for n in names if n.startswith(a + ":")) + " |" for a in ACCEPTANCE], "",
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
