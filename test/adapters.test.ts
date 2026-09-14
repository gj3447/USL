import { test } from "node:test"
import assert from "node:assert/strict"
import { Effect, Either } from "effect"
import { connectUsl } from "../src/adapters.js"
import { adaptPropertyGraph } from "../src/integrations/property-graph.js"
import { DEFAULT_USL_POLICY, executeUslOperation } from "../src/application.js"
import { digestJson, digestSource, planDigest } from "../src/language/digest.js"
import { validateObservation } from "../src/language/comparison.js"
import { hswmDigest, type HswmObservationPolicyV2 } from "../src/integrations/hswm.js"
import { formatLocator } from "../src/locator.js"

const raw = (description = "code follows spec") => JSON.stringify({
  nodes: [{ uid: "game:spec", properties: { locator: "https://fixture.test/spec" } }, { uid: "game:code", properties: { locator: "file://fixture/code.ts" } }],
  relations: [{ uid: "game:implementation", from_uid: "game:spec", to_uid: "game:code", type: "IMPLEMENTS", properties: { description } }],
})
const adapt = (text: string) => adaptPropertyGraph(text, { namespace: "native.game" })
const allowed = ["https://fixture.test/spec", "file://fixture/code.ts"]

test("native adapters reread the owner without DSL files, recompilation commands or a cache", async () => {
  let current = raw(), reads = 0
  const usl = connectUsl({ read: (_request: { uid: string }) => Effect.sync(() => { reads++; return current }), adapt })
  const before = await Effect.runPromise(usl.context({ uid: "game:spec" }, { focus: "game:spec", target: "game:code" }))
  assert.match(JSON.stringify(before.result), /FOUND/)
  current = raw("code contradicts spec")
  const after = await Effect.runPromise(usl.context({ uid: "game:spec" }, { focus: "game:spec", target: "game:code" }))
  assert.equal(reads, 2)
  assert.notEqual(before.receipt.sourceDigest, after.receipt.sourceDigest)
  assert.notEqual(before.receipt.planDigest, after.receipt.planDigest)
  assert.equal(after.receipt.sourceDigest, digestSource(current))
  assert.equal(after.receipt.resultDigest, digestJson(after.result))
  assert.match(JSON.stringify(before.result), /code follows spec/)
  const { digest, ...receipt } = after.receipt
  assert.equal(digest, digestJson({ source: after.source, identities: after.identities, ...receipt }))
  const routed = await Effect.runPromise(usl.context({ uid: "game:spec" }, { focus: "game:spec", target: "game:code", routes: [{ meaning: "game:implementation", enter: "source", exit: "target" }] }))
  assert.match(JSON.stringify(routed.result), /FOUND/)
})

test("default deny policy and malformed nested options cannot read endpoints or widen source requests", async () => {
  let reads = 0
  const usl = connectUsl({ read: () => Effect.sync(() => { reads++; return raw() }), adapt })
  await assert.rejects(Effect.runPromise(usl.observe(undefined, Object.create({ links: [], maxResources: 0 }))), /plain JSON/)
  await assert.rejects(Effect.runPromise(usl.context(undefined, { focus: "game:spec" }, Object.create({ compact: true, maxBytes: 0 }))), /plain JSON/)
  assert.equal(reads, 0)
  const report = await Effect.runPromise(usl.observe(undefined, { links: ["game:implementation"] }))
  assert.equal(report.result.metrics.resolverCalls, 0)
  assert.equal(report.result.sourceDigest, null)
  assert.ok(Either.isRight(validateObservation(report.result)))
  await assert.rejects(Effect.runPromise(usl.observe(undefined, { links: null as any })), /options.links/)
})

test("adapter identity must bind exact source and input budget is checked before adaptation", async () => {
  let conversions = 0
  const limited = connectUsl({ read: () => Effect.succeed(raw()), adapt: text => { conversions++; return adapt(text) }, policy: { ...DEFAULT_USL_POLICY, maxInputBytes: 1 } })
  await assert.rejects(Effect.runPromise(limited.check(undefined)), /maxInputBytes/)
  assert.equal(conversions, 0)
  const forged = connectUsl({ read: () => Effect.succeed(raw()), adapt: () => adapt(raw("different source")) })
  await assert.rejects(Effect.runPromise(forged.check(undefined)), /exact native source/)
  let attempts = 0
  const failing = connectUsl({ read: () => ++attempts === 1 ? Effect.succeed(raw()) : Effect.fail(new Error("owner unavailable")), adapt })
  await Effect.runPromise(failing.check(undefined))
  await assert.rejects(Effect.runPromise(failing.check(undefined)), /owner unavailable/)
})

test("HSWM receives one immutable native version even if source and options change during observation", async () => {
  let current = raw(), reads = 0, resolves = 0
  const initial = Either.getOrThrow(adapt(current))
  const policy: HswmObservationPolicyV2 = {
    schema_version: "hswm-usl-observation-policy/v2", namespace: initial.plan.namespace,
    plan_digest: hswmDigest(initial.plan), usl_plan_digest: planDigest(initial.plan), source_digest: null,
    max_age_seconds: 60, bindings: [{ link: initial.identities.links["game:implementation"]!, role: "reference", field: "available" }],
    resources: initial.plan.resources.map(resource => ({ name: resource.name, content_hash: "a".repeat(64), resolved_locator: formatLocator(resource.locator) })),
  }
  const options = { links: ["game:implementation"] }
  const usl = connectUsl({ read: () => Effect.sync(() => { reads++; return current }), adapt,
    policy: { ...DEFAULT_USL_POLICY, allowedLocators: allowed, resolvers: { resolve: locator => Effect.sync(() => {
      resolves++; current = raw("opposite meaning"); options.links.length = 0
      return { locator, resolvedLocator: formatLocator(locator), contentHash: "a".repeat(64), resolvedAt: "2026-09-08T00:00:00.000Z", guaranteeLevel: "pure" as const, matchCount: 1 }
    }) } },
  })
  const result = await Effect.runPromise(usl.hswm(undefined, options, { policy, allowed_reads: [["reference", "available"]], now: 1788825600, revision: "native-fixture" }))
  assert.equal(reads, 1)
  assert.equal(resolves, 2)
  assert.equal(result.receipt.sourceDigest, digestSource(raw()))
  assert.equal(result.result.report.sourceDigest, null)
  assert.equal(result.result.report.planDigest, planDigest(initial.plan))
  assert.match(JSON.stringify(result.result.plan), /code follows spec/)
  assert.ok(Either.isRight(validateObservation(result.result.report)))
})

test("connection identity maps reject missing resources and prototype names before resolver IO", async () => {
  const graph = structuredClone(Either.getOrThrow(adapt(raw())))
  let calls = 0
  const policy = { ...DEFAULT_USL_POLICY, getConnection: async () => graph, resolvers: { resolve: () => { calls++; return Effect.die("must not resolve") } } }
  await assert.rejects(executeUslOperation("context", { connection: "game", query: { focus: "toString" } }, policy), /not a connection resource identity/)
  delete (graph.identities.resources as Record<string, string>)["game:code"]
  await assert.rejects(executeUslOperation("observe", { connection: "game" }, policy), /cover the view/)
  assert.equal(calls, 0)
})
