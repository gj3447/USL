import assert from "node:assert/strict"
import { test } from "node:test"
import { contractDigest } from "../src/contract-core.js"
import {
  discoverCapabilityCatalog,
  parseCapabilityCatalog,
  preflightCapabilityCatalog,
} from "../src/capability-catalog.js"
import type { CapabilityDescriptor, CapabilityPolicy } from "../src/capabilities.js"

const descriptor = (connection = "alpha", id = "read"): CapabilityDescriptor => ({
  schema: "usl-capability/v1", id, version: "1", connection, nativeOperation: id,
  sourceDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  kind: "READ", effect: "READ", meanings: ["urn:test:read"], requiredScopes: ["read"],
  input: { types: ["urn:type:input"], unit: "urn:unit:one", schema: true },
  output: { types: ["urn:type:output"], schema: true },
  mapping: { completeness: "COMPLETE", losses: [], unsupported: [] },
})
const policy = (value: CapabilityDescriptor): CapabilityPolicy => ({
  connection: value.connection, capabilityId: value.id, descriptorDigest: contractDigest(value), sourceDigest: value.sourceDigest,
  allowedEffects: ["READ"], allowedScopes: ["read"], allowLossy: false, maxInputBytes: 4096, maxOutputBytes: 4096, timeoutMs: 1000,
})
const invocation = (value: CapabilityDescriptor) => ({ descriptorDigest: contractDigest(value), sourceDigest: value.sourceDigest,
  input: { types: ["urn:type:input"], unit: "urn:unit:one", value: { sample: true } } })
const catalog = (entries: unknown[], complete = true) => ({ schema: "usl-capability-catalog/v1", complete, entries })

test("catalog snapshots registration and keeps mutations out", () => {
  const first = descriptor()
  const input = catalog([{ descriptor: first, policy: policy(first) }])
  const parsed = parseCapabilityCatalog(input)
  first.id = "mutated"
  ;(input.entries[0] as { descriptor: CapabilityDescriptor }).descriptor.meanings[0] = "urn:test:mutated"
  assert.equal(parsed.entries[0]?.descriptor.id, "read")
  assert.equal(parsed.entries[0]?.descriptor.meanings[0], "urn:test:read")
  assert.throws(() => { (parsed.entries[0]?.descriptor.meanings as string[]).push("urn:test:no") }, TypeError)
})

test("catalog rejects identity collisions and forged owner/source pins", () => {
  const first = descriptor()
  assert.throws(() => parseCapabilityCatalog(catalog([{ descriptor: first }, { descriptor: descriptor() }])), /duplicate/)
  const forgedOwner = policy(first); forgedOwner.capabilityId = "other"
  assert.throws(() => parseCapabilityCatalog(catalog([{ descriptor: first, policy: forgedOwner }])), /owner binding/)
  const stale = policy(first); stale.sourceDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  assert.throws(() => parseCapabilityCatalog(catalog([{ descriptor: first, policy: stale }])), /source pin/)
})

test("catalog discovery remains scoped and never leaks policy", () => {
  const first = descriptor(), second = descriptor("beta", "read")
  const result = discoverCapabilityCatalog(catalog([{ descriptor: first, policy: policy(first) }, { descriptor: second }], false),
    { meaning: "urn:test:read", maxResults: 1, maxInspected: 2 })
  assert.equal(result.status, "FOUND")
  assert.equal(result.coverage.complete, false)
  assert.equal("policy" in result.matches[0]!, false)
  assert.equal(result.matches[0]?.descriptor.connection, "alpha")
  assert.match(result.catalogDigest, /^sha256:/)
})

test("catalog preflight requires an exact registered descriptor and host policy", () => {
  const first = descriptor(), second = descriptor("beta", "read")
  const ready = preflightCapabilityCatalog(catalog([{ descriptor: first, policy: policy(first) }, { descriptor: second }]),
    { connection: "alpha", capability: "read", invocation: invocation(first) })
  assert.equal(ready.status, "READY")
  assert.equal(ready.execution, "NOT_EXECUTED")
  assert.throws(() => preflightCapabilityCatalog(catalog([{ descriptor: first }]),
    { connection: "alpha", capability: "read", invocation: invocation(first) }), /no host policy/)
  assert.throws(() => preflightCapabilityCatalog(catalog([{ descriptor: first, policy: policy(first) }]),
    { connection: "missing", capability: "read", invocation: invocation(first) }), /not registered/)
})

test("catalog validates requests before inspecting registrations", () => {
  const first = descriptor()
  assert.throws(() => discoverCapabilityCatalog({ bad: "catalog" }, { meaning: "not an iri", maxResults: 0, maxInspected: 0 }), /Invalid/)
  assert.throws(() => preflightCapabilityCatalog({ bad: "catalog" }, { connection: "", capability: "", invocation: {} }), /Invalid/)
  assert.throws(() => parseCapabilityCatalog(catalog([{ descriptor: first, policy: { ...policy(first), descriptorDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } }])), /descriptor pin/)
})
