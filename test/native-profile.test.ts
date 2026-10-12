import assert from "node:assert/strict"
import { test } from "node:test"
import {
  checkNativeEvaluations,
  checkNativeRequiredReads,
  createNativeAdmission,
  createNativeEffectReceipt,
  createNativeEvaluatorReceipt,
  createNativeProfileSnapshot,
  createNativeReadReceipt,
  mapNativeCliEffect,
  parseNativeEffectReceipt,
  parseNativeEvaluatorReceipt,
  parseNativeProfileManifest,
  parseNativeProfileSnapshot,
} from "../src/addons/native-profile.js"

const hash = (character: string) => `sha256:${character.repeat(64)}`
const documentDigest = hash("1")
const invocationId = "urn:test:invocation:one"

const manifest = () => ({
  schema: "usl-native-profile/v1",
  id: "urn:test:profile:one",
  ownerNamespace: "urn:test:owner:one",
  workspaceAliases: ["workspaceA"],
  bindings: {
    schema: "usl-resource-bindings/v1",
    resources: [{ id: "policy-doc", representations: [{
      id: "policy_doc", relation: "documentation", kind: "workspace",
      workspace: "workspaceA", path: "policy.json", digest: documentDigest,
    }] }],
  },
  selections: [{ resource: "policy-doc", representation: "policy_doc" }],
  graphDigest: hash("d"),
  policy: { id: "urn:test:policy:one", digest: hash("2") },
  requiredSources: [{
    id: "urn:test:source:one", resource: "policy-doc", representation: "policy_doc",
    // This selects a logical value, but receipt bytes remain the whole backing document.
    selector: { kind: "json-pointer", value: "/rules/0" }, revision: "rev-1", digest: documentDigest, bytes: 37,
  }],
  requiredEvaluators: [{ id: "urn:test:evaluator:one", digest: hash("3") }],
  capabilities: [{ id: "urn:test:action:one", descriptorDigest: hash("4"), scopeDigest: hash("5") }],
})

const snapshot = (generation = 1) => createNativeProfileSnapshot(manifest(), generation, hash("6"))
const receipt = (profile = snapshot()) => createNativeReadReceipt({
  schema: "usl-native-read-receipt/v1", snapshotDigest: profile.digest, invocationId,
  source: profile.manifest.requiredSources[0], deliveredDigest: documentDigest, deliveredBytes: 37,
  coverage: "FULL_BACKING_DOCUMENT", acknowledgedBy: "urn:test:loader:one",
  acknowledgement: "DELIVERY_ACK_ONLY_NOT_COMPREHENSION",
})
const evaluator = (profile = snapshot(), status: "PASS" | "FAIL" | "UNKNOWN" = "PASS") =>
  createNativeEvaluatorReceipt({ schema: "usl-native-evaluator-receipt/v1",
    evaluator: profile.manifest.requiredEvaluators[0], snapshotDigest: profile.digest, invocationId,
    inputDigest: hash("7"), status, evidenceDigest: hash("8") })

test("P01 native profile has a stable canonical digest vector and excludes host roots", () => {
  const raw = manifest(), captured = snapshot()
  assert.equal(captured.manifestDigest, "sha256:6e915d8101d6ec688e4d578042ce45e945a609e4123210f67cc6239e64c52ae8")
  assert.equal(captured.digest, "sha256:55b43a9ccf4b0f295ce79633402ab2b024bce8cec55c9e80c654e9cf5f782203")
  assert.equal(captured.manifest.workspaceAliases[0], "workspaceA")
  assert.equal((captured.manifest as any).workspaceRoots, undefined)
  raw.workspaceAliases[0] = "mutated"
  raw.bindings.resources[0]!.representations[0]!.path = "different.json"
  assert.equal(captured.manifest.workspaceAliases[0], "workspaceA")
  const representation = captured.manifest.bindings.resources[0]!.representations[0]!
  assert.equal(representation.kind, "workspace")
  if (representation.kind === "workspace") assert.equal(representation.path, "policy.json")
  assert.ok(Object.isFrozen(captured.manifest))
})

test("P01 rejects aliases, representations, pins, selectors, and nonportable fields that silently alter identity", () => {
  const cases: Array<(value: any) => void> = [
    value => { value.workspaceAliases.push("workspaceA") },
    value => { value.bindings.resources[0].representations.push({ ...value.bindings.resources[0].representations[0] }) },
    value => { value.selections.push({ resource: "policy-doc", representation: "policy_doc" }) },
    value => { value.requiredSources.push({ ...value.requiredSources[0] }) },
    value => { value.requiredSources[0].digest = hash("9") },
    value => { value.requiredSources[0].selector = { kind: "json-pointer", value: "rules/0" } },
    value => { value.requiredSources[0].selector = { kind: "whole", value: "/forbidden" } },
    value => { value.workspaceRoots = { workspaceA: "/private/root" } },
    value => { value.credential = "forbidden" },
  ]
  for (const mutate of cases) {
    const value = manifest(); mutate(value)
    assert.throws(() => parseNativeProfileManifest(value))
  }
})

