import { test } from "node:test"
import assert from "node:assert/strict"
import type { UslRecord } from "../src/domain.js"
import { toBundle } from "../src/project.js"
import { validateRecords } from "../src/validation.js"

const record = (over: Partial<UslRecord> = {}): UslRecord => ({
  link_id: "record-validation", semantic_relation: "REFERENCES", from_endpoint_kind: "kg", from_locator: "kg://canonical-neo4j/sym:Concept:usl",
  to_endpoint_kind: "filesystem", to_locator: "file://dev-01/project/readme.md", direction: "directed",
  resolved_at_from: "observed-from", resolved_at_to: "observed-to",
  resolved_locator_from: "kg://canonical-neo4j/sym:Concept:usl", resolved_locator_to: "file://dev-01/project/readme.md",
  pierced_at: "pierced", audited_at: null, drift_detected_at: null, drift_score: 0,
  content_hash_from: "hash-from", content_hash_to: "hash-to", confidence: "EXTRACTED", guarantee_level: "trust_host", status: "RESOLVES",
  provenance_actor: "test", provenance_tool_version: "usl/test", provenance_command: "test", provenance_date: "2026-09-08", hswm_owner_ref: null,
  ...over,
})

const options = { bundle_uid: "bundle:record-validation:v1", title: "record validation", trigger: { user_utterance_verbatim: "project this record", utterance_date: "2026-09-08", tool: "test" }, evidence: [] }

test("incomplete or incoherent RESOLVES records cannot become canonical KG assertions", () => {
  for (const field of ["content_hash_from", "content_hash_to", "resolved_locator_from", "resolved_locator_to", "resolved_at_from", "resolved_at_to"] as const) {
    for (const value of [null, ""] as const) {
      const malformed = { ...record(), [field]: value }
      assert.throws(() => validateRecords([malformed]), /RESOLVES requires non-empty endpoint baselines/, `${field}=${String(value)}`)
      assert.throws(() => toBundle([malformed as UslRecord], options), /RESOLVES requires non-empty endpoint baselines/, `${field}=${String(value)} must not project as canonical`)
    }
  }
  assert.throws(() => validateRecords([record({ resolved_locator_from: "not-a-locator" })]), /resolved locator unknown locator scheme/)
  assert.throws(() => validateRecords([record({ resolved_locator_to: "kg:\/\/canonical-neo4j\/sym:Concept:usl" })]), /resolved locator kind does not match endpoint kind/)
  assert.throws(() => validateRecords([record({ confidence: "INFERRED" })]), /RESOLVES requires EXTRACTED confidence/)
  assert.throws(() => validateRecords([record({ drift_score: 0.5 })]), /RESOLVES requires drift_score 0/)
})

test("non-RESOLVES records retain incomplete-baseline recovery compatibility", () => {
  for (const status of ["DRIFT", "ORPHAN_FROM", "ORPHAN_TO", "AMBIGUOUS"] as const) {
    const incomplete = record({ status, confidence: status === "AMBIGUOUS" ? "AMBIGUOUS" : "INFERRED", drift_score: 1,
      content_hash_from: null, content_hash_to: null, resolved_locator_from: null, resolved_locator_to: null, resolved_at_from: null, resolved_at_to: null })
    assert.deepEqual(validateRecords([incomplete]), [incomplete], `${status} retains recovery information`)
    const properties = toBundle([incomplete], options).nodes[0]!.properties as Record<string, unknown>
    assert.deepEqual([properties.canonical_scope, properties.review_required], ["PENDING_OR_PRELIMINARY", true])
  }
})

test("RESOLVES KG evidence keeps the requested source and UID, while URL redirects and historical drift remain representable", () => {
  for (const field of ["from", "to"] as const) {
    const mismatchedUid = field === "from"
      ? record({ resolved_locator_from: "kg://canonical-neo4j/sym:Concept:other" })
      : record({ to_endpoint_kind: "kg", to_locator: "kg://canonical-neo4j/sym:Concept:target", resolved_locator_to: "kg://canonical-neo4j/sym:Concept:other" })
    assert.throws(() => validateRecords([mismatchedUid]), /must keep the requested source and UID/, `${field} KG UID mismatch`)
    const mismatchedSource = field === "from"
      ? record({ resolved_locator_from: "kg://other-kg/sym:Concept:usl" })
      : record({ to_endpoint_kind: "kg", to_locator: "kg://canonical-neo4j/sym:Concept:target", resolved_locator_to: "kg://other-kg/sym:Concept:target" })
    assert.throws(() => validateRecords([mismatchedSource]), /must keep the requested source and UID/, `${field} KG source mismatch`)
  }
  const redirectedUrl = record({ to_endpoint_kind: "url", to_locator: "https://origin.example.test/start", resolved_locator_to: "https://redirect.example.test/final" })
  assert.deepEqual(validateRecords([redirectedUrl]), [redirectedUrl])
  const historicalMismatch = record({ status: "DRIFT", confidence: "EXTRACTED", drift_score: 0.5, resolved_locator_from: "kg://canonical-neo4j/sym:Concept:other" })
  assert.deepEqual(validateRecords([historicalMismatch]), [historicalMismatch])
})

test("projection uses its validated snapshot when input status is accessor-backed or mutated by an option getter", () => {
  const incomplete = record({ status: "DRIFT", confidence: "INFERRED", drift_score: 1, content_hash_from: null, resolved_locator_from: null, resolved_at_from: null }) as UslRecord & { status: UslRecord["status"] }
  let statusReads = 0
  Object.defineProperty(incomplete, "status", { enumerable: true, get: () => ++statusReads === 1 ? "DRIFT" : "RESOLVES" })
  const accessorProperties = toBundle([incomplete], options).nodes[0]!.properties as Record<string, unknown>
  assert.deepEqual([accessorProperties.status, accessorProperties.canonical_scope, accessorProperties.review_required], ["DRIFT", "PENDING_OR_PRELIMINARY", true])
  assert.ok(statusReads >= 1)

  const mutable = record() as { -readonly [K in keyof UslRecord]: UslRecord[K] }
  const mutationOptions = {
    ...options,
    get bundle_uid() {
      mutable.status = "DRIFT"
      mutable.content_hash_from = null
      return options.bundle_uid
    },
  }
  const mutationProperties = toBundle([mutable], mutationOptions).nodes[0]!.properties as Record<string, unknown>
  assert.deepEqual([mutationProperties.status, mutationProperties.content_hash_from, mutationProperties.canonical_scope, mutationProperties.review_required], ["RESOLVES", "hash-from", "CANONICAL", false])
})
