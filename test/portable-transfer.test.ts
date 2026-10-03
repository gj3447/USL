import assert from "node:assert/strict"
import { test } from "node:test"
import { checkPortableTransferManifest, createPortableTransferEnvelope, parsePortableTransferEnvelope, parsePortableTransferManifest } from "../src/addons/portable-transfer.js"
import { contractDigest } from "../src/contract-core.js"

const owner = "urn:example:owner", digest = `sha256:${"a".repeat(64)}`
const identity = (nativeId: string) => ({ ownerNamespace: owner, nativeId })
const manifest = () => ({
  schema: "usl-portable-transfer/v1", ownerNamespace: owner, issuer: "urn:example:issuer:alice", observedAt: "2026-10-03T00:00:00Z",
  resources: [identity("document a"), identity("document-b")],
  revisions: [
    { id: "urn:example:revision:a1", resource: identity("document a"), kind: "CONTENT", parents: [], issuer: "urn:example:issuer:alice" },
    { id: "urn:example:revision:b1", resource: identity("document-b"), kind: "CONTENT", parents: [], issuer: "urn:example:issuer:alice" },
    { id: "urn:example:revision:a2", resource: identity("document a"), kind: "TOMBSTONE", parents: ["urn:example:revision:a1"], issuer: "urn:example:issuer:alice" },
  ],
  representations: [
    { id: "urn:example:representation:a1", revision: "urn:example:revision:a1", payloadPath: "payload/document-a.txt", byteDigestAlgorithm: "SHA256_RAW_BYTES_V1", byteDigest: digest, byteLength: 4 },
    { id: "urn:example:representation:b1", revision: "urn:example:revision:b1", payloadPath: "payload/document-b.txt", byteDigestAlgorithm: "SHA256_RAW_BYTES_V1", byteDigest: digest, byteLength: 4 },
  ],
  historyBoundary: { mode: "CLOSED_V1", externalParents: [] },
})

test("manifest preserves owner-scoped identities despite equal raw-byte hashes", () => {
  const parsed = parsePortableTransferManifest(manifest())
  assert.equal(parsed.resources.length, 2)
  assert.equal(parsed.representations[0]!.byteDigest, parsed.representations[1]!.byteDigest)
  assert.notEqual(parsed.revisions[0]!.resource, parsed.revisions[1]!.resource)
  assert.notDeepEqual(parsed.revisions[0]!.resource, parsed.revisions[1]!.resource)
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.resources))
  const envelope = createPortableTransferEnvelope(parsed)
  assert.equal(envelope.manifestDigest, contractDigest(parsed))
  assert.equal(parsePortableTransferEnvelope(envelope).manifestDigest, envelope.manifestDigest)
  const other: any = manifest(), otherOwner = "urn:other:owner"
  other.ownerNamespace = otherOwner
  for (const resource of other.resources) resource.ownerNamespace = otherOwner
  for (const revision of other.revisions) revision.resource.ownerNamespace = otherOwner
  assert.equal(parsePortableTransferManifest(other).representations[0]!.byteDigest, parsed.representations[0]!.byteDigest)
})

test("explicit fork alone permits a cross-resource parent and boundary pins close omitted history", () => {
  const value: any = manifest()
  value.resources[1]!.derivedFrom = identity("document a")
  value.revisions[1]!.parents = ["urn:example:revision:a1"]
  parsePortableTransferManifest(value)
  const boundary: any = manifest()
  boundary.revisions[0]!.parents = ["urn:example:revision:before"]
  boundary.historyBoundary.externalParents.push({ revision: "urn:example:revision:before", resource: identity("document a"), digestAlgorithm: "USL_CONTRACT_SHA256_V1", digest })
  parsePortableTransferManifest(boundary)
})

test("identity, revision DAG, tombstone, and closed-boundary violations are refused", () => {
  const mutations = [
    (value: any) => value.resources.push(value.resources[0]),
    (value: any) => { value.revisions[0].parents = ["urn:example:revision:missing"] },
    (value: any) => { value.revisions[0].parents = ["urn:example:revision:a2"] },
    (value: any) => { value.revisions[1].parents = ["urn:example:revision:a1"] },
    (value: any) => value.representations.push({ ...value.representations[0], id: "urn:example:representation:tomb", revision: "urn:example:revision:a2", payloadPath: "payload/tomb.txt" }),
  ]
  for (const mutate of mutations) { const value = manifest(); mutate(value); assert.throws(() => parsePortableTransferManifest(value)) }
})

