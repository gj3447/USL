import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { createNativeProfileSnapshot } from "../src/addons/native-profile.js"
import { checkNativeDelivery, deliverNativeRequiredSources, revokeNativeDelivery } from "../src/addons/native-delivery.js"

const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`
const text = new TextEncoder(), owner = "urn:example:delivery-owner", invocation = "urn:example:delivery-invocation", sourceId = "urn:example:required-source", loaderId = "urn:example:loader", targetId = "urn:example:target"
const snapshot = (bytes: Uint8Array, selector: { kind: "whole" } | { kind: "json-pointer"; value: string } = { kind: "whole" }) => createNativeProfileSnapshot({
  schema: "usl-native-profile/v1", id: "urn:example:delivery-profile", ownerNamespace: owner, workspaceAliases: ["root"],
  bindings: { schema: "usl-resource-bindings/v1", resources: [{ id: "native:source", representations: [{ id: "local", relation: "working-copy", kind: "workspace", workspace: "root", path: "source.json", digest: digest(bytes) }] }] },
  selections: [{ resource: "native:source", representation: "local" }], graphDigest: digest(text.encode("graph")), policy: { id: "urn:example:policy", digest: digest(text.encode("policy")) },
  requiredSources: [{ id: sourceId, resource: "native:source", representation: "local", selector, revision: "rev-1", digest: digest(bytes), bytes: bytes.length }], requiredEvaluators: [], capabilities: [],
}, 1, digest(text.encode("host")))
const host = (bytes: Uint8Array, changes: Partial<Record<"revision" | "bytes" | "ack" | "read" | "deliver", unknown>> = {}) => ({
  loaderId, targetId, maxBytes: 1024, timeoutMs: 1_000,
  read: async () => { if (changes.read instanceof Error) throw changes.read; return { bytes: changes.bytes instanceof Uint8Array ? changes.bytes : bytes, revision: typeof changes.revision === "string" ? changes.revision : "rev-1" } },
  deliver: async ({ source, snapshotDigest, invocationId, bytes: delivered }: { source: { id: string }; snapshotDigest: string; invocationId: string; bytes: Uint8Array }) => {
    if (changes.deliver instanceof Error) throw changes.deliver
    if (changes.ack !== undefined) return changes.ack
    return { snapshotDigest, invocationId, sourceId: source.id, loaderId, targetId, deliveredDigest: digest(delivered), deliveredBytes: delivered.length }
  },
})

test("ND01 delivers complete pinned source bytes and accepts only the issued opaque handle", async t => {
  const root = await mkdtemp(join("/dev/shm", "usl-native-delivery-")); t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = text.encode('{"document":"full source"}'), path = join(root, "source.json"); await writeFile(path, bytes)
  let delivered: Uint8Array | undefined
  const prepared = await deliverNativeRequiredSources(snapshot(bytes), invocation, {
    ...host(bytes), read: async () => ({ bytes: await readFile(path), revision: "rev-1" }),
    deliver: async request => { delivered = Uint8Array.from(request.bytes); return { snapshotDigest: request.snapshotDigest, invocationId: request.invocationId, sourceId: request.source.id, loaderId, targetId, deliveredDigest: digest(request.bytes), deliveredBytes: request.bytes.length } },
  })
  assert.equal(prepared.report.status, "PASS"); assert.equal(prepared.report.receipts.length, 1)
  assert.deepEqual(delivered, bytes, "selector does not turn delivery into a fragment")
  assert.equal(checkNativeDelivery(prepared, snapshot(bytes), invocation, targetId).status, "PASS")
  assert.equal(checkNativeDelivery(structuredClone(prepared), snapshot(bytes), invocation, targetId).status, "HOLD")
  revokeNativeDelivery(prepared)
  assert.equal(checkNativeDelivery(prepared, snapshot(bytes), invocation, targetId).status, "HOLD")
})

test("ND01 refuses pin/revision/ack mismatches and does not retry callbacks", async () => {
  const bytes = text.encode('{"a":1}'), snap = snapshot(bytes)
  for (const altered of [host(text.encode('{"a":2}')), host(bytes, { revision: "rev-2" }), host(bytes, { ack: { nope: true } })]) {
    const result = await deliverNativeRequiredSources(snap, invocation, altered)
    assert.equal(result.report.status, "HOLD")
    assert.equal(checkNativeDelivery(result, snap, invocation, targetId).status, "HOLD")
  }
})

test("ND01 holds partial or mutable delivery bytes and acknowledgement context drift", async () => {
  const bytes = text.encode('{"a":1}'), snap = snapshot(bytes)
  const partial = await deliverNativeRequiredSources(snap, invocation, host(bytes, { bytes: bytes.subarray(0, 3) }))
  assert.equal(partial.report.status, "HOLD")
  const mutating = { ...host(bytes), deliver: async (request: { bytes: Uint8Array; source: { id: string }; snapshotDigest: string; invocationId: string }) => { request.bytes[0] = 0; return { snapshotDigest: request.snapshotDigest, invocationId: request.invocationId, sourceId: request.source.id, loaderId, targetId, deliveredDigest: digest(bytes), deliveredBytes: bytes.length } } }
  assert.equal((await deliverNativeRequiredSources(snap, invocation, mutating)).report.status, "HOLD")
  const mismatched = await deliverNativeRequiredSources(snap, invocation, host(bytes, { ack: { snapshotDigest: snap.digest, invocationId: invocation, sourceId, loaderId, targetId: "urn:example:wrong-target", deliveredDigest: digest(bytes), deliveredBytes: bytes.length } }))
  assert.equal(mismatched.report.status, "HOLD")
})

test("ND01 captures callbacks and never retries or invokes delivery after budget/timeout", async () => {
  const bytes = text.encode('{"a":1}'), snap = snapshot(bytes)
  let reads = 0, deliveries = 0
  const budget = { ...host(bytes), maxBytes: 1, read: async () => { reads++; return { bytes, revision: "rev-1" } }, deliver: async () => { deliveries++; return {} } }
  assert.equal((await deliverNativeRequiredSources(snap, invocation, budget)).report.status, "HOLD"); assert.equal(reads, 0); assert.equal(deliveries, 0)
  const timeout = { ...host(bytes), timeoutMs: 1, read: async () => { reads++; await new Promise(resolve => setTimeout(resolve, 20)); return { bytes, revision: "rev-1" } }, deliver: async () => { deliveries++; return {} } }
  assert.equal((await deliverNativeRequiredSources(snap, invocation, timeout)).report.status, "HOLD"); assert.equal(deliveries, 0)
  let selected = 0
  const mutable: any = { ...host(bytes), read: async () => { mutable.deliver = async () => { selected++; return {} }; return { bytes, revision: "rev-1" } }, deliver: async (request: { source: { id: string }; snapshotDigest: string; invocationId: string; bytes: Uint8Array }) => ({ snapshotDigest: request.snapshotDigest, invocationId: request.invocationId, sourceId: request.source.id, loaderId, targetId, deliveredDigest: digest(request.bytes), deliveredBytes: request.bytes.length }) }
  assert.equal((await deliverNativeRequiredSources(snap, invocation, mutable)).report.status, "PASS"); assert.equal(selected, 0, "deliver callback was captured before read awaited")
})

test("ND01 validates JSON pointer existence while delivering the complete backing document", async () => {
  const bytes = text.encode('{"nested":{"ok":true},"other":1}'), pointer = snapshot(bytes, { kind: "json-pointer", value: "/nested" })
  const result = await deliverNativeRequiredSources(pointer, invocation, host(bytes))
  assert.equal(result.report.status, "PASS")
  const missing = await deliverNativeRequiredSources(snapshot(bytes, { kind: "json-pointer", value: "/missing" }), invocation, host(bytes))
  assert.equal(missing.report.status, "HOLD")
})

test("ND01 holds stale snapshot, invocation or target handles", async () => {
  const bytes = text.encode('{"a":1}'), first = snapshot(bytes), prepared = await deliverNativeRequiredSources(first, invocation, host(bytes))
  assert.equal(checkNativeDelivery(prepared, snapshot(bytes), "urn:example:other-invocation", targetId).status, "HOLD")
  assert.equal(checkNativeDelivery(prepared, first, invocation, "urn:example:other-target").status, "HOLD")
  assert.equal(checkNativeDelivery(prepared, createNativeProfileSnapshot(first.manifest, 2, first.hostBindingDigest), invocation, targetId).status, "HOLD")
})

test("ND01 holds callback timeouts, exceptions, and declared budget excess", async () => {
  const bytes = text.encode('{"a":1}'), snap = snapshot(bytes)
  const slow = { ...host(bytes), timeoutMs: 1, read: async () => { await new Promise(resolve => setTimeout(resolve, 20)); return { bytes, revision: "rev-1" } } }
  assert.equal((await deliverNativeRequiredSources(snap, invocation, slow)).report.status, "HOLD")
  assert.equal((await deliverNativeRequiredSources(snap, invocation, host(bytes, { read: new Error("offline") }))).report.status, "HOLD")
  assert.equal((await deliverNativeRequiredSources(snap, invocation, { ...host(bytes), maxBytes: 1 })).report.status, "HOLD")
})
