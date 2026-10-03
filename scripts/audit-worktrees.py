"""Record real worktree tests and build their bounded evidence graph; never repair a user checkout."""
import argparse
import hashlib
import json
import pathlib
import platform
import re
import subprocess
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE = ROOT / "research/worktree-audit"
NS = "urn:usl:worktree-audit:"


def text(path):
    return (ROOT / path).read_text()


def digest(content):
    return "sha256:" + hashlib.sha256(content).hexdigest()


def dump(value):
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def require(condition, detail):
    if not condition:
        raise AssertionError(detail)


def run(args):
    return subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=180, check=True).stdout


def pins(catalog):
    paths = {p.relative_to(ROOT).as_posix() for p in (ROOT / "src").rglob("*.ts")}
    paths.update(catalog["testFiles"] + catalog["regressionFiles"])
    paths.update(["test/fixtures.ts", "examples/fixtures/cli/graphspec.json", "package.json", "package-lock.json", "tsconfig.json", "scripts/audit-worktrees.py", "research/worktree-audit/catalog.json"])
    return [{"path": path, "sha256": digest((ROOT / path).read_bytes())} for path in sorted(paths)]


def test_id(name):
    return "test:" + hashlib.sha256(name.encode()).hexdigest()


def file_id(path):
    return "artifact:" + path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--record", action="store_true", help="Execute disposable fixture tests, then record receipt and artifacts")
    mode.add_argument("--check", action="store_true", help="Check recorded source pins, exact artifacts, RDF and evidence links; does not replay tests")
    args = parser.parse_args()
    catalog = json.loads(text("research/worktree-audit/catalog.json"))
    require(catalog["schema"] == "usl-worktree-audit/v1" and catalog["authority"] == "SECONDARY_AI", "invalid catalog")
    require(catalog["verdict"] == "PARTIAL_WORKTREE_SUPPORT_NOT_COMPLETE_PORTABILITY", "unsupported verdict promotion")
    require(all(c["execution"] == "NOT_RUN" for c in catalog["futureChecks"]), "future checks were promoted")
    cases = []
    for path in catalog["testFiles"] + catalog["regressionFiles"]:
        cases.extend({"id": test_id(name), "name": name, "path": path} for name in re.findall(r'test\("([^"\n]+)"', text(path)))
    require(len({c["name"] for c in cases}) == len(cases), "test names must be unique")
    by_name = {c["name"]: c for c in cases}
    for finding in catalog["findings"]:
        require(finding["authority"] == "SECONDARY_AI" and finding["coverage"] in {"COVERED_IN_FIXTURE", "LIMITATION_OBSERVED"}, "invalid finding")
        require(finding["detail"] and finding["nextStep"] and finding["testNames"] and finding["sourcePaths"], "incomplete finding")
        require(set(finding["testNames"]) <= by_name.keys(), "missing exact test definition")
    command = ["node", "--import", "tsx", "--test", "--test-reporter=tap", *catalog["testFiles"], *catalog["regressionFiles"]]
    if args.record:
        # Bind the runtime baseline to a real revision. Test definitions may be
        # newly added; their exact bytes are separately recorded below.
        subprocess.run(["git", "diff", "--quiet", "HEAD", "--", "src", "package.json", "package-lock.json"], cwd=ROOT, check=True)
        before = pins(catalog)
        tap = run(command)
        require(before == pins(catalog), "audit source changed while tests ran")
        executed = re.findall(r"^ok \d+ - (.+)$", tap, re.M)
        require(len(executed) == len(cases) and set(executed) == by_name.keys(), "TAP test names differ from source definitions")
        for field in ["fail", "cancelled", "skipped", "todo"]:
            require(re.search(rf"^# {field} 0$", tap, re.M), f"nonzero or missing TAP {field}")
        receipt = {"schema": "usl-worktree-audit-receipt/v1", "status": "ASSERTIONS_PASS", "recordedAt": datetime.now(timezone.utc).isoformat(),
                   "sourceCommit": run(["git", "rev-parse", "HEAD"]).strip(), "environment": {"node": run(["node", "--version"]).strip(), "git": run(["/usr/bin/git", "--version"]).strip(), "platform": platform.system(), "architecture": platform.machine()},
                   "command": command, "pins": before, "tapDigest": digest(tap.encode()), "tests": [{**by_name[name], "assertion": "PASS"} for name in executed],
                   "interpretation": "PASS means the named assertion held, including assertions reproducing missing protection; not complete portability or a signed attestation."}
        (BASE / "tests.tap").write_text(tap)
        (BASE / "receipt.json").write_text(dump(receipt))
    receipt = json.loads(text("research/worktree-audit/receipt.json"))
    require(receipt["schema"] == "usl-worktree-audit-receipt/v1" and receipt["status"] == "ASSERTIONS_PASS", "invalid receipt")
    require(receipt["pins"] == pins(catalog), "recorded source pins are stale; replay with --record")
    require(receipt["command"] == command and receipt["tapDigest"] == digest((BASE / "tests.tap").read_bytes()), "execution evidence drift")
    require({(c["id"], c["name"], c["path"], c["assertion"]) for c in receipt["tests"]} == {(c["id"], c["name"], c["path"], "PASS") for c in cases}, "receipt test identity differs")
    ref = lambda uid: {"@id": uid}
    node = lambda uid, kind, **fields: {"@id": uid, "@type": "w:" + kind, **{"w:" + key: value for key, value in fields.items()}}
    findings = [node(f["id"], "Finding", title=f["title"], authority=f["authority"], coverage=f["coverage"], detail=f["detail"], nextStep=f["nextStep"],
                     evidencedBy=[ref(test_id(name)) for name in f["testNames"]], inspects=[ref(file_id(p)) for p in f["sourcePaths"]]) for f in catalog["findings"]]
    trace = {"@context": {"w": NS, "prov": "http://www.w3.org/ns/prov#"}, "@graph": [
        node("audit:worktrees", "Audit", verdict=catalog["verdict"], authority="SECONDARY_AI", scope=catalog["scope"], recordedAt=receipt["recordedAt"],
             assesses=[ref(f["id"]) for f in catalog["findings"]], groundedIn=[ref(s["id"]) for s in catalog["sources"]], requiresCheck=[ref(c["id"]) for c in catalog["futureChecks"]]),
        {"@id": "audit:worktrees", "prov:wasDerivedFrom": [ref("input:user-request"), ref("input:test-receipt")], "prov:wasAttributedTo": ref("agent:usl-auditor")},
        {"@id": "agent:usl-auditor", "@type": "prov:Agent", "w:authority": "SECONDARY_AI"},
        {"@id": "input:user-request", "@type": "prov:Entity", "w:authority": "USER_PRIMARY", "w:text": catalog["userRequest"]["text"]},
        {"@id": "input:test-receipt", "@type": "prov:Entity", "w:sha256": digest((BASE / "receipt.json").read_bytes()), "w:sourceCommit": receipt["sourceCommit"]},
        *findings,
        *[node(c["id"], "TestExecution", name=c["name"], assertion=c["assertion"], definedIn=ref(file_id(c["path"])), recordedAt=receipt["recordedAt"]) for c in receipt["tests"]],
        *[node(file_id(p["path"]), "SourceFile", path=p["path"], sha256=p["sha256"]) for p in receipt["pins"]],
        *[node(s["id"], "PrimarySource", url=ref(s["url"]), fact=s["fact"], limit=s["limit"], checkedOn=s["checkedOn"]) for s in catalog["sources"]],
        *[node(c["id"], "FutureCheck", execution=c["execution"], expectation=c["expectation"]) for c in catalog["futureChecks"]],
    ]}
    new_count = sum(c["path"] in catalog["testFiles"] for c in cases)
    document = ["# Git worktree 분기·이동 적대적 검증", "",
        "**판정: 기본 worktree 사용은 지원하지만, 임의 분기·복사·백업·다른 머신 복원까지 모든 기능이 갖춰진 것은 아니다.** 실제 임시 저장소의 성공 경계와 누락된 보호를 함께 검증했다. 런타임 기능을 추가한 작업이 아니라 테스트·근거·후속 계약을 추가한 감사다.", "",
        f"실행 시점 `{receipt['recordedAt']}`, 코드 기준 `{receipt['sourceCommit']}`. 환경: {receipt['environment']['platform']} / {receipt['environment']['architecture']} / {receipt['environment']['git']} / Node {receipt['environment']['node']}. 새 worktree 시험 **{new_count}개**, 관련 기존 회귀 시험 **{len(cases)-new_count}개**, 총 **{len(cases)}개 assertion PASS**. 한계가 재현된 테스트도 PASS이므로 이 숫자를 완전 지원의 증거로 읽지 않는다.", "",
        "실제 Git main/linked checkout을 만들고 서로 다른 commit, staged/unstaged 상태, detached HEAD, move, manual move+repair, copy, remove+prune, sparse checkout, symlink, graph 재바인딩, CLI 조회, 계획 재검사, 예약 저장소 공유/분리를 실행했다. 모든 파일·실행 marker는 disposable fixture 안에 있었으며 사용자 저장소를 이동하거나 원격에 접속하지 않았다.", "",
        "## 핵심 반례", "",
        "1. **잘못된 worktree도 파일이 같으면 MATCH:** 현재 binding은 기대 worktree/HEAD를 pin하지 않는다. HEAD가 달라져도 선언한 실행 입력이 같으면 planDigest가 그대로다.",
        "2. **linked 폴더만 복사하면 독립 백업이 아니다:** `.git` 파일은 원래 common Git directory를 계속 참조한다. 원본을 옮기자 복사본은 NO_REPOSITORY가 됐다.",
        "3. **실행 기록 저장소를 분리하면 중복 차단도 분리된다:** 같은 namespace/key로 양쪽 worktree에서 실행해 두 marker가 모두 생겼다. 같은 store를 유지한 경우에는 두 번째 실행이 차단됐다.",
        "4. **root mapping만 바꿔서는 Git 이동 복구가 끝나지 않는다:** main과 linked를 직접 옮긴 뒤 Git repair가 필요했다. 현재 broken gitfile은 일반 폴더처럼 NO_REPOSITORY로 관측될 수 있다.",
        "5. **directory snapshot과 실제 파일 검증은 다르다:** snapshot relation과 digest를 붙여도 디렉터리 내용은 NOT_CHECKED다. 전체 checkout과 의존성의 원자적 snapshot은 제공하지 않는다.", "",
        "## 논리 자원·worktree·revision의 구분", "",
        "```mermaid", "flowchart LR", "  R[논리 자원 ID] --> A[main 표현 ID]", "  R --> B[worker 표현 ID]", "  A --> WA[로컬 workspace mapping A]", "  B --> WB[로컬 workspace mapping B]", "  WA --> HA[개별 HEAD와 index]", "  WB --> HB[개별 HEAD와 index]", "  HA --> C[공유 Git 관리 데이터]", "  HB --> C", "```", "",
        "Git worktree의 공유 디렉터리는 worktree identity가 아니다. branch 이름도 움직일 수 있다. 로컬 경로는 관측 주소로 보존하고, owner가 정한 자원·worktree 식별자와 revision 정책은 별도 계약으로 관리해야 한다. Git 자체의 layout과 move/repair 의미는 [Git worktree 문서](https://git-scm.com/docs/git-worktree), [repository layout](https://git-scm.com/docs/gitrepository-layout)에 근거한다. 최신 문서의 모든 옵션을 설치된 Git에서 실행했다고 주장하지 않는다.", "",
        "## 시험별 판정", "",
        "| ID | 범위 | 판정 | 확인한 동작 |", "|---|---|---|---|",
        *[f"| {f['id']} | {f['title']} | {f['coverage']} | {f['detail']} |" for f in catalog["findings"]], "",
        *sum(([f"### {f['id']} · {f['title']}", "", f["nextStep"], "", *[f"- `{name}` — ASSERTION PASS" for name in f["testNames"]], ""] for f in catalog["findings"]), []),
        "## 남은 구현과 검증", "",
        "우선순위는 (1) 선택형 expected-checkout/revision/dirty guard, (2) 공유 Git 의존성까지 닫는 export/restore와 repair 절차, (3) 여러 worktree의 같은 논리 작업을 위한 owner operation registry, (4) 원자적 capture와 여러 OS/머신 시험이다. HEAD pin만으로 uncommitted 파일이나 submodule·LFS의 무결성을 보장하지 않는다. 이동 후에도 유지할 owner ID와 현재 경로의 검증을 분리해야 한다.", "",
        *[f"- **{c['id']} · NOT_RUN:** {c['expectation']}" for c in catalog["futureChecks"]], "",
        "이번 실행은 한 Linux 머신 안의 임시 경로 이동/복사다. 실제 타 컴퓨터·Windows/macOS·서로 다른 filesystem·네트워크 단절·concurrent mutation 전체를 검증한 것은 아니다. [기존 이동성 조사](PORTABILITY_RESEARCH.md)와 [표준 지원 감사](STANDARDS_COVERAGE.md)의 미구현 항목을 완료로 승격하지 않는다.", "",
        "## 근거 그래프와 재현", "",
        "[판정 catalog](../research/worktree-audit/catalog.json), [실행 receipt](../research/worktree-audit/receipt.json), [원본 TAP](../research/worktree-audit/tests.tap), [typed RDF trace](../research/worktree-audit/trace.jsonld)를 연결했다. test definition과 실제 TestExecution을 구분하고, 각 판단에서 정확한 테스트 이름과 source bytes digest로 이동할 수 있다. Source commit은 runtime baseline이며 새 테스트와 스크립트는 별도 bytes pin으로 기록했다. Receipt는 로컬 실행 기록으로 서명·원격 증명은 아니다.", "",
        "| predicate | domain → range | cardinality와 의미 |", "|---|---|---|",
        "| assesses | Audit → Finding | 1개 이상; 이 감사의 해석된 판정 |", "| groundedIn | Audit → PrimarySource | 1개 이상; 공식 문서 근거 |", "| requiresCheck | Audit → FutureCheck | 1개 이상; 아직 NOT_RUN |",
        "| evidencedBy | Finding → TestExecution | 1개 이상; 해당 assertion 결과, 전체 기능 성공과 다름 |", "| inspects | Finding → SourceFile | 1개 이상; 판정에 직접 관련된 소스 |", "| definedIn | TestExecution → SourceFile | 정확히 1개; 테스트 정의의 bytes pin |", "",
        "RDF parsing·SHACL 및 실제 SPARQL 질의로 판정→테스트→소스의 정확한 endpoint와 coverage 값을 검사한다. 의존성 관계를 정의하지 않았으므로 이 그래프 전체에 DAG를 강제하지 않는다. USER_PRIMARY 원문과 SECONDARY_AI 해석을 분리한다. 테스트가 성공했더라도 LIMITATION_OBSERVED를 COVERED_IN_FIXTURE로 바꾸면 검증에 실패한다.", "",
        "```sh", "# 실제 disposable fixture 시험 실행 + receipt/graph/report 갱신", "python3 scripts/audit-worktrees.py --record", "# 기록된 source pin과 graph/report를 검사. 시험 재실행은 아님", "python3 scripts/audit-worktrees.py --check", "```", "",
        "Python 의존성은 [기존 표준 검사 requirements](../scripts/requirements-standards.txt)를 사용한다. 신규 시험 파일들은 기존 npm test와 typecheck에 자동 포함된다.", ""]
    outputs = {"research/worktree-audit/trace.jsonld": dump(trace), "docs/WORKTREE_AUDIT.md": "\n".join(document)}
    for path, content in outputs.items():
        if args.check:
            require(text(path) == content, "artifact differs: " + path)
        else:
            (ROOT / path).write_text(content)
    validate_trace(catalog, receipt)
    print(dump({"mode": "TESTS_RECORDED" if args.record else "HISTORICAL_EVIDENCE_CHECKED", "tests": len(cases), "newWorktreeTests": new_count, "findings": len(findings), "verdict": catalog["verdict"], "futureChecks": "NOT_RUN"}))


