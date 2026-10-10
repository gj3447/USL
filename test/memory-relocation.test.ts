import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { Effect, Either } from "effect"
import { connectUsl } from "../src/adapters.js"
import { MemoryRelocationError, relocateMemoryBinding, type MemoryBindingState, type MemoryRelocationHost, memoryBindingStateDigest, parseMemoryBindingState } from "../src/addons/memory-relocation.js"
import { adaptResourceGraph, parseResourceGraph, resourceGraphJsonLd } from "../src/integrations/resource-graph.js"
import { temporary } from "./fixtures.js"

const OWNER = "urn:example:memory-owner", RESOURCE = "memory:note", REPRESENTATION = "memory-local", REVISION = "urn:example:memory:revision:1"
const digest = (value: Buffer | string) => `sha256:${createHash("sha256").update(value).digest("hex")}`
const content = Buffer.from("a pinned local memory\n", "utf8")
const hasCode = (code: MemoryRelocationError["code"]) => (error: unknown) => error instanceof MemoryRelocationError && error.code === code
const unwrap = <T>(value: Either.Either<T, unknown>): T => Either.getOrThrowWith(value, failure => failure)
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)

const graph = (locator: string) => JSON.stringify({ schema: "usl-resource-graph/v1", resources: [
  { id: RESOURCE, types: ["urn:example:Memory"], locator, metadata: { owner: OWNER } },
  { id: "document:source", types: ["urn:example:Document"], locator: "https://example.test/source" },
], meanings: [{ id: "cites", description: "memory cites source" }], links: [{ id: "memory-source", meaning: "cites", participants: [
  { role: "memory", resource: RESOURCE }, { role: "source", resource: "document:source" },
] }], provenance: { sources: ["document:source"] } })

const stateInput = (locator: string, generation = 0, status: "ACTIVE" | "WITHDRAWN" = "ACTIVE") => ({
  schema: "usl-memory-binding-state/v1",
  cursor: { ownerNamespace: OWNER, resource: RESOURCE, representation: REPRESENTATION, revisionId: REVISION,
    byteDigest: digest(content), byteLength: content.length, generation, status },
  bindings: { schema: "usl-resource-bindings/v1", resources: [{ id: RESOURCE, representations: [{ id: REPRESENTATION,
    kind: "workspace", relation: "snapshot", workspace: "a", path: "memory.md", digest: digest(content) }] }] },
  graph: graph(locator),
})
const state = (locator: string, generation = 0, status: "ACTIVE" | "WITHDRAWN" = "ACTIVE"): MemoryBindingState => parseMemoryBindingState(stateInput(locator, generation, status))

type MutableOwner = { current: MemoryBindingState; casCalls: number; beforeCas?: () => void }
const host = (owner: MutableOwner, roots: Readonly<Record<string, string>>): MemoryRelocationHost => ({
  readState: async () => owner.current,
  compareAndSwap: async (expected, next) => {
    owner.casCalls++
    owner.beforeCas?.()
    if (memoryBindingStateDigest(owner.current) !== expected) return false
    owner.current = next
    return true
  },
  workspaces: roots, hostname: "memory-relocation-test",
})
const event = (expectedStateDigest: string, workspace: string, path = "memory.md", overrides: Record<string, unknown> = {}) => ({
  schema: "usl-memory-relocation/v1", id: "urn:example:memory-event:1", ownerNamespace: OWNER, resource: RESOURCE,
  representation: REPRESENTATION, revisionId: REVISION, expectedStateDigest, destination: { workspace, path }, ...overrides,
})

const context = async (raw: string) => {
  const connection = connectUsl({ read: () => Effect.succeed(raw), adapt: value => adaptResourceGraph(value, { namespace: "memory.relocation.test" }) })
  return Effect.runPromise(connection.context(undefined, { focus: RESOURCE, target: "document:source" }))
}

