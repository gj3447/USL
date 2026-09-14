import { test } from "node:test"
import assert from "node:assert/strict"
import { Effect, Either } from "effect"
import { adapterResult, connectUsl, type HswmAuthority } from "../src/adapters.js"
import { DEFAULT_USL_POLICY, executeUslOperation } from "../src/application.js"
import { adaptPropertyGraph } from "../src/integrations/property-graph.js"
import { digestJson, planDigest } from "../src/language/digest.js"
import { hswmDigest } from "../src/integrations/hswm.js"
import { formatLocator } from "../src/locator.js"

const raw = JSON.stringify({
  nodes: [{ uid: "a", properties: { locator: "file://fixture/a" } }, { uid: "b", properties: { locator: "file://fixture/b" } }],
  relations: [{ uid: "edge", from_uid: "a", to_uid: "b", type: "BEFORE" }],
})
const adapt = (text: string) => adaptPropertyGraph(text, { namespace: "boundary.native" })
const graph = Either.getOrThrow(adapt(raw))
const authority = (): HswmAuthority => ({
  policy: { schema_version: "hswm-usl-observation-policy/v2", namespace: graph.plan.namespace,
    plan_digest: hswmDigest(graph.plan), usl_plan_digest: planDigest(graph.plan), source_digest: null,
    max_age_seconds: 60, bindings: [{ link: graph.identities.links.edge!, role: "reference", field: "available" }],
    resources: graph.plan.resources.map(resource => ({ name: resource.name, content_hash: "a".repeat(64), resolved_locator: formatLocator(resource.locator) })) },
  allowed_reads: [["reference", "available"]], revision: "fixture",
})
const fixture = () => {
  const calls = { source: 0, resolver: 0 }
  const policy = { ...DEFAULT_USL_POLICY, allowedLocators: ["file://fixture/a", "file://fixture/b"],
    resolvers: { resolve: (locator: typeof graph.plan.resources[number]["locator"]) => Effect.sync(() => {
      calls.resolver++
      return { locator, resolvedLocator: formatLocator(locator), contentHash: "a".repeat(64), resolvedAt: "2026-09-08T00:00:00.000Z", guaranteeLevel: "pure" as const, matchCount: 1 }
    }) } }
  const usl = connectUsl({ read: () => Effect.sync(() => { calls.source++; return raw }), adapt, policy })
  return { calls, policy, usl }
}

test("SDK context options cannot replace the explicit query or silently erase malformed limits", async () => {
  const { calls, usl } = fixture()
  const query = { focus: "a", target: "b", maxHops: 0 }
  for (const options of [{ query: { ...query, maxHops: 2 } }, { compact: "true" }, { maxBytes: 1000 }, null, []]) {
    await assert.rejects(Effect.runPromise(usl.context(undefined, query, options as never)))
  }
  for (const invalidQuery of [{ ...query, maxHops: null }, { ...query, maxVisits: -1 }, { ...query, routes: [{ meaning: "edge", enter: "source", exit: "source" }] }]) {
    await assert.rejects(Effect.runPromise(usl.context(undefined, invalidQuery as never)))
  }
  assert.deepEqual(calls, { source: 0, resolver: 0 })
  const result = await Effect.runPromise(usl.context(undefined, query))
  assert.equal((result.result as any).target.status, "NOT_FOUND_WITHIN_LIMITS")
  assert.equal((result.result as any).coverage.limits.maxHops, 0)
})

test("adapter receipts retain a private immutable JSON result after caller mutation", () => {
  const original = { status: "UNRESOLVED", evidence: [] as string[] }
  const result = adapterResult(graph, original)
  original.status = "READY"; original.evidence.push("changed")
  assert.deepEqual(result.result, { status: "UNRESOLVED", evidence: [] })
  assert.equal(result.receipt.resultDigest, digestJson(result.result))
  const { digest, ...receipt } = result.receipt
  assert.equal(digest, digestJson({ source: result.source, identities: result.identities, ...receipt }))
  assert.ok(Object.isFrozen(result.result.evidence))
  assert.equal(Object.isFrozen(original), false)
  let getters = 0
  assert.throws(() => adapterResult(graph, { get state() { getters++; return "READY" } }), /accessors/)
  assert.equal(getters, 0)
})

