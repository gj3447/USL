#!/usr/bin/env python3
"""Record bounded local DG01/PT02/PT03/PT04 evidence without promoting portability claims."""
import argparse
import hashlib
import json
import math
import pathlib
import platform
import re
import subprocess
import tempfile
import shutil
from datetime import datetime, timezone

from pyshacl import validate
from rdflib import Graph, Literal, Namespace, RDF, URIRef

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE = ROOT / "research/development-progress"
D = Namespace("urn:usl:development-progress:")
PROV = Namespace("http://www.w3.org/ns/prov#")
TEST_FILES = ["test/checkout-guard.test.ts", "test/binding-inspection.test.ts", "test/worktree-lifecycle.test.ts", "test/worktree-execution.test.ts", "test/worktree-graph-cli.test.ts", "test/portable-transfer-export.test.ts", "test/portable-transfer-restore.test.ts", "test/portable-transfer-bindings.test.ts", "test/portable-transfer-portability.test.ts"]
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
    "PT03": {"criteria": [f"criterion:PT03-C{i}" for i in range(1, 6)], "title": "검증 후 file profile 복원", "guide": "PORTABLE_TRANSFER_IMPORT.md", "scope": "PINNED_FILE_RESTORE_REBINDING_REJECTION_ONLY_GIT_RESTORE_PENDING", "implementation": "IMPLEMENTED_FILE_PROFILE_GIT_PENDING", "status": "LOCAL_CASES_PASS", "description": "새 root에서 pinned files와 bindings를 복원한다.", "limits": "PT03-C5는 REJECTION_ONLY_GIT_RESTORE_PENDING이다."},
    "PT04": {"criteria": [f"criterion:PT04-C{i}" for i in range(1, 4)], "title": "로컬 transport 인수검사", "guide": "PORTABLE_TRANSFER_IMPORT.md", "scope": "LINUX_LOCAL_ONLY; PT04-C3_LINUX_MEASURED_OTHER_PLATFORMS_NOT_RUN", "implementation": "LOCAL_ACCEPTANCE_AND_CI_MATRIX", "status": "LOCAL_CASES_PASS", "description": "별도 producer/consumer와 measurement CLI를 Linux에서 실행한다.", "limits": "macOS/Windows는 NOT_RUN이며 CI matrix는 실행 증거가 아니다."},
}
CRITERIA = [criterion for task in TASKS.values() for criterion in task["criteria"]]
BOUNDARIES = {"authority": "SECONDARY_AI", "atomicSnapshot": "NOT_CLAIMED",
              "crossPlatformAcceptance": "NOT_RUN", "transfer": "PINNED_FILES_LOCAL_SCOPE",
              "restore": "PT03_FILE_PROFILE_IMPLEMENTED_GIT_PENDING", "executionAuthority": "NOT_GRANTED"}


def require(value, message):
    if not value:
        raise AssertionError(message)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def sha(value):
    return "sha256:" + hashlib.sha256(value).hexdigest()


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def source_closure(entries):
    """Entries plus the local code they import or spawn (scripts/source-closure.ts)."""
    result = subprocess.run(["node", "--import", "tsx", "scripts/source-closure.ts", *entries], cwd=ROOT, capture_output=True, text=True, timeout=120, check=True)
    return json.loads(result.stdout)