test("MR01: A→B→C relocates a pinned memory after source removal without changing native graph IDs, roles, or JSON-LD identifiers", async t => {
  const root = await temporary(t), a = join(root, "a"), b = join(root, "b"), c = join(root, "c")
  await Promise.all([mkdir(a), mkdir(b), mkdir(c)])
  await writeFile(join(a, "memory.md"), content)
  const owner: MutableOwner = { current: state(`file://memory-relocation-test${join(a, "memory.md")}`), casCalls: 0 }
  const roots = { a, b, c }, initialGraph = owner.current.graph, initialJsonLd = unwrap(resourceGraphJsonLd(initialGraph, { namespace: "memory.relocation.test" }))
  await writeFile(join(b, "memory.md"), content)
  await rm(join(a, "memory.md"))
  const first = await relocateMemoryBinding(event(memoryBindingStateDigest(owner.current), "b"), host(owner, roots))
  assert.equal(first.receipt.status, "COMMITTED")
  assert.equal(first.receipt.scope, "LOCAL_PINNED_FILE")
  assert.equal(first.receipt.generation, 1)
  assert.equal(first.state.cursor.generation, 1)
  assert.equal(first.state.bindings.resources[0]!.representations[0]!.kind, "workspace")
  assert.deepEqual(await readFile(join(b, "memory.md")), content)
  await writeFile(join(c, "memory.md"), content)
  const second = await relocateMemoryBinding(event(memoryBindingStateDigest(owner.current), "c"), host(owner, roots))
  assert.equal(second.state.cursor.generation, 2)
  assert.equal(owner.casCalls, 2)
  const before = unwrap(parseResourceGraph(initialGraph)), after = unwrap(parseResourceGraph(second.state.graph))
  assert.deepEqual(after.resources.map(resource => resource.id), before.resources.map(resource => resource.id))
  assert.deepEqual(after.meanings, before.meanings)
  assert.deepEqual(after.links, before.links)
  assert.deepEqual(after.provenance, before.provenance)
  const movedMemory = after.resources.find(resource => resource.id === RESOURCE)
  assert.ok(movedMemory)
  assert.equal(movedMemory.locator, `file://memory-relocation-test${join(c, "memory.md")}`)
  const nativeIds = (document: object) => Object.values(document).flatMap(value => Array.isArray(value) ? value : []).flatMap(value => {
    if (!isRecord(value)) return []
    return typeof value["usl:nativeId"] === "string" && typeof value["@id"] === "string" ? [[value["@id"], value["usl:nativeId"]]] : []
  })
  assert.equal(nativeIds(initialJsonLd).length, 4)
  assert.deepEqual(nativeIds(unwrap(resourceGraphJsonLd(second.state.graph, { namespace: "memory.relocation.test" }))), nativeIds(initialJsonLd))
  const result = await context(second.state.graph)
  assert.ok(isRecord(result.result) && isRecord(result.result.target))
  assert.equal(result.result.target.status, "FOUND")
})

test("MR02: rejects stale, duplicate/no-op, identity, owner, revision, alias, unavailable, and different-byte relocation attempts", async t => {
  const root = await temporary(t), a = join(root, "a"), b = join(root, "b")
  await Promise.all([mkdir(a), mkdir(b)])
  await writeFile(join(a, "memory.md"), content)
  const owner: MutableOwner = { current: state(`file://memory-relocation-test${join(a, "memory.md")}`), casCalls: 0 }, roots = { a, b }
  const pin = memoryBindingStateDigest(owner.current)
  await assert.rejects(relocateMemoryBinding(event("sha256:" + "0".repeat(64), "b"), host(owner, roots)), hasCode("STALE"))
  await assert.rejects(relocateMemoryBinding(event(pin, "a"), host(owner, roots)), hasCode("INVALID_INPUT"))
  await assert.rejects(relocateMemoryBinding(event(pin, "b", "memory.md", { ownerNamespace: "urn:other" }), host(owner, roots)), hasCode("IDENTITY_MISMATCH"))
  await assert.rejects(relocateMemoryBinding(event(pin, "b", "memory.md", { revisionId: "urn:wrong" }), host(owner, roots)), hasCode("IDENTITY_MISMATCH"))
  await assert.rejects(relocateMemoryBinding(event(pin, "missing"), host(owner, roots)), hasCode("UNAVAILABLE"))
  await assert.rejects(relocateMemoryBinding(event(pin, "b"), host(owner, roots)), hasCode("UNAVAILABLE"))
  await writeFile(join(b, "memory.md"), "different bytes")
  await assert.rejects(relocateMemoryBinding(event(pin, "b"), host(owner, roots)), hasCode("CONTENT_MISMATCH"))
  assert.equal(owner.casCalls, 0)
})