test("portable ASCII paths reject traversal, Windows aliases, collisions, and unknown fields", () => {
  for (const path of ["../secret", "/absolute", "C:\\drive", "payload/CON.txt", "payload/COM1.log", "payload/a/../b", "payload/a?.txt", "payload/é.txt"]) {
    const value = manifest(); value.representations[0]!.payloadPath = path; assert.throws(() => parsePortableTransferManifest(value))
  }
  const collision = manifest(); collision.representations[1]!.payloadPath = "PAYLOAD/DOCUMENT-A.TXT"; assert.throws(() => parsePortableTransferManifest(collision))
  const prefix = manifest(); prefix.representations[1]!.payloadPath = "payload/document-a.txt/child"; assert.throws(() => parsePortableTransferManifest(prefix))
  const unknown = manifest() as any; unknown.unrecognized = true; assert.throws(() => parsePortableTransferManifest(unknown))
})

test("unknown dialects, duplicate IDs, invalid declared time, and boundary identity mismatch are refused", () => {
  const mutations = [
    (value: any) => { value.schema = "usl-portable-transfer/v2" },
    (value: any) => { value.representations[0].byteDigestAlgorithm = "SHA1" },
    (value: any) => value.revisions.push(value.revisions[0]),
    (value: any) => value.representations.push({ ...value.representations[0], payloadPath: "payload/other.txt" }),
    (value: any) => { value.observedAt = "not-a-time" },
    (value: any) => { value.representations[0].id = value.revisions[0].id },
    (value: any) => { value.revisions[0].parents = ["urn:example:revision:before"]; value.historyBoundary.externalParents.push({ revision: "urn:example:revision:before", resource: identity("document-b"), digestAlgorithm: "USL_CONTRACT_SHA256_V1", digest }) },
    (value: any) => { value.revisions[2].parents = ["urn:example:revision:b1"] },
    (value: any) => { value.revisions[2].parents = [] },
    (value: any) => { value.resources[0].derivedFrom = identity("document a") },
    (value: any) => { value.resources[0].derivedFrom = identity("document-b"); value.resources[1].derivedFrom = identity("document a") },
    (value: any) => value.historyBoundary.externalParents.push({ revision: "urn:example:revision:orphan", resource: identity("document a"), digestAlgorithm: "USL_CONTRACT_SHA256_V1", digest }),
  ]
  for (const mutate of mutations) { const value: any = manifest(); mutate(value); assert.throws(() => parsePortableTransferManifest(value)) }
})

test("a declared bundle-relative location can relocate without changing identity or content pin", () => {
  const first = parsePortableTransferManifest(manifest())
  const relocated: any = manifest(); relocated.representations[0].payloadPath = "bundle-v2/a/document-a.txt"
  const second = parsePortableTransferManifest(relocated)
  assert.deepEqual(second.revisions[0]!.resource, first.revisions[0]!.resource)
  assert.equal(second.representations[0]!.byteDigest, first.representations[0]!.byteDigest)
  assert.notEqual(second.representations[0]!.payloadPath, first.representations[0]!.payloadPath)
  assert.throws(() => { (second.resources[0] as any).nativeId = "changed" })
})

