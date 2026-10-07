"""Build a pinned, local development history and remaining-work view; never execute it.

Usage: python3 scripts/build-development-lineage.py [--check]
The catalog's sourceCommit bounds history. Updating it is an explicit editorial
change; a later HEAD does not silently rewrite historical evidence.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
FOLDER = "research/development-lineage"
NS = "urn:usl:development-lineage:"
PROV = "http://www.w3.org/ns/prov#"
REPO = "https://github.com/gj3447/USL"


def encoded(value):
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def sha(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def build():
    raw = (ROOT / FOLDER / "catalog.json").read_bytes()
    catalog = json.loads(raw)
    base = catalog["sourceCommit"]
    assert len(base) == 40 and git("rev-parse", base).decode().strip() == base
    assert catalog["authority"] == "SECONDARY_AI"
    graph = {"schema": "usl-resource-graph/v1", "resources": [], "meanings": [], "links": [],
             "provenance": {"sources": ["input:usl-lineage:catalog"],
                            "activity": "activity:usl-lineage", "agent": "agent:usl-lineage"}}
    resources, bindings, selections, sources, edges, definitions = {}, [], [], {}, [], {}
    workspace_rep = {"kind": "workspace", "workspace": "usl", "path": FOLDER + "/catalog.json",
                     "relation": "documentation", "digest": sha(raw)}

    def node(uid, kind, metadata, representation=None, prov_type="Entity"):
        assert uid not in resources, f"duplicate node {uid}"
        rep = dict(workspace_rep if representation is None else representation)
        rep["id"] = "rep_" + hashlib.sha256(uid.encode()).hexdigest()[:24]
        locator = rep.get("locator", REPO + "/blob/master/" + rep.get("path", FOLDER + "/catalog.json"))
        value = {"id": uid, "types": [NS + kind, PROV + prov_type], "locator": locator, "metadata": metadata}
        resources[uid] = value
        graph["resources"].append(value)
        bindings.append({"id": uid, "representations": [rep]})
        selections.append({"resource": uid, "representation": rep["id"]})
        return uid

    def relation(name, from_role, from_type, to_role, to_type, meaning):
        definitions[name] = {"id": NS + name, "description": meaning,
                             "roles": [(from_role, from_type), (to_role, to_type)]}

    def edge(name, source, target, status="RECORDED_RELATION"):
        definition = definitions[name]
        for uid, (_, kind) in zip((source, target), definition["roles"]):
            assert NS + kind in resources[uid]["types"], f"wrong endpoint {name} {uid}"
        identity = sha(json.dumps([name, source, target], separators=(",", ":")).encode())[7:]
        uid = "lineage-link:" + identity
        assert not any(x["id"] == uid for x in graph["links"]), "duplicate edge"
        graph["links"].append({"id": uid, "meaning": NS + name,
            "participants": [{"role": role, "resource": target_id}
                             for (role, _), target_id in zip(definition["roles"], (source, target))],
            "metadata": {"authority": "SECONDARY_AI", "status": status,
                         "recordedOn": catalog["recordedOn"], "evidenceScope": "PINNED_LOCAL_HISTORY_VIEW"}})
        edges.append({"id": uid, "from": source, "predicate": name, "to": target, "status": status})

    def source(path, revision=base):
        key = (revision, path)
        if key not in sources:
            assert not Path(path).is_absolute() and ".." not in Path(path).parts
            data = git("show", revision + ":" + path)
            uid = "source:usl-lineage:" + revision + ":" + hashlib.sha256(path.encode()).hexdigest()[:12]
            sources[key] = node(uid, "Source", {"path": path, "sourceCommit": revision, "sha256": sha(data),
                "scope": "PINNED_GIT_BLOB_NOT_LIVE_SERVICE"},
                {"kind": "locator", "relation": "snapshot", "locator": f"git://github.com/gj3447/USL@{revision}:{path}", "digest": sha(data)})
        return sources[key]

    def read_json(path):
        source(path)
        return json.loads(git("show", base + ":" + path))

    def documentation(path):
        uid = source(path)
        return {"kind": "locator", "relation": "documentation", "locator": resources[uid]["locator"],
                "digest": resources[uid]["metadata"]["sha256"]}

    for row in [
        ("snapshot_subject", "snapshot", "Snapshot", "subject", "ConceptReference", "Local view is about an existing stable KG concept; does not write or redefine it"),
        ("snapshot_request", "snapshot", "Snapshot", "statement", "UserStatement", "This AI view responds to the verbatim user request"),
        ("snapshot_milestone", "snapshot", "Snapshot", "milestone", "Milestone", "Navigation entry to an AI-selected historical milestone"),
        ("snapshot_facet", "snapshot", "Snapshot", "assessment", "HswmAssessment", "Navigation entry to a scoped HSWM linkage assessment"),
        ("snapshot_next", "snapshot", "Snapshot", "task", "RemainingTask", "Next proposed implementation task, without execution authority"),
        ("parent", "child", "Commit", "parent", "Commit", "Git child commit has this exact parent; does not imply semantic supersession"),
        ("milestone_commit", "milestone", "Milestone", "commit", "Commit", "AI-selected milestone refers to this recorded commit"),
        ("milestone_source", "milestone", "Milestone", "source", "Source", "Versioned artifact supports the milestone description, not runtime success"),
        ("milestone_package", "milestone", "Milestone", "package", "Package", "Milestone contributes to this package's scope; not a completion assertion"),
        ("source_revision", "source", "Source", "commit", "Commit", "Source bytes are taken from this immutable Git revision"),
        ("task_requirement", "task", "Task", "requirement", "Requirement", "Original task addresses original requirement"),
        ("criterion_task", "criterion", "Criterion", "task", "Task", "Original criterion belongs to original task"),
        ("package_task", "package", "Package", "task", "Task", "Existing completion package refines original task"),
        ("package_criterion", "package", "Package", "criterion", "Criterion", "Completion package addresses this original criterion"),
        ("depends_on", "package", "Package", "prerequisite", "Package", "Unconditional planned package dependency; not a runtime execution edge"),
        ("conditionally_depends_on", "package", "Package", "prerequisite", "Package", "Original conditional package dependency retained verbatim in package metadata"),
        ("has_acceptance", "package", "Package", "acceptance", "Acceptance", "Original future acceptance, distinct from later observations"),
        ("assessment_package", "assessment", "PackageAssessment", "package", "Package", "Bounded current evidence assessment does not rewrite original plan status"),
        ("assessment_source", "assessment", "PackageAssessment", "source", "Source", "Pinned historical receipt or plan grounds this assessment"),
        ("assessment_run", "assessment", "PackageAssessment", "run", "RecordedRun", "Assessment cites this historical test run, not a fresh execution"),
        ("run_commit", "run", "RecordedRun", "commit", "Commit", "Historical run reports this tested implementation revision"),
        ("run_receipt", "run", "RecordedRun", "source", "Source", "Git-pinned receipt is evidence of a past reported run"),
        ("run_source", "run", "RecordedRun", "source", "Source", "Receipt pins these exact source bytes at tested revision"),
        ("run_test", "run", "RecordedRun", "test", "TestObservation", "Named historical result included in this recorded run"),
        ("test_acceptance", "test", "TestObservation", "acceptance", "Acceptance", "Historical bounded test addresses a planned acceptance without declaring full completion"),
        ("refines_package", "task", "RemainingTask", "package", "Package", "Actionable remaining subtask of an existing package"),
        ("remaining_depends_on", "task", "RemainingTask", "prerequisite", "RemainingTask", "Required order within the remaining subtask view"),
        ("remaining_source", "task", "RemainingTask", "source", "Source", "Pinned limitation or contract grounds remaining work"),
        ("facet_source", "assessment", "HswmAssessment", "source", "Source", "Evidence for scoped HSWM linkage; never grants access or learning authority"),
        ("statement_source", "statement", "UserStatement", "source", "Source", "Verbatim statement preserved in a versioned source; interpretation remains separate"),
        ("requirement_source", "requirement", "Requirement", "source", "Source", "AI requirement is stored in the original development plan"),
    ]:
        relation(*row)

    node("input:usl-lineage:catalog", "Input", {"path": FOLDER + "/catalog.json", "sha256": sha(raw)})
    node("agent:usl-lineage", "Agent", {"authority": "SECONDARY_AI"}, prov_type="Agent")
    node("activity:usl-lineage", "Activity", {"recordedOn": catalog["recordedOn"], "execution": "LOCAL_GRAPH_BUILD_ONLY"}, prov_type="Activity")
    node(catalog["id"], "Snapshot", {"sourceCommit": base, "authority": "SECONDARY_AI",
        "coverageScope": catalog["coverageScope"], "nextTask": catalog["nextTask"], **catalog["boundaries"]})
    node(catalog["userRequest"]["id"], "UserStatement", catalog["userRequest"])
    node("sym:Concept:usl", "ConceptReference", {"nativeUid": "sym:Concept:usl", "authority": "REFERENCE_ONLY",
        "scope": "EXISTING_KG_ID_NO_CANON_REDEFINITION"}, documentation("README.md"))
    edge("snapshot_subject", catalog["id"], "sym:Concept:usl")
    edge("snapshot_request", catalog["id"], catalog["userRequest"]["id"])
    commits = []
    for line in git("log", "--reverse", "--topo-order", "--format=%H%x09%T%x09%P%x09%cI%x09%s", base).decode().splitlines():
        commit, tree, parents, committed_at, subject = line.split("\t", 4)
        record = {"commit": commit, "tree": tree, "parents": parents.split(), "committedAt": committed_at,
                  "subject": subject, "authority": "REPOSITORY_RECORD", "claim": "COMMIT_EXISTS_NOT_RUNTIME_PASS"}
        commits.append(record)
        node("commit:usl:" + commit, "Commit", record,
             {"kind": "locator", "relation": "snapshot", "locator": "git://github.com/gj3447/USL@" + commit})
    for record in commits:
        for parent in record["parents"]:
            edge("parent", "commit:usl:" + record["commit"], "commit:usl:" + parent)
    for item in catalog["milestones"]:
        node(item["id"], "Milestone", item)
        edge("snapshot_milestone", catalog["id"], item["id"])
        edge("milestone_commit", item["id"], "commit:usl:" + item["commit"])
        edge("milestone_source", item["id"], source(item["sourcePath"], item["commit"]))

    old_path, completion_path = "research/development-plan/plan.json", "research/completion-plan/plan.json"
    old, completion = read_json(old_path), read_json(completion_path)
    for field, kind in [("requirements", "Requirement"), ("tasks", "Task"), ("criteria", "Criterion")]:
        for item in old[field]:
            node(item["id"], kind, {**item, "sourceCommit": base, "sourcePath": old_path,
                "viewScope": "HISTORICAL_PLAN_NOT_CURRENT_EXECUTION"},
                {"kind": "locator", "relation": "documentation", "locator": f"git://github.com/gj3447/USL@{base}:{old_path}"})
    for item in old["requirements"]:
        edge("requirement_source", item["id"], source(old_path))
    for item in old["tasks"]:
        for requirement in item["requirementIds"]:
            edge("task_requirement", item["id"], requirement)
    for item in old["criteria"]:
        edge("criterion_task", item["id"], item["taskId"])

    receipt_path = "research/clean-git-progress/receipt.json"
    receipt = read_json(receipt_path)
    assert receipt["schema"] == "usl-clean-git-progress/v4"
    for package in completion["packages"]:
        node(package["id"], "Package", package,
             {"kind": "locator", "relation": "documentation", "locator": f"git://github.com/gj3447/USL@{base}:{completion_path}"})
    for item in catalog["milestones"]:
        for package in item["packageIds"]:
            edge("milestone_package", item["id"], package)
    for package in completion["packages"]:
        for task in package["canonicalTaskIds"]:
            edge("package_task", package["id"], task)
        for criterion in package["criterionIds"]:
            edge("package_criterion", package["id"], criterion)
        for field in ["dependsOn", "conditionalDependsOn"]:
            for prior in package[field]:
                edge("depends_on" if field == "dependsOn" else "conditionally_depends_on", package["id"], prior, "PLANNING_RELATION")
        for acceptance in package["acceptance"]:
            node(acceptance["id"], "Acceptance", acceptance, documentation(completion_path))
            edge("has_acceptance", package["id"], acceptance["id"], "PLANNING_RELATION")
        short = package["id"].split(":")[1]
        status = receipt["implementations"].get(short, "NO_NEW_ACCEPTANCE_IMPORTED")
        assessment = "assessment:usl-package:" + short
        node(assessment, "PackageAssessment", {"status": status, "authority": "SECONDARY_AI",
            "scope": receipt["boundaries"].get(short, {"basis": "ORIGINAL_PLAN_ONLY_REASSESS_BEFORE_EXECUTION"}),
            "historicalTestSourceCommit": receipt["sourceCommit"] if short in receipt["implementations"] else "NOT_APPLICABLE",
            "runtimeRerun": "NOT_RUN", "complete": False},
            documentation(receipt_path if short in receipt["implementations"] else completion_path))
        edge("assessment_package", assessment, package["id"])
        edge("assessment_source", assessment, source(receipt_path if short in receipt["implementations"] else completion_path))

    assert receipt["totals"]["pass"] == len(receipt["tests"]) == receipt["totals"]["tests"]
    assert all(receipt["totals"][k] == 0 for k in ("fail", "skipped", "cancelled", "todo"))
    run = node("run:usl-clean-git:" + sha(git("show", base + ":" + receipt_path))[7:], "RecordedRun",
        {"recordedAt": receipt["recordedAt"], "sourceCommit": receipt["sourceCommit"],
         "status": "HISTORICAL_LOCAL_CASES_PASS", "runtimeRerun": "NOT_RUN", "environment": receipt["environment"],
         "totals": receipt["totals"], "scope": "LINUX_LOCAL_SELECTED_GIT_PROFILES_ONLY"}, documentation(receipt_path))
    edge("run_commit", run, "commit:usl:" + receipt["sourceCommit"])
    edge("run_receipt", run, source(receipt_path))
    for pin in receipt["sources"]:
        uid = source(pin["path"], receipt["sourceCommit"])
        assert resources[uid]["metadata"]["sha256"] == pin["sha256"], "historical receipt source drift"
        edge("run_source", run, uid)
    for name in receipt["tests"]:
        uid = node("test:usl-clean-git:" + hashlib.sha256(name.encode()).hexdigest(), "TestObservation",
                   {"name": name, "status": "HISTORICAL_PASS", "runtimeRerun": "NOT_RUN", "recordedAt": receipt["recordedAt"]}, documentation(receipt_path))
        edge("run_test", run, uid)
        edge("test_acceptance", uid, "acceptance:" + name.split(":", 1)[0])
    for short in receipt["implementations"]:
        edge("assessment_run", "assessment:usl-package:" + short, run)

    for item in catalog["remaining"]:
        node(item["id"], "RemainingTask", item)
    edge("snapshot_next", catalog["id"], catalog["nextTask"], "PLANNING_RELATION")
    for item in catalog["remaining"]:
        edge("refines_package", item["id"], item["packageId"], "PLANNING_RELATION")
        for prior in item["dependsOn"]:
            edge("remaining_depends_on", item["id"], prior, "PLANNING_RELATION")
        edge("remaining_source", item["id"], source(completion_path))
        detail = "docs/PORTABLE_TRANSFER_GIT_STATE.md" if item["packageId"] in ("package:CP02", "package:CP03") else "docs/RULE_WEIGHT_REVIEW.md" if item["packageId"] in ("package:CP21", "package:CP22") else receipt_path
        edge("remaining_source", item["id"], source(detail))
    for item in catalog["hswmFacets"]:
        node(item["id"], "HswmAssessment", item)
        edge("snapshot_facet", catalog["id"], item["id"])
        edge("facet_source", item["id"], source(item["sourcePath"]))
    # Keep the actual user text and AI classification separate; do not update KG canon.
    scope_path = "research/architecture/hswm-like.plan.json"
    for item in read_json(scope_path)["scopeCorrections"]:
        node(item["id"], "UserStatement", item, documentation(scope_path))
        edge("statement_source", item["id"], source(scope_path))
    for item in catalog["competencyQuestions"]:
        node(item["id"], "CompetencyQuestion", item)
    for (revision, _), uid in sources.items():
        edge("source_revision", uid, "commit:usl:" + revision)

    profile = {"schema": "usl-domain-profile/v1", "id": NS + "profile", "version": "1", "closedMeanings": True,
        "meanings": [{"id": d["id"], "allowExtraRoles": False,
            "roles": [{"role": role, "required": True, "types": [NS + kind], "metadata": []}
                      for role, kind in d["roles"]]} for d in definitions.values()]}
    graph["meanings"] = [{"id": d["id"], "description": d["description"]} for d in definitions.values()]
    # Direct domain RDF is separate from the native USL link projection. Edge
    # records retain status and attribution instead of implying unqualified truth.
    ref = lambda x: {"@id": x}
    trace_nodes = []
    for item in graph["resources"]:
        scalar = {"l:" + k: v for k, v in item["metadata"].items() if isinstance(v, (str, bool, int, float))}
        value = {"@id": item["id"], "@type": item["types"], **scalar}
        if PROV + "Activity" in item["types"]:
            value.update({"prov:wasAssociatedWith": ref("agent:usl-lineage"), "prov:used": ref("input:usl-lineage:catalog")})
        # Generating this view did not generate Git commits, user utterances,
        # old plans, source blobs, or historical test results. Attribute only
        # the new snapshot/AI assessments to the current projection activity.
        elif any(NS + kind in item["types"] for kind in ("Snapshot", "Milestone", "PackageAssessment", "HswmAssessment", "RemainingTask")):
            value["prov:wasGeneratedBy"] = ref("activity:usl-lineage")
        trace_nodes.append(value)
    for item in edges:
        trace_nodes.extend([
            {"@id": item["from"], "l:" + item["predicate"]: ref(item["to"])},
            {"@id": item["id"], "@type": "l:Relationship", "l:from": ref(item["from"]), "l:to": ref(item["to"]),
             "l:predicate": item["predicate"], "l:status": item["status"], "l:authority": "SECONDARY_AI",
             "prov:wasDerivedFrom": ref("input:usl-lineage:catalog")}])
    trace = {"@context": {"l": NS, "prov": PROV}, "@graph": trace_nodes}
    inventory = {"schema": "usl-development-lineage-inventory/v1", "sourceCommit": base,
                 "coverageScope": catalog["coverageScope"], "commits": commits,
                 "sources": [resources[uid]["metadata"] for uid in sources.values()],
                 "counts": {"commits": len(commits), "milestones": len(catalog["milestones"]), "packages": len(completion["packages"]),
                            "remainingTasks": len(catalog["remaining"]), "hswmFacets": len(catalog["hswmFacets"]),
                            "resources": len(resources), "links": len(edges)}}
    # A bounded induced view works with the ordinary CLI budget. Full history
    # remains available through an explicitly budgeted, deny-all MCP connection.
    next_ids = {catalog["id"], catalog["userRequest"]["id"], "sym:Concept:usl",
                "input:usl-lineage:catalog", "activity:usl-lineage", "agent:usl-lineage"}
    next_ids.update(x["id"] for x in catalog["remaining"])
    next_ids.update(x["packageId"] for x in catalog["remaining"])
    next_graph = {**graph, "resources": [r for r in graph["resources"] if r["id"] in next_ids],
                  "links": [link for link in graph["links"] if all(p["resource"] in next_ids for p in link["participants"])]}
    outputs = {"graph.json": graph, "profile.json": profile, "trace.jsonld": trace,
               "next.graph.json": next_graph,
               "mcp.json": {"allowedLocators": [], "maxResources": 64, "maxInputBytes": 16777216, "maxOutputBytes": 16777216,
                   "programs": {}, "connections": {"usl-development-lineage": {"graph": "graph.json", "profile": "profile.json",
                   "namespace": "usl.development.lineage", "format": "resource-graph"}}},
               "bindings.json": {"schema": "usl-resource-bindings/v1", "resources": bindings},
               "selections.json": selections, "inventory.json": inventory,
               "host.json": {"schema": "usl-cli-host/v1", "bindings": "bindings.json", "workspaces": {"usl": "../.."}, "maxSourceBytes": 1048576, "actions": []}}
    rendered = {FOLDER + "/" + name: encoded(value) for name, value in outputs.items()}
    rows = [
        "# USL 개발 변천사와 남은 작업", "",
        "기존 그래프는 CP03 작업 상태 복원·재연결 제안의 인수 근거까지 갖고 있다. 이번 뷰는 흩어진 계획·실행 기록을 Git 이력과 연결한다. **HSWM 자료 연결과 오프라인 W 검토는 있으나, 개발사 전체의 live HSWM 실행·학습 완료는 입증되지 않았다.**", "",
        f"기준 Git `{base}`, 기록일 {catalog['recordedOn']}. 이 기준에서 도달 가능한 **{len(commits)}개 커밋과 부모 관계 전체**, AI가 선정한 **{len(catalog['milestones'])}개 주요 단계**, 기존 **{len(completion['packages'])}개 CP 작업**, **{len(catalog['remaining'])}개 세부 잔여 작업**, **{len(catalog['hswmFacets'])}개 HSWM 연결 평가**를 담았다.", "",
        "모든 대화·실행 이벤트의 전수 이력은 아니다. Git 메시지는 저장소 기록이고 단계 분류는 SECONDARY_AI다. 사용자 원문은 별도 UserStatement이며, 연결이나 분류가 canon·권한·실행 성공을 만들지 않는다. 이 그래프 자체를 추가한 이후의 커밋은 다음 명시적 갱신 전까지 포함되지 않는다.", "",
        "## 연결 구조", "", "```mermaid", "flowchart LR",
        "  Requirement[기존 요구사항] --> Task[원래 과제] --> Package[기존 CP 작업]",
        "  Package --> Remaining[세부 잔여 작업과 NOT_RUN 인수 조건]",
        "  Milestone[주요 개발 단계] --> Package",
        "  Milestone --> Commit[Git 커밋과 부모]",
        "  Milestone --> Source[revision과 digest가 고정된 원문]",
        "  Assessment[현재 범위 평가] --> Package",
        "  Assessment --> Run[과거 검증 실행] --> Test[개별 테스트] --> Acceptance[기존 인수 조건]",
        "  Run --> Commit", "  Run --> Source", "  HSWM[HSWM 연결 수준 평가] --> Source", "```", "",
        "그림은 읽기 순서다. 실제 관계 방향·역할·타입·필수 cardinality는 [profile](../research/development-lineage/profile.json)에 명시했다. 각 관계는 두 역할을 정확히 하나씩 갖는다. `parent`는 자식→부모, 의존 관계는 후속→선행이다. Git 부모 관계와 개별 의존 관계에만 비순환 검사를 적용하며, 그래프 전체에 DAG를 강제하지 않는다.", "",
        "## 지금 남은 구체 작업", "",
        "기존 [CP01–CP23 계획](COMPLETION_PLAN.md)을 대체하거나 범위를 줄이지 않는다. 아래는 현재 우선순위를 실행 단위로 구체화한 부분집합이다. CP08–20 등의 메모리 anchor·표준 교환·다기기 revision·CLI 호환성도 원래 ID와 의존성·인수 조건 그대로 연결되어 있다.", "",
        "| 세부 작업 | 원래 작업 | 선행 | 완료 조건 / 반드시 거부할 경우 |", "|---|---|---|---|",
    ]
    for item in catalog["remaining"]:
        prior = ", ".join(x.rsplit(":", 1)[1] for x in item["dependsOn"]) or "없음"
        rows.append(f"| `{item['id'].rsplit(':', 1)[1]}` · {item['title']} | {item['packageId']} | {prior} | {item['acceptance']} / {item['negativeCase']} |")
    rows += ["", "우선 **coordinated-export → state-cli → binding-registration** 순서다. advanced Git profile·일관성/장애 복구·OS별 검증은 각 CP 의존 조건을 지키면서 병렬로 준비한다. 실제 HSWM 접근·실행·적용은 owner workflow의 별도 범위다.", "",
        "모든 새 작업은 PLANNED / NOT_RUN이다. CP01–03은 기존 receipt의 로컬 지원 범위를 현재 평가로 연결했다. 나머지 CP의 `NO_NEW_ACCEPTANCE_IMPORTED`는 이번 뷰에 추가 실행 증거를 가져오지 않았다는 뜻이며, 실패·미구현을 새로 전수 확인했다는 뜻이 아니다.", "",
        "## 개발 변천사", "",
        "아래는 주요 변화만 추린 해설이다. 중간 수정·근거 갱신을 포함한 전체 커밋과 정확한 부모는 [inventory](../research/development-lineage/inventory.json)에 있다. GitHub 게시 여부는 확인하지 않았으며 모든 source hash는 로컬 Git 객체의 파일 바이트로 검사한다.", "",
        "| 주요 단계 | Git revision | 원문 경로 (해당 revision) |", "|---|---|---|",
    ]
    rows += [f"| {x['title']} | `{x['commit'][:12]}` | `{x['sourcePath']}` |" for x in catalog["milestones"]]
    rows += ["", "## 검증 근거를 읽는 방법", "",
        f"최신 clean Git receipt는 `{receipt['sourceCommit']}`에서 실행한 **{len(receipt['tests'])}개 PASS**를 기록한다. 이를 RecordedRun·TestObservation으로 가져와 각각 CP 인수 조건 및 당시 소스 pin과 연결했다. **이번에 51개 런타임 테스트를 다시 실행했다는 뜻은 아니다.** 과거 receipt·원래 PLANNED/NOT_RUN 계획은 수정하지 않는다.", "",
        "파일 전용 PT03의 `GIT_PENDING`과 CP03 Git 복원 성공은 서로 다른 profile의 관측이다. CP03의 LOCAL_STATE_PROFILE_CASES_PASS도 통합 dirty exporter·CLI·고급 Git 상태·다른 OS·실기기·crash recovery 완료를 뜻하지 않는다.", "",
        "## HSWM화 감사", "",
        "| 확인한 연결 | 증거 수준 | 한계 |", "|---|---|---|",
    ]
    rows += [f"| `{x['id'].rsplit(':', 1)[1]}` | `{x['status']}` | {x['finding']} |" for x in catalog["hswmFacets"]]
    rows += ["", "원문 근거: [HSWM 연결](HSWM_CONNECTION.md), [adapter 경계](HSWM_INTEGRATION.md), [W 검토](RULE_WEIGHT_REVIEW.md), [세션 연결](../connections/hswm-likeness/README.md). H/S/W/M 약자의 의미를 이 작업에서 새로 정의하지 않았다. soft coefficient·후보 제안·합성 outcome을 canonical W·실제 개선·적용 결과와 동일시하지 않는다.", "",
        "현재 이 개발 이력의 `hswmExecution=NOT_READY`, `hswmAuthority=NOT_GRANTED`, `operationalLearning=NOT_ESTABLISHED`다. 원격 KG에는 새 그래프를 쓰지 않았고 HSWM 외부 경로를 읽거나 실행하지 않았다. 기존 KG bridge의 PUBLISHED_DRAFT / PROPOSED는 그 당시의 예비 안내 기록으로 보존한다.", "",
        "## USL 바인딩과 재현", "",
        "모든 graph resource는 [bindings](../research/development-lineage/bindings.json)와 명시적 [selections](../research/development-lineage/selections.json)를 가진다. Git commit·원문 snapshot은 immutable Git locator를 사용하고, 계획/평가 등의 설명 표현은 `usl` workspace alias와 repository-relative catalog 경로를 사용한다. 설명 표현을 고른 것은 원문 증거를 읽은 것이 아니다. 원문은 그래프의 Source 노드로 따라가야 한다.", "",
        "[host](../research/development-lineage/host.json)의 root는 저장소 상대 경로 `../..`이고 actions는 비어 있다. 개인 절대 경로·credential을 저장하지 않는다. 별도 폴더 배치에서는 owner가 root mapping을 바꾸되 기존 resource ID·역할은 유지한다. 실제 source 파일 내용 검사는 Git pin 검사로 수행하며, binding 자체는 파일 읽기 권한이나 내용 검증을 대신하지 않는다.", "",
        "```sh", "python3 -B scripts/build-development-lineage.py --check",
        "node --import tsx scripts/validate-development-lineage.ts",
        "python3 -B scripts/validate-development-lineage.py", "```", "",
        "다음 작업 조회는 기본 CLI 한도 안의 유도 부분 그래프를 사용한다. 원래 노드 ID·metadata·역할을 바꾸지 않고 선택된 노드 사이 관계만 담는다.", "",
        "```sh",
        "npm run usl -- adapt --format resource-graph --graph research/development-lineage/next.graph.json --profile research/development-lineage/profile.json --namespace usl.development.lineage --operation context --focus lineage:usl-development-2026-10-07 --target task:usl-remaining:coordinated-export --compact",
        "```", "",
        "전체 graph는 컴파일 snapshot이 기본 CLI 입력 한도를 넘으므로, 원문·컴파일 snapshot 각각 최대 16 MiB로 제한한 기존 MCP 설정을 제공한다. 허용 locator는 비어 있고 외부 HSWM 연결이나 쓰기 동작을 등록하지 않는다.", "",
        "```sh", "npm run usl -- mcp --config research/development-lineage/mcp.json", "```", "",
        'MCP `context` 입력 예: `{"connection":"usl-development-lineage","query":{"focus":"lineage:usl-development-2026-10-07","target":"task:usl-remaining:coordinated-export","maxHops":1,"maxResources":64},"compact":true}`. 설정은 [mcp.json](../research/development-lineage/mcp.json)에 있다.', "",
        "Python RDF 검증은 기존 `scripts/requirements-standards.txt` 환경을 사용한다. TypeScript 검사는 기존 USL adapter/profile과 JSON-LD 변환, 두 임시 root 사이 바인딩 이동 시 ID·역할·원문 locator 보존을 검사한다. Python 검사는 실제 RDF/SHACL, 질의의 정확한 결과 집합, Git 부모·소스 hash·작업 의존성, 과장된 완료/권한 주장을 포함한 음성 사례를 검사한다. 런타임 기능 구현 인수와는 별도다.", "",
        "[catalog](../research/development-lineage/catalog.json) → [생성기](../scripts/build-development-lineage.py) → [USL graph](../research/development-lineage/graph.json) · [JSON-LD/RDF](../research/development-lineage/trace.jsonld) · [SHACL](../schemas/development-lineage/lineage.shacl.ttl). JSON-LD/RDF와 PROV-O 매핑·SHACL 구조 검증을 실제 사용하지만 프로젝트 어휘 자체가 보편 표준이거나 USL이 모든 그래프 표준의 상위호환이라는 주장은 하지 않는다.", "",
        "갱신할 때는 catalog의 기준 commit과 새 단계·남은 작업을 실제 근거로 수정한 뒤 생성·검증한다. 미래 PASS를 쓰거나 옛 receipt를 덮어쓰지 않는다. 모든 커밋을 매번 포함하려고 생성 결과 자신의 commit을 재귀적으로 pin할 필요는 없다.", "",
    ]
    rendered["docs/DEVELOPMENT_LINEAGE.md"] = "\n".join(rows)
    return rendered, inventory


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Compare generated artifacts with the pinned catalog without writing")
    args = parser.parse_args()
    outputs, inventory = build()
    for path, value in outputs.items():
        target = ROOT / path
        if args.check:
            assert target.read_text() == value, f"generated artifact drift: {path}"
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(value)
    print(json.dumps({"mode": "CHECK" if args.check else "BUILD", **inventory["counts"], "sourceCommit": inventory["sourceCommit"]}))