test("MR03: a withdrawn or concurrently changed owner state cannot be committed by a relocation CAS", async t => {
  const root = await temporary(t), a = join(root, "a"), b = join(root, "b"), c = join(root, "c")
  await Promise.all([mkdir(a), mkdir(b), mkdir(c)])
  await Promise.all([writeFile(join(a, "memory.md"), content), writeFile(join(b, "memory.md"), content), writeFile(join(c, "memory.md"), content)])
  const owner: MutableOwner = { current: state(`file://memory-relocation-test${join(a, "memory.md")}`), casCalls: 0 }, roots = { a, b, c }
  const expected = memoryBindingStateDigest(owner.current)
  const [one, two] = await Promise.allSettled([
    relocateMemoryBinding(event(expected, "b"), host(owner, roots)),
    relocateMemoryBinding(event(expected, "c"), host(owner, roots)),
  ])
  assert.equal([one, two].filter(result => result.status === "fulfilled").length, 1)
  assert.equal([one, two].filter(result => result.status === "rejected").length, 1)
  const withdrawing: MutableOwner = { current: state(`file://memory-relocation-test${join(a, "memory.md")}`), casCalls: 0 }
  await writeFile(join(b, "withdraw.md"), content)
  withdrawing.beforeCas = () => { withdrawing.current = state(`file://memory-relocation-test${join(a, "memory.md")}`, 1, "WITHDRAWN") }
  await assert.rejects(relocateMemoryBinding(event(memoryBindingStateDigest(withdrawing.current), "b", "withdraw.md"), host(withdrawing, roots)), hasCode("CONFLICT"))
})

test("MR04: input mutation during the first owner await cannot retarget an accepted relocation", async t => {
  const root = await temporary(t), a = join(root, "a"), b = join(root, "b"), c = join(root, "c")
  await Promise.all([mkdir(a), mkdir(b), mkdir(c)])
  await Promise.all([writeFile(join(a, "memory.md"), content), writeFile(join(b, "memory.md"), content), writeFile(join(c, "memory.md"), content)])
  const owner: MutableOwner = { current: state(`file://memory-relocation-test${join(a, "memory.md")}`), casCalls: 0 }
  let release!: () => void
  const firstRead = new Promise<void>(resolve => { release = resolve })
  const guarded: MemoryRelocationHost = { ...host(owner, { a, b, c }), readState: async () => { await firstRead; return owner.current } }
  const request = event(memoryBindingStateDigest(owner.current), "b")
  const pending = relocateMemoryBinding(request, guarded)
  request.ownerNamespace = "urn:attacker"
  request.destination.workspace = "c"
  request.destination.path = "changed.md"
  release()
  const result = await pending
  assert.equal(result.receipt.destination.workspace, "b")
  assert.equal(result.state.bindings.resources[0]!.representations[0]!.kind === "workspace" && result.state.bindings.resources[0]!.representations[0]!.workspace, "b")
})

test("MR05: malformed independent pins and unselected destination collisions fail before owner CAS", async t => {
  const root = await temporary(t), a = join(root, "a"), b = join(root, "b")
  await Promise.all([mkdir(a), mkdir(b)])
  await Promise.all([writeFile(join(a, "memory.md"), content), writeFile(join(b, "memory.md"), content)])
  const malformed = stateInput(`file://memory-relocation-test${join(a, "memory.md")}`)
  const malformedRepresentation = malformed.bindings.resources[0]?.representations[0]
  assert.ok(malformedRepresentation)
  malformedRepresentation.digest = `sha256:${"0".repeat(64)}`
  assert.throws(() => parseMemoryBindingState(malformed), /independent byte pin/i)
  const colliding = stateInput(`file://memory-relocation-test${join(a, "memory.md")}`)
  const collidingResource = colliding.bindings.resources[0]
  assert.ok(collidingResource)
  collidingResource.representations.push({ id: "other-local", kind: "workspace", relation: "snapshot", workspace: "b", path: "memory.md", digest: digest(content) })
  const owner: MutableOwner = { current: parseMemoryBindingState(colliding), casCalls: 0 }
  await assert.rejects(relocateMemoryBinding(event(memoryBindingStateDigest(owner.current), "b"), host(owner, { a, b })), hasCode("CONFLICT"))
  assert.equal(owner.casCalls, 0)
})

