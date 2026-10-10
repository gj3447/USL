/** Read-only adapter probes: existing bytes + in-memory owner CAS, no temporary files. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { Effect, Either } from "effect"
import { connectUsl } from "../src/adapters.js"
import { adaptResourceGraph, parseResourceGraph, resourceGraphJsonLd } from "../src/integrations/resource-graph.js"
import { MemoryRelocationError, memoryBindingStateDigest, parseMemoryBindingState, relocateMemoryBinding,
  type MemoryBindingState, type MemoryRelocationHost } from "../src/addons/memory-relocation.js"

const root = fileURLToPath(new URL("../", import.meta.url))
const path = "examples/fixtures/resource-graph.json"
const bytes = await readFile(new URL(`../${path}`, import.meta.url))
const byteDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`
const originalGraph = JSON.stringify({ schema: "usl-resource-graph/v1", resources: [
  { id: "memory", types: ["urn:example:Memory"], locator: "https://example.test/old-memory", metadata: { revision: "v1" } },
  { id: "source", types: ["urn:example:Source"], locator: "https://example.test/source" },
], meanings: [{ id: "cites", description: "memory cites source" }], links: [
  { id: "citation", meaning: "cites", participants: [{ role: "memory", resource: "memory" }, { role: "source", resource: "source" }] },
], provenance: { sources: ["source"] } })
const initial = (): MemoryBindingState => parseMemoryBindingState({
  schema: "usl-memory-binding-state/v1", cursor: {
    ownerNamespace: "urn:example:owner", resource: "memory", representation: "local", revisionId: "v1",
    byteDigest, byteLength: bytes.byteLength, generation: 0, status: "ACTIVE",
  }, bindings: { schema: "usl-resource-bindings/v1", resources: [{ id: "memory", representations: [
    { id: "local", relation: "snapshot", kind: "workspace", workspace: "previous", path: "memory.json", digest: byteDigest },
  ] }] }, graph: originalGraph,
})
const fixture = () => {
  let current = initial(), commits = 0
  const host: MemoryRelocationHost = {
    workspaces: { destination: root }, hostname: "readonly-probe",
    readState: async () => current,
    compareAndSwap: async (expected, next) => {
      commits++
      if (memoryBindingStateDigest(current) !== expected) return false
      current = next
      return true
    },
  }
  return { host, current: () => current, commits: () => commits }
}
const event = (state: MemoryBindingState) => ({
  schema: "usl-memory-relocation/v1", id: "urn:example:event", ownerNamespace: state.cursor.ownerNamespace,
  resource: state.cursor.resource, representation: state.cursor.representation, revisionId: state.cursor.revisionId,
  expectedStateDigest: memoryBindingStateDigest(state), destination: { workspace: "destination", path },
})
const hasCode = (code: MemoryRelocationError["code"]) => (error: unknown) => error instanceof MemoryRelocationError && error.code === code
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)

test("memory read-only: existing destination validates, preserves semantic identities and remains reachable", async () => {
  const f = fixture(), result = await relocateMemoryBinding(event(f.current()), f.host)
  assert.equal(f.commits(), 1)
  assert.equal(result.state.cursor.generation, 1)
  assert.deepEqual(result.receipt.content, { digest: byteDigest, bytes: bytes.byteLength })
  assert.equal(result.receipt.sourceStatus, "NOT_OBSERVED")
  const before = Either.getOrThrow(parseResourceGraph(originalGraph)), after = Either.getOrThrow(parseResourceGraph(result.state.graph))
  assert.deepEqual(after.links, before.links)
  assert.deepEqual(after.meanings, before.meanings)
  assert.deepEqual(after.provenance, before.provenance)
  const ids = (raw: string) => Object.values(Either.getOrThrow(resourceGraphJsonLd(raw, { namespace: "memory.readonly" })))
    .flatMap(value => Array.isArray(value) ? value : []).filter(value => record(value) && typeof value["usl:nativeId"] === "string")
    .map(value => [value["@id"], value["usl:nativeId"]])
  assert.equal(ids(originalGraph).length, 4)
  assert.deepEqual(ids(originalGraph), ids(result.state.graph))
  const connection = connectUsl({ read: () => Effect.succeed(result.state.graph), adapt: raw => adaptResourceGraph(raw, { namespace: "memory.readonly" }) })
  const envelope = await Effect.runPromise(connection.context(undefined, { focus: "source", target: "memory" }))
  assert.ok(record(envelope.result) && record(envelope.result.target))
  assert.equal(envelope.result.target.status, "FOUND")
})

test("memory read-only: completed event is stale and cannot be committed twice", async () => {
  const f = fixture(), request = event(f.current())
  await relocateMemoryBinding(request, f.host)
  await assert.rejects(relocateMemoryBinding(request, f.host), hasCode("STALE"))
  assert.equal(f.commits(), 1)
})

test("memory read-only: owner/revision mismatch, withdrawn state and insufficient byte budget do not write", async () => {
  const f = fixture(), request = event(f.current())
  await assert.rejects(relocateMemoryBinding({ ...request, ownerNamespace: "urn:example:other" }, f.host), hasCode("IDENTITY_MISMATCH"))
  await assert.rejects(relocateMemoryBinding({ ...request, revisionId: "v2" }, f.host), hasCode("IDENTITY_MISMATCH"))
  await assert.rejects(relocateMemoryBinding(request, { ...f.host, maxBytes: bytes.byteLength - 1 }), hasCode("INVALID_INPUT"))
  const withdrawn = parseMemoryBindingState({ ...f.current(), cursor: { ...f.current().cursor, status: "WITHDRAWN" } })
  await assert.rejects(relocateMemoryBinding(event(withdrawn), { ...f.host, readState: async () => withdrawn }), hasCode("WITHDRAWN"))
  assert.equal(f.commits(), 0)
})

test("memory read-only: different bytes, an unregistered alias and path traversal cannot update owner state", async () => {
  const f = fixture(), request = event(f.current())
  await assert.rejects(relocateMemoryBinding({ ...request, destination: { workspace: "destination", path: "package.json" } }, f.host), hasCode("CONTENT_MISMATCH"))
  await assert.rejects(relocateMemoryBinding({ ...request, destination: { workspace: "unknown", path } }, f.host), hasCode("UNAVAILABLE"))
  await assert.rejects(relocateMemoryBinding({ ...request, destination: { workspace: "destination", path: "../package.json" } }, f.host), hasCode("INVALID_INPUT"))
  assert.equal(f.commits(), 0)
})

test("memory read-only: two concurrent requests share a state pin and exactly one CAS wins", async () => {
  const f = fixture(), request = event(f.current())
  const results = await Promise.allSettled([relocateMemoryBinding(request, f.host), relocateMemoryBinding({ ...request, id: "urn:example:other-event" }, f.host)])
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
  const rejected = results.find(result => result.status === "rejected")
  assert.ok(rejected?.status === "rejected" && hasCode("CONFLICT")(rejected.reason))
  assert.equal(f.current().cursor.generation, 1)
})

test("memory read-only: uncertain CAS is not retried; stored result is reconciled by its state digest", async () => {
  const f = fixture(), request = event(f.current())
  let saved: MemoryBindingState | undefined, calls = 0
  await assert.rejects(relocateMemoryBinding(request, { ...f.host, compareAndSwap: async (_expected, next) => {
    saved = next; calls++; throw new Error("response lost")
  } }), hasCode("COMMIT_UNKNOWN"))
  assert.ok(saved)
  const restored = saved
  await assert.rejects(relocateMemoryBinding(request, { ...f.host, readState: async () => restored }), hasCode("STALE"))
  assert.equal(calls, 1)
})
