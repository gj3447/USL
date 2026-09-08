import { test } from "node:test"
import assert from "node:assert/strict"
import type { UslRecord } from "../src/domain.js"
import { recordUid, toBundle } from "../src/project.js"

const rec = (over: Partial<UslRecord>): UslRecord => ({
  link_id: "l1", semantic_relation: "DOCUMENTED_IN", from_endpoint_kind: "kg", from_locator: "kg://canonical-neo4j/sym:Concept:usl", to_endpoint_kind: "filesystem", to_locator: "file://dev-01/x/y.md",
  direction: "directed", resolved_at_from: "t", resolved_at_to: "t", resolved_locator_from: "kg://canonical-neo4j/sym:Concept:usl", resolved_locator_to: "file://dev-01/x/y.md", pierced_at: "t", drift_detected_at: null, drift_score: 0,
  content_hash_from: "a", content_hash_to: "b", confidence: "EXTRACTED", guarantee_level: "trust_host", status: "RESOLVES", provenance_actor: "test", provenance_tool_version: "usl/0.1.0", provenance_command: "c", provenance_date: "2026-09-07", hswm_owner_ref: null, ...over,
})
test("projection emits registry-safe shapes: ≤4 labels, flat properties, kg anchors, typed relations", () => {
  const b = toBundle([rec({}), rec({ link_id: "l2", to_endpoint_kind: "url", to_locator: "https://example.org/a", resolved_locator_to: "https://example.org/a" })], { bundle_uid: "bundle:test:2026-09-07:v1", title: "t", trigger: { user_utterance_verbatim: "u", utterance_date: "2026-09-07", tool: "t" }, evidence: ["e"], endAnchors: { l1: { to: "sym:SourceDocument:doc" }, l2: { to: "sym:Concept:url" } } })
  assert.equal(b.nodes.length, 2)
  for (const n of b.nodes as Array<{ labels: string[]; properties: Record<string, unknown> }>) {
    assert.ok(n.labels.length <= 4)
    for (const [k, v] of Object.entries(n.properties)) assert.ok(v === null || ["string", "number", "boolean"].includes(typeof v) || Array.isArray(v), `nested value at ${k}`)
  }
  assert.ok(b.anchors.includes("sym:Concept:usl") && b.anchors.includes("sym:SourceDocument:doc") && b.anchors.includes("sym:Concept:url"))
  const types = new Set((b.relations as Array<{ type: string }>).map((r) => r.type))
  assert.deepEqual([...types].sort(), ["BOUND_TO_EXTERNAL_CITATION", "INSTANCE_OF", "LONGINUS_BINDS", "MATERIALIZES_AS_FILE"])
  assert.equal(recordUid(rec({ link_id: "USL doc ↔ KG" })), "sym:Longinus:usl-link-usl-doc-kg")
})

const options = { bundle_uid: "bundle:test:v1", title: "test", trigger: { user_utterance_verbatim: "user request", utterance_date: "2026-09-07", tool: "test" }, evidence: [] }
test("projection rejects malformed/mismatched locators and UID collisions", () => {
  assert.throws(() => toBundle([rec({ from_locator: "https://example.org" })], options), /kind/)
  assert.throws(() => toBundle([rec({ from_locator: "bad" })], options), /scheme/)
  assert.throws(() => toBundle([rec({ link_id: "a b" }), rec({ link_id: "a-b" })], options), /colliding/)
  assert.throws(() => toBundle([rec({ link_id: "!!!" })], options), /empty/)
  assert.throws(() => toBundle([rec({}), rec({})], options), /duplicate/)
})
test("projection requires explicit mapping for a different KG source", () => {
  assert.throws(() => toBundle([rec({})], { ...options, endAnchors: { l1: { from: "sym:Other" } } }), /cannot remap/)
  assert.throws(() => toBundle([rec({})], { ...options, endAnchors: { l1: { to: " sym:Other " } } }), /invalid/)
  const record = rec({ from_locator: "kg://other/sym:Concept:usl", resolved_locator_from: "kg://other/sym:Concept:usl" })
  assert.throws(() => toBundle([record], options), /explicit anchor/)
  const bundle = toBundle([record], { ...options, endAnchors: { l1: { from: "sym:ExternalRecord:other-usl" } } })
  assert.ok(bundle.anchors.includes("sym:ExternalRecord:other-usl"))
  assert.ok(bundle.relations.some((r) => r.to_uid === "sym:ExternalRecord:other-usl"))
})
test("KG 등급은 레코드 status 에서 파생된다 — 해석 실패를 CANONICAL 로 앉히지 않는다 (감사 D23)", () => {
  const grade = (status: UslRecord["status"]) => {
    const p = toBundle([rec({ status })], options).nodes[0]!.properties as Record<string, unknown>
    return [p.canonical_scope, p.review_required, p.status]
  }
  assert.deepEqual(grade("RESOLVES"), ["CANONICAL", false, "RESOLVES"])
  for (const s of ["DRIFT", "ORPHAN_FROM", "ORPHAN_TO", "AMBIGUOUS"] as const) {
    assert.deepEqual(grade(s), ["PENDING_OR_PRELIMINARY", true, s], `${s} must not be CANONICAL`)
  }
})
test("도구 버전 표기는 레코드 provenance 에서 오지 실행 중 바이너리에서 오지 않는다 (감사 F5)", () => {
  const b = toBundle([rec({ provenance_tool_version: "usl/0.1.0", status: "DRIFT" })], options)
  const p = b.nodes[0]!.properties as Record<string, unknown>
  assert.match(String(p.description), /^usl\/0\.1\.0 링크 레코드\(DRIFT\)\./)
  const inst = b.relations.find((r) => r.type === "INSTANCE_OF")!
  assert.equal((inst.properties as Record<string, unknown>).basis, "usl/0.1.0 pierce()")
})