test("SDK and application reject malformed observation options before any source IO", async () => {
  const { calls, usl, policy } = fixture()
  const invalid = [{ links: null }, { links: [1] }, { allowedLocators: null }, { allowedLocators: ["file://fixture/elsewhere"] }, { maxResources: 65 }, { sourceText: "unexpected" }]
  for (const options of invalid) {
    await assert.rejects(Effect.runPromise(usl.observe(undefined, options as never)))
    await assert.rejects(executeUslOperation("observe", { connection: "current", options }, {
      ...policy, getConnection: async () => { calls.source++; return graph },
    }))
    await assert.rejects(executeUslOperation("observe", { program: "current", options }, {
      ...policy, getProgram: async () => { calls.source++; throw new Error("unexpected read") },
    }))
  }
  assert.deepEqual(calls, { source: 0, resolver: 0 })
})

test("snapshot and operation share identity validation; snapshot enforces its own output budget", async () => {
  const invalid = { ...graph, identities: { resources: {}, links: {} } }
  const bad = connectUsl({ read: () => Effect.succeed(raw), adapt: () => Either.right(invalid) })
  await assert.rejects(Effect.runPromise(bad.snapshot(undefined)), /cover the view/)
  await assert.rejects(Effect.runPromise(bad.check(undefined)), /cover the view/)
  const bytes = Buffer.byteLength(JSON.stringify(graph))
  const exact = connectUsl({ read: () => Effect.succeed(raw), adapt, policy: { ...DEFAULT_USL_POLICY, maxOutputBytes: bytes } })
  const snapshot = await Effect.runPromise(exact.snapshot(undefined))
  assert.equal(Buffer.byteLength(JSON.stringify(snapshot)), bytes)
  assert.ok(Object.isFrozen(snapshot.plan))
  const limited = connectUsl({ read: () => Effect.succeed(raw), adapt, policy: { ...DEFAULT_USL_POLICY, maxOutputBytes: bytes - 1 } })
  await assert.rejects(Effect.runPromise(limited.snapshot(undefined)), /snapshot exceeds maxOutputBytes/)
  let getterCalls = 0
  const accessor = connectUsl({ read: () => Effect.succeed(raw), adapt: () => Either.right({ ...graph, get identities() { getterCalls++; return graph.identities } }) })
  await assert.rejects(Effect.runPromise(accessor.snapshot(undefined)), /accessors/)
  assert.equal(getterCalls, 0)
})

test("HSWM rejects malformed or unauthorized authority before reads and stale plan pins before resolution", async () => {
  const { calls, usl } = fixture()
  const denied = { ...authority(), allowed_reads: [] }
  const wrongSource = authority(); (wrongSource.policy as any).source_digest = `sha256:${"a".repeat(64)}`
  for (const input of [{ policy: {}, allowed_reads: [], revision: "x" }, denied, wrongSource, { ...authority(), injected: true }]) {
    await assert.rejects(Effect.runPromise(usl.hswm(undefined, {}, input as never)))
  }
  assert.deepEqual(calls, { source: 0, resolver: 0 })
  const wrongPlan = authority(); (wrongPlan.policy as any).plan_digest = "b".repeat(64)
  await assert.rejects(Effect.runPromise(usl.hswm(undefined, {}, wrongPlan)), /plan identity mismatch/)
  const missingPins = authority(); (missingPins.policy as any).resources = []
  await assert.rejects(Effect.runPromise(usl.hswm(undefined, {}, missingPins)), /pins must exactly cover/)
  assert.deepEqual(calls, { source: 2, resolver: 0 })
  const delivered = await Effect.runPromise(usl.hswm(undefined, { links: ["edge"] }, authority()))
  assert.equal(delivered.result.report.status, "RESOLVES")
  assert.equal(delivered.receipt.resultDigest, digestJson(delivered.result))
  assert.deepEqual(calls, { source: 3, resolver: 2 })
})

test("oversized SDK operation inputs and source requests fail before calling the owner", async () => {
  let reads = 0
  const usl = connectUsl({ read: (_request: unknown) => Effect.sync(() => { reads++; return raw }), adapt,
    policy: { ...DEFAULT_USL_POLICY, maxInputBytes: 64 } })
  await assert.rejects(Effect.runPromise(usl.snapshot({ large: "a".repeat(100) })), /request exceeds maxInputBytes/)
  await assert.rejects(Effect.runPromise(usl.observe(undefined, { links: ["a".repeat(100)] })), /input exceeds maxInputBytes/)
  assert.equal(reads, 0)
})