test("a valid revision diamond is accepted and declared observation time never selects a latest revision", () => {
  const value: any = manifest()
  for (const id of ["a2-content", "a3-content", "a4-content"]) value.revisions.push({ id: `urn:example:revision:${id}`, resource: identity("document a"), kind: "CONTENT", parents: [], issuer: "urn:example:issuer:alice" })
  value.revisions.at(-3).parents = ["urn:example:revision:a1"]
  value.revisions.at(-2).parents = ["urn:example:revision:a1"]
  value.revisions.at(-1).parents = ["urn:example:revision:a2-content", "urn:example:revision:a3-content"]
  for (const id of ["a2-content", "a3-content", "a4-content"]) value.representations.push({ id: `urn:example:representation:${id}`, revision: `urn:example:revision:${id}`, payloadPath: `payload/${id}.txt`, byteDigestAlgorithm: "SHA256_RAW_BYTES_V1", byteDigest: digest, byteLength: 4 })
  const parsed = parsePortableTransferManifest(value)
  assert.equal(parsed.revisions.length, 6)
  const envelope = createPortableTransferEnvelope({ ...value, observedAt: "2099-01-01T00:00:00Z" })
  assert.equal(checkPortableTransferManifest(envelope, { expectedManifestDigest: envelope.manifestDigest, allowedOwnerNamespace: owner }).freshness, "UNKNOWN")
})

test("host check is manifest-only and rejects mismatched policy pins", () => {
  const envelope = createPortableTransferEnvelope(manifest())
  const result = checkPortableTransferManifest(envelope, { expectedManifestDigest: envelope.manifestDigest, allowedOwnerNamespace: owner })
  assert.deepEqual(result, { manifestDigest: envelope.manifestDigest, ownerNamespace: owner, manifest: "CHECKED", payload: "NOT_CHECKED", freshness: "UNKNOWN", authority: "NOT_GRANTED", execution: "NOT_REQUESTED" })
  assert.throws(() => checkPortableTransferManifest(envelope, { expectedManifestDigest: digest, allowedOwnerNamespace: owner }))
  assert.throws(() => checkPortableTransferManifest(envelope, { expectedManifestDigest: envelope.manifestDigest, allowedOwnerNamespace: "urn:other:owner" }))
})

test("manifest input is bounded and envelope digests cannot be reconstructed after tampering", () => {
  const value = manifest() as any; value.issuer = "x".repeat(2 * 1024 * 1024 + 1)
  assert.throws(() => parsePortableTransferManifest(value), /byte budget/)
  const envelope = structuredClone(createPortableTransferEnvelope(manifest())) as any
  envelope.manifest.issuer = "urn:example:issuer:rewritten"
  assert.throws(() => parsePortableTransferEnvelope(envelope), /manifest digest mismatch/)
  const wrongAlgorithm = structuredClone(createPortableTransferEnvelope(manifest())) as any
  wrongAlgorithm.bodyDigestAlgorithm = "SHA256_RAW_BYTES_V1"
  assert.throws(() => parsePortableTransferEnvelope(wrongAlgorithm))
})

test("a lexically intervening filename cannot conceal a file/directory collision", () => {
  const value = manifest()
  value.representations[0]!.payloadPath = "payload/a"
  value.representations[1]!.payloadPath = "payload/a-b"
  value.representations.push({ ...value.representations[1]!, id: "urn:example:representation:child", payloadPath: "payload/a/child" })
  assert.throws(() => parsePortableTransferManifest(value), /file\/directory path collision/)
})

test("parsing snapshots source data before later source mutation", () => {
  const source: any = manifest(), parsed = parsePortableTransferManifest(source)
  source.resources[0].nativeId = "rewritten"
  source.representations[0].payloadPath = "payload/rewritten.txt"
  assert.equal(parsed.resources[0]!.nativeId, "document a")
  assert.equal(parsed.representations[0]!.payloadPath, "payload/document-a.txt")
})

test("a manifest at its byte limit still round-trips inside its envelope", () => {
  const value = manifest()
  for (let index = value.revisions.length; index < 4096; index++) value.revisions.push({
    id: `urn:example:revision:boundary-${index}`, resource: identity("document a"), kind: "TOMBSTONE",
    parents: ["urn:example:revision:a1"], issuer: "urn:example:issuer:alice",
  })
  let remaining = 2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(value))
  assert.ok(remaining > 0)
  for (const revision of value.revisions) {
    const count = Math.min(512 - revision.issuer.length, remaining)
    revision.issuer += "a".repeat(count)
    remaining -= count
  }
  assert.equal(remaining, 0)
  const envelope = createPortableTransferEnvelope(value)
  assert.equal(parsePortableTransferEnvelope(envelope).manifestDigest, envelope.manifestDigest)
})