test("P01 full backing-document receipt and evaluator coverage hold on missing, extra, stale, partial, or unknown evidence", () => {
  const profile = snapshot(), valid = receipt(profile)
  assert.equal(checkNativeRequiredReads(profile, invocationId, [valid]).status, "PASS")
  assert.equal(checkNativeRequiredReads(profile, invocationId, []).status, "HOLD")
  assert.equal(checkNativeRequiredReads(profile, "urn:test:invocation:other", [valid]).status, "HOLD")
  const { digest: _digest, ...validBody } = valid
  const extra = createNativeReadReceipt({ ...validBody, source: { ...valid.source, id: "urn:test:source:extra" } })
  assert.equal(checkNativeRequiredReads(profile, invocationId, [valid, extra]).status, "HOLD")
  assert.throws(() => createNativeReadReceipt({ ...valid, deliveredBytes: 1 }))
  assert.throws(() => createNativeReadReceipt({ ...valid, deliveredDigest: hash("a") }))
  const pass = evaluator(profile)
  assert.equal(parseNativeEvaluatorReceipt(pass).digest, pass.digest)
  assert.throws(() => parseNativeEvaluatorReceipt({ ...pass, status: "FAIL" }))
  assert.equal(checkNativeEvaluations(profile, invocationId, hash("7"), [pass]).status, "PASS")
  assert.equal(checkNativeEvaluations(profile, invocationId, hash("7"), []).status, "HOLD")
  assert.equal(checkNativeEvaluations(profile, invocationId, hash("7"), [evaluator(profile, "UNKNOWN")]).status, "HOLD")
})

test("P01 admissions bind scope, exact snapshot, and a bounded canonical TTL", () => {
  const profile = snapshot()
  const base = {
    id: "urn:test:admission:one", invocationId, actionId: "urn:test:action:one", scopeDigest: hash("5"),
    inputDigest: hash("7"), observationDigest: hash("8"), deliveryDigest: hash("9"), evaluatorDigest: hash("a"),
    issuedAt: "2026-10-11T00:00:00.000Z", expiresAt: "2026-10-11T00:01:00.000Z",
  }
  const admission = createNativeAdmission(base, profile)
  assert.equal(admission.snapshotDigest, profile.digest)
  assert.throws(() => createNativeAdmission({ ...base, scopeDigest: hash("b") }, profile))
  assert.throws(() => createNativeAdmission({ ...base, expiresAt: base.issuedAt }, profile))
  assert.throws(() => createNativeAdmission({ ...base, expiresAt: "2026-10-11T00:16:00.001Z" }, profile))
  assert.throws(() => createNativeAdmission({ ...base, issuedAt: "2026-10-11T00:00:00Z" }, profile))
})

test("P01 snapshot rollback uses a new generation while retaining manifest identity", () => {
  const first = snapshot(1), rollback = snapshot(2)
  assert.equal(first.manifestDigest, rollback.manifestDigest)
  assert.notEqual(first.digest, rollback.digest)
  assert.throws(() => parseNativeProfileSnapshot({ ...first, generation: 2 }))
})

test("P01 preserves CLI indeterminate as unknown and never represents automatic retry", () => {
  const indeterminate = mapNativeCliEffect({ attemptId: "urn:test:attempt:one", admissionDigest: hash("b"),
    sourceStatus: "INDETERMINATE", sourceReceiptDigest: hash("c"), reason: "timeout" })
  assert.deepEqual([indeterminate.dispatch, indeterminate.outcome, indeterminate.automaticRetry], ["DISPATCHED", "UNKNOWN", false])
  assert.equal(parseNativeEffectReceipt(indeterminate).digest, indeterminate.digest)
  assert.throws(() => createNativeEffectReceipt({ ...indeterminate, automaticRetry: true }))
  assert.throws(() => createNativeEffectReceipt({ ...indeterminate, outcome: "SUCCEEDED" }))
  assert.throws(() => createNativeEffectReceipt({ ...indeterminate, dispatch: "NOT_DISPATCHED", outcome: "SUCCEEDED" }))
})

test("P09 permits an owner-reported unknown dispatch only with an unknown outcome", () => {
  const unknown = createNativeEffectReceipt({ schema: "usl-native-effect-receipt/v1", attemptId: "urn:test:attempt:unknown-dispatch",
    admissionDigest: hash("a"), dispatch: "UNKNOWN", outcome: "UNKNOWN", sourceStatus: "OWNER_REPORTED",
    sourceReceiptDigest: hash("b"), reason: "owner cannot determine whether a process started", automaticRetry: false })
  assert.equal(parseNativeEffectReceipt(unknown).dispatch, "UNKNOWN")
  const { digest: _digest, ...body } = unknown
  assert.throws(() => createNativeEffectReceipt({ ...body, outcome: "FAILED" }), /unknown dispatch must retain an unknown outcome/)
  assert.throws(() => createNativeEffectReceipt({ ...body, outcome: "SUCCEEDED" }), /unknown dispatch must retain an unknown outcome/)
})