test("MR06: withdrawn state, symlink paths, and a byte budget boundary are refused or accepted before CAS as specified", async t => {
  const root = await temporary(t), a = join(root, "a"), b = join(root, "b"), outside = join(root, "outside")
  await Promise.all([mkdir(a), mkdir(b), mkdir(outside)])
  await Promise.all([writeFile(join(a, "memory.md"), content), writeFile(join(outside, "memory.md"), content)])
  const withdrawn: MutableOwner = { current: state(`file://memory-relocation-test${join(a, "memory.md")}`, 0, "WITHDRAWN"), casCalls: 0 }
  await assert.rejects(relocateMemoryBinding(event(memoryBindingStateDigest(withdrawn.current), "b"), host(withdrawn, { a, b })), hasCode("WITHDRAWN"))
  assert.equal(withdrawn.casCalls, 0)
  try { await symlink(join(outside, "memory.md"), join(b, "memory.md")) } catch { t.skip("symlink unsupported by this platform") ; return }
  const owner: MutableOwner = { current: state(`file://memory-relocation-test${join(a, "memory.md")}`), casCalls: 0 }
  await assert.rejects(relocateMemoryBinding(event(memoryBindingStateDigest(owner.current), "b"), host(owner, { a, b })), hasCode("UNAVAILABLE"))
  await rm(join(b, "memory.md")); await symlink(outside, join(b, "linked-parent"))
  await assert.rejects(relocateMemoryBinding(event(memoryBindingStateDigest(owner.current), "b", "linked-parent/memory.md"), host(owner, { a, b })), hasCode("UNAVAILABLE"))
  await rm(join(b, "linked-parent")); await writeFile(join(b, "memory.md"), content)
  await relocateMemoryBinding(event(memoryBindingStateDigest(owner.current), "b"), { ...host(owner, { a, b }), maxBytes: content.length })
  const tooSmall: MutableOwner = { current: state(`file://memory-relocation-test${join(a, "memory.md")}`), casCalls: 0 }
  await assert.rejects(relocateMemoryBinding(event(memoryBindingStateDigest(tooSmall.current), "b"), { ...host(tooSmall, { a, b }), maxBytes: content.length - 1 }), hasCode("INVALID_INPUT"))
  assert.equal(tooSmall.casCalls, 0)
})

test("MR07: a throwing owner CAS is commit-unknown, performs no retry, and leaves the original event stale", async t => {
  const root = await temporary(t), a = join(root, "a"), b = join(root, "b")
  await Promise.all([mkdir(a), mkdir(b)])
  await Promise.all([writeFile(join(a, "memory.md"), content), writeFile(join(b, "memory.md"), content)])
  const owner: MutableOwner = { current: state(`file://memory-relocation-test${join(a, "memory.md")}`), casCalls: 0 }, expected = memoryBindingStateDigest(owner.current)
  const uncertain: MemoryRelocationHost = { ...host(owner, { a, b }), compareAndSwap: async (_expected, next) => { owner.casCalls++; owner.current = next; throw new Error("transport disconnected") } }
  await assert.rejects(relocateMemoryBinding(event(expected, "b"), uncertain), hasCode("COMMIT_UNKNOWN"))
  assert.equal(owner.casCalls, 1)
  await assert.rejects(relocateMemoryBinding(event(expected, "b"), host(owner, { a, b })), hasCode("STALE"))
  assert.equal(owner.casCalls, 1)
})