def pins():
    # The executed tests and spawned acceptance scripts with the local code they load;
    # src/ files outside that closure cannot change this evidence.
    paths = set(source_closure(TEST_FILES + ["test/fixtures.ts", "scripts/usl-transfer-export.ts", "scripts/usl-transfer-import.ts", "scripts/measure-portable-transfer.ts", "scripts/portable-transfer-acceptance.ts"]))
    paths.update(["package.json", "package-lock.json", "tsconfig.json",
                              "docs/CHECKOUT_GUARD.md", "docs/PORTABLE_TRANSFER_EXPORT.md", "docs/PORTABLE_TRANSFER_IMPORT.md", ".github/workflows/portable-transfer.yml",
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


def json_command(command):
    run = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, timeout=120, check=True)
    return json.loads(run.stdout)


def validate_acceptance(value, commit):
    require(value["schema"] == "usl-development-progress-acceptance/v1" and value["sourceCommit"] == commit, "acceptance source mismatch")
    require(value["platforms"] == {"linux": "LOCAL_PASS", "macos": "NOT_RUN", "windows": "NOT_RUN"}, "platform coverage promoted")
    producer, consumer, measurement = (value[k] for k in ("producer", "consumer", "measurement"))
    require(re.fullmatch(r"sha256:[0-9a-f]{64}", producer["receiptDigest"]), "invalid producer digest")
    require(consumer["schema"] == "usl-portable-transfer-consumer-report/v1" and measurement["schema"] == "usl-portable-transfer-measurement/v1", "acceptance report schema drift")
    require(consumer["sourceBundleReceiptDigest"] == producer["receiptDigest"], "acceptance receipt binding drift")
    require(consumer["platform"] == measurement["platform"] == "linux", "local Linux evidence required")
    require(consumer["roleVerification"] == "PASS" and consumer["roles"] == [{"role": "memory", "resource": "note"}, {"role": "source", "resource": "source"}], "acceptance role drift")
    expected = [("note", "nested/note.txt", b"portable memory\n"), ("source", "nested/binary/source.bin", bytes([0, 1, 2, 255, 128, 17]))]
    payloads = [{"nativeId": "portable-" + name, "revisionId": "urn:example:revision:" + name, "representationId": "urn:example:representation:" + name, "restorePath": path, "bytes": len(data), "digest": sha(data)} for name, path, data in expected]
    require(consumer["payloads"] == payloads, "acceptance identity or payload mismatch")
    require(producer["resources"] == [p["nativeId"] for p in payloads], "producer identity mismatch")
    require(producer["bytes"] == consumer["importedBytes"] == measurement["importedBytes"] == sum(p["bytes"] for p in payloads), "acceptance byte count mismatch")
    require(measurement["restoredFiles"] == len(payloads) and sorted(measurement["postRestoreDigests"]) == sorted(p["digest"] for p in payloads), "post-restore hash mismatch")
    for report, fields in ((consumer, ("importAndRebindWallMs", "peakRssKiB")), (measurement, ("importWallMs", "postRestoreHashWallMs", "peakRssKiB"))):
        require(report["executionCalls"] == 0 and report["operations"] == "HISTORICAL_UNRECONCILED", "acceptance operation boundary promoted")
        require(all(type(report[field]) in (int, float) and math.isfinite(report[field]) and report[field] >= 0 for field in fields), "invalid measured metrics")


def acceptance_record(commit):
    """Record actual local producer/copy/delete/consumer/measurement evidence, never paths."""
    with tempfile.TemporaryDirectory(prefix="usl-pt04-progress-") as temp:
        root = pathlib.Path(temp)
        producer_parent, transferred_parent, consumer_parent, measure_parent = [root / name for name in ("producer", "transferred", "consumer", "measure")]
        for directory in (producer_parent, transferred_parent, consumer_parent, measure_parent):
            directory.mkdir()
        producer = json_command(["node", "--import", "tsx", "scripts/portable-transfer-acceptance.ts", "produce", "--bundle-parent", str(producer_parent)])
        original = pathlib.Path(producer["bundlePath"])
        require(original.parent == producer_parent.resolve() and original.is_dir(), "producer returned a bundle outside its temporary parent")
        copied = transferred_parent / producer["bundleName"]
        shutil.copytree(original, copied)
        shutil.rmtree(original)
        require(not original.exists(), "producer bundle remained after transfer copy")
        consumer = json_command(["node", "--import", "tsx", "scripts/portable-transfer-acceptance.ts", "consume", "--bundle", str(copied), "--receipt-digest", producer["receiptDigest"], "--destination-parent", str(consumer_parent)])
        measurement = json_command(["node", "--import", "tsx", "scripts/measure-portable-transfer.ts", "--bundle", str(copied), "--receipt-digest", producer["receiptDigest"], "--destination-parent", str(measure_parent), "--destination-name", "measured", "--owner-namespace", "urn:example:pt04:transport"])
        require(consumer["sourceBundleReceiptDigest"] == producer["receiptDigest"], "acceptance receipt digest mismatch")
        require(consumer["platform"] == measurement["platform"] == "linux", "record only a real Linux local acceptance")
        require(consumer["roleVerification"] == "PASS" and consumer["executionCalls"] == measurement["executionCalls"] == 0, "acceptance effects or roles invalid")
        for report, fields in ((consumer, ("importAndRebindWallMs", "peakRssKiB")), (measurement, ("importWallMs", "postRestoreHashWallMs", "peakRssKiB"))):
            require(all(isinstance(report[field], (int, float)) and report[field] >= 0 for field in fields), "acceptance metrics must be actual non-negative measurements")
        value = {"schema": "usl-development-progress-acceptance/v1", "sourceCommit": commit, "platforms": {"linux": "LOCAL_PASS", "macos": "NOT_RUN", "windows": "NOT_RUN"}, "producer": {"receiptDigest": producer["receiptDigest"], "bytes": producer["bytes"], "resources": producer["resources"]}, "consumer": consumer, "measurement": measurement}
        validate_acceptance(value, commit)
        return value


def coverage(criterion):
    if criterion == "criterion:PT03-C5": return "REJECTION_ONLY_GIT_RESTORE_PENDING"
    if criterion == "criterion:PT04-C1": return "LINUX_LOCAL_ONLY"
    if criterion == "criterion:PT04-C3": return "LINUX_MEASURED_OTHER_PLATFORMS_NOT_RUN"
    return "LOCAL_CASES_PASS"


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
        acceptance = acceptance_record(commit)
        acceptance_text = encoded(acceptance)
        require(pins() == source_pins, "sources changed during execution")
        receipt = {"schema": "usl-development-progress/v3", **BOUNDARIES,
                   "observations": [{"task": "task:" + task, "implementation": config.get("implementation", "IMPLEMENTED_LOCAL_SCOPE"),
                                     "status": config.get("status", "LOCAL_CASES_PASS"), "scope": config["scope"], "criteria": config["criteria"]}
                                    for task, config in TASKS.items()],
                   "recordedAt": datetime.now(timezone.utc).isoformat(), "sourceCommit": commit,
                   "environment": {"system": platform.system(), "machine": platform.machine(),
                                   "node": subprocess.check_output(["node", "--version"], text=True).strip(),
                                   "git": git("--version").decode().strip()},
                   "command": COMMAND, "pins": source_pins, "tapDigest": sha(result.stdout.encode()),
                   "tests": tests, "totals": totals, "criteria": CRITERIA, "acceptanceDigest": sha(acceptance_text.encode()), "nextTask": "task:PT03"}
        (BASE / "tests.tap").write_text(result.stdout)
        (BASE / "acceptance.json").write_text(acceptance_text)
        (BASE / "receipt.json").write_text(encoded(receipt))
    else:
        receipt = json.loads((BASE / "receipt.json").read_text())
    require(receipt["pins"] == pins(), "progress evidence is stale; rerun --record after committing the new sources")
    for pin in receipt["pins"]:
        require(sha(git("show", f"{receipt['sourceCommit']}:{pin['path']}")) == pin["sha256"], "historical execution pin mismatch")
    log = (BASE / "tests.tap").read_text()
    tests, totals = parse_tests(log)
    acceptance = json.loads((BASE / "acceptance.json").read_text())
    require(receipt["acceptanceDigest"] == sha((BASE / "acceptance.json").read_bytes()), "acceptance report digest mismatch")
    validate_acceptance(acceptance, receipt["sourceCommit"])
    require(receipt["tests"] == tests and receipt["totals"] == totals and receipt["tapDigest"] == sha(log.encode()), "receipt/TAP mismatch")
    expected_observations = [{"task": "task:" + task, "implementation": config.get("implementation", "IMPLEMENTED_LOCAL_SCOPE"),
                              "status": config.get("status", "LOCAL_CASES_PASS"), "scope": config["scope"], "criteria": config["criteria"]}
                             for task, config in TASKS.items()]
    require(receipt["schema"] == "usl-development-progress/v3"
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
         "d:sha256": sha((BASE / "receipt.json").read_bytes()), "d:tapDigest": receipt["tapDigest"], "d:acceptanceDigest": receipt["acceptanceDigest"], "d:acceptance": ref(p + "acceptance")},
        {"@id": p + "acceptance", "@type": ["d:AcceptanceObservation", "prov:Entity"],
         "d:path": "research/development-progress/acceptance.json", "d:sha256": receipt["acceptanceDigest"],
         "d:sourceCommit": acceptance["sourceCommit"], "d:linux": "LOCAL_PASS", "d:macos": "NOT_RUN", "d:windows": "NOT_RUN",
         "d:task": ref("task:PT04"), "prov:wasDerivedFrom": ref(p + "receipt")},
        *[{"@id": criterion, "@type": "d:Criterion", "d:coverage": coverage(criterion), "d:checkedBy": [ref(t["id"]) for t in tests if t["name"].startswith(criterion.removeprefix("criterion:") + ":")]} for criterion in CRITERIA],
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
    bad = Graph()
    for triple in graph:
        bad.add(triple)
    bad.set((URIRef("criterion:PT03-C5"), D.coverage, Literal("LOCAL_CASES_PASS")))
    require(not conform(bad, shapes), "PT03-C5 coverage promotion must fail")
    for subject, predicate, value in [("criterion:PT04-C1", D.coverage, "LOCAL_CASES_PASS"), (p + "acceptance", D.windows, "PASS")]:
        bad = Graph()
        for triple in graph:
            bad.add(triple)
        bad.set((URIRef(subject), predicate, Literal(value)))
        require(not conform(bad, shapes), "unexecuted platform promotion must fail")
    lines = [
        "# USL 개발 진행", "",
        "[원래 개발 계획](DEVELOPMENT_PLAN.md)은 당시의 PLANNED/NOT_RUN 스냅샷으로 보존한다. 이 문서는 별도 실행 기록으로 구현 진행을 나타낸다.", "",
        f"기록 {receipt['recordedAt']}; 소스 `{receipt['sourceCommit']}`.", "",
        f"실제 로컬 검사 **{totals['tests']}개 PASS**, 실패/건너뜀 0. 실행 환경: {receipt['environment']['system']} / {receipt['environment']['node']} / {receipt['environment']['git']}.", "",
    ]
    for task, config in TASKS.items():
        lines += [f"## {task} · {config['title']}", "",
                  f"상태: **{config.get('implementation', 'IMPLEMENTED_LOCAL_SCOPE')} / {config.get('status', 'LOCAL_CASES_PASS')}**. " + config["description"], "",
                  f"[사용법과 한계]({config['guide']}). " + config["limits"], "",
                  "| 계획 완료 조건 | 확인 범위 | 실행한 검사 |", "|---|---|---|"]
        lines += [f"| {c} | {coverage(c)} | " + "<br>".join(t["name"] for t in tests if t["name"].startswith(c.removeprefix("criterion:") + ":")) + " |" for c in config["criteria"]]
        lines += [""]
    lines += [
        "## 실제 로컬 이동 관측", "",
        "서로 다른 임시 root에서 producer → bundle 복사 → 원본 bundle 삭제 → consumer·재바인딩을 실행했다. producer가 원본 파일도 삭제한다. 별도 새 프로세스·목적지에서 import와 후속 해시를 측정했다. 작은 고정 fixture의 관측으로, 실제 두 기기나 OS 간 성능을 대표하지 않는다.", "",
        "| 관측 | 값 |", "|---|---|",
        f"| payload bytes / 파일 수 | {acceptance['measurement']['importedBytes']} / {acceptance['measurement']['restoredFiles']} |",
        f"| import·재바인딩 시간 | {acceptance['consumer']['importAndRebindWallMs']:.3f} ms |",
        f"| 별도 import / 후속 해시 시간 | {acceptance['measurement']['importWallMs']:.3f} / {acceptance['measurement']['postRestoreHashWallMs']:.3f} ms |",
        f"| 별도 측정 프로세스 peak RSS | {acceptance['measurement']['peakRssKiB']} KiB |",
        "| Linux / macOS / Windows | LOCAL_PASS / NOT_RUN / NOT_RUN |", "",
        "[실제 consumer·측정 출력](../research/development-progress/acceptance.json). OS 전달 CI는 작성되었으며 이 기록에서 원격 실행하지 않았다.", "",
        "다음 보완 대상은 **PT03-C5 Git 복원** 및 PT04의 macOS/Windows 실제 인수검사다. 실행·owner 권한은 이 기록으로 부여되지 않는다.", "",
        "[실행 receipt](../research/development-progress/receipt.json) · [TAP 원문](../research/development-progress/tests.tap) · [typed RDF](../research/development-progress/trace.jsonld) · [SHACL](../schemas/development-progress/progress.shacl.ttl). 실행 당시 source pin과 현재 bytes를 함께 검사하므로 구현 변경 후에는 실제 검사를 다시 실행해야 한다.", "",
        "```sh", "python3 scripts/record-development-progress.py --record", "python3 scripts/record-development-progress.py --check", "```", "",
    ]
    document = "\n".join(lines)
    target = ROOT / "docs/DEVELOPMENT_PROGRESS.md"
    if args.check:
        require(target.read_text() == document, "progress document drift")
    else:
        target.write_text(document)
    print(encoded({"mode": "CHECKED" if args.check else "RECORDED", "tasks": list(TASKS), "tests": totals["tests"], "shacl": "CONFORMS", "negativeCases": 6, "nextTask": receipt["nextTask"]}))


if __name__ == "__main__":
    main()