def validate_trace(catalog, receipt):
    from rdflib import Graph, Literal, Namespace, RDF, URIRef
    from pyshacl import validate
    w = Namespace(NS)
    trace = Graph().parse(BASE / "trace.jsonld", format="json-ld")
    # Shapes describe this audit contract, not universal worktree conformance.
    shapes = Graph().parse(data='''@prefix w:<urn:usl:worktree-audit:>. @prefix sh:<http://www.w3.org/ns/shacl#>.
      w:FindingShape a sh:NodeShape; sh:targetClass w:Finding;
        sh:property [sh:path w:authority;sh:hasValue "SECONDARY_AI";sh:minCount 1;sh:maxCount 1];
        sh:property [sh:path w:coverage;sh:in ("COVERED_IN_FIXTURE" "LIMITATION_OBSERVED");sh:minCount 1;sh:maxCount 1];
        sh:property [sh:path w:detail;sh:minCount 1;sh:maxCount 1];
        sh:property [sh:path w:nextStep;sh:minCount 1;sh:maxCount 1];
        sh:property [sh:path w:evidencedBy;sh:minCount 1;sh:class w:TestExecution];
        sh:property [sh:path w:inspects;sh:minCount 1;sh:class w:SourceFile].
      w:TestShape a sh:NodeShape;sh:targetClass w:TestExecution;
        sh:property [sh:path w:assertion;sh:hasValue "PASS";sh:minCount 1;sh:maxCount 1];
        sh:property [sh:path w:definedIn;sh:minCount 1;sh:maxCount 1;sh:class w:SourceFile].
      w:FutureShape a sh:NodeShape;sh:targetClass w:FutureCheck;
        sh:property [sh:path w:execution;sh:hasValue "NOT_RUN";sh:minCount 1;sh:maxCount 1].
    ''', format="turtle")
    ok, _, report = validate(trace, shacl_graph=shapes)
    require(ok, str(report))
    queries = [
        ("SELECT ?a ?b WHERE {?a w:evidencedBy ?b}", {(f["id"], test_id(name)) for f in catalog["findings"] for name in f["testNames"]}),
        ("SELECT ?a ?b WHERE {?a w:definedIn ?b}", {(c["id"], file_id(c["path"])) for c in receipt["tests"]}),
        ("SELECT ?a ?b WHERE {?a w:inspects ?b}", {(f["id"], file_id(path)) for f in catalog["findings"] for path in f["sourcePaths"]}),
        ("SELECT ?a ?b WHERE {?a w:coverage ?b}", {(f["id"], f["coverage"]) for f in catalog["findings"]}),
        ("SELECT ?a ?b WHERE {?a w:execution ?b}", {(c["id"], c["execution"]) for c in catalog["futureChecks"]}),
    ]
    for query, expected in queries:
        require({tuple(map(str, row)) for row in trace.query("PREFIX w:<" + NS + "> " + query)} == expected, "trace endpoints/status differ")
    bad = Graph()
    for triple in trace:
        bad.add(triple)
    first = URIRef(catalog["findings"][0]["id"])
    bad.remove((first, w.evidencedBy, None))
    require(not validate(bad, shacl_graph=shapes)[0], "missing execution evidence must fail")
    limitation = next(f for f in catalog["findings"] if f["coverage"] == "LIMITATION_OBSERVED")
    old = Literal("LIMITATION_OBSERVED"); subject = URIRef(limitation["id"])
    trace.set((subject, w.coverage, Literal("COVERED_IN_FIXTURE")))
    require({tuple(map(str, row)) for row in trace.query("PREFIX w:<" + NS + "> SELECT ?a ?b WHERE {?a w:coverage ?b}")} != queries[3][1], "limit promotion must be detected")
    trace.set((subject, w.coverage, old))
    future = URIRef(catalog["futureChecks"][0]["id"])
    trace.set((future, w.execution, Literal("PASS")))
    require(not validate(trace, shacl_graph=shapes)[0], "future check promotion must fail")


if __name__ == "__main__":
    main()
