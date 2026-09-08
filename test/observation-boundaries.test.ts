import { test } from "node:test"
import assert from "node:assert/strict"
import { Effect, Either, Layer } from "effect"
import type { Locator, Resolution } from "../src/domain.js"
import { formatLocator } from "../src/locator.js"
import { Resolvers } from "../src/resolve.js"
import { compileSource, digestJson, observeProgram, validateObservation } from "../src/language/index.js"

const source = `usl "0.1"; namespace "boundaries";
resource a = "https://example.test/a"; resource b = "https://example.test/b";
resource extra = "https://example.test/extra";
meaning relates(left: url, right: url) = "a relates to b" grounded "kg://canonical-neo4j/sym:Concept:relates";
link chosen = relates(left: a, right: b); link ignored = relates(left: a, right: extra);`
const plan = () => Either.getOrThrow(compileSource(source))
type MutableResolution = { -readonly [K in keyof Resolution]: Resolution[K] }
const resolution = (locator: Locator): MutableResolution => ({ locator, resolvedLocator: formatLocator(locator), contentHash: "before",
  resolvedAt: "2026-09-08T00:00:00.000Z", guaranteeLevel: "pure", matchCount: 1 })

test("null selection, permission and budget fail before any resolver invocation", async () => {
  for (const options of [{ links: null }, { allowedLocators: null }, { maxResources: null }, { sourceText: null }, null]) {
    const calls: string[] = []
    const layer = Layer.succeed(Resolvers, { resolve: (locator) => { calls.push(formatLocator(locator)); return Effect.succeed(resolution(locator)) } })
    const result = await Effect.runPromise(Effect.either(observeProgram(plan(), options as never)).pipe(Effect.provide(layer)))
    assert.ok(Either.isLeft(result), JSON.stringify(options))
    assert.equal(result.left._tag, "ObservationError")
    assert.deepEqual(calls, [])
  }
})

test("each completed resolution is detached before subsequent resolver work and after return", async () => {
  let retained: MutableResolution | undefined
  const layer = Layer.succeed(Resolvers, { resolve: (locator) => {
    // This runs while constructing the next effect, not only after its async work.
    if (locator.kind === "kg") retained!.contentHash = "changed by subsequent resolver"
    const result = resolution(locator)
    if (locator.kind === "url" && locator.href.endsWith("/a")) retained = result
    return Effect.succeed(result)
  } })
  const report = await Effect.runPromise(observeProgram(plan(), { links: ["chosen"] }).pipe(Effect.provide(layer)))
  assert.equal(report.resources[0]!.resolution!.contentHash, "before")
  assert.ok(Either.isRight(validateObservation(report)))
  retained!.contentHash = "changed after return"
  ;(retained!.locator as { href: string }).href = "https://example.test/changed"
  assert.equal(report.resources[0]!.resolution!.contentHash, "before")
  assert.equal(formatLocator(report.resources[0]!.resolution!.locator), "https://example.test/a")
  assert.ok(Either.isRight(validateObservation(report)))
})

test("resolver-owned request and policy copies cannot mutate the plan or report scope", async () => {
  const input = plan()
  const initialDigest = digestJson(input)
  const retained: Array<{ locator: Locator; allowed: readonly string[] }> = []
  const layer = Layer.succeed(Resolvers, { resolve: (locator, policy) => {
    assert.ok(policy?.allowedLocators)
    retained.push({ locator, allowed: policy.allowedLocators })
    return Effect.succeed(resolution(locator))
  } })
  const report = await Effect.runPromise(observeProgram(input, { links: ["chosen"] }).pipe(Effect.provide(layer)))
  const scope = structuredClone(report.readScope)
  ;(retained[0]!.allowed as string[]).push("https://example.test/unlisted")
  ;(retained[0]!.locator as { href: string }).href = "https://example.test/unlisted"
  assert.equal(digestJson(input), initialDigest)
  assert.equal(report.planDigest, initialDigest)
  assert.deepEqual(report.readScope, scope)
  assert.ok(Either.isRight(validateObservation(report)))
})

test("KG resolved identity forgery is rejected even if target is allowed and outer digest is recomputed", async () => {
  const kg = "kg://canonical-neo4j/sym:Concept:relates"
  const otherUid = "kg://canonical-neo4j/sym:Concept:other"
  const otherSource = "kg://other/sym:Concept:relates"
  const layer = Layer.succeed(Resolvers, { resolve: (locator) => Effect.succeed(resolution(locator)) })
  const report = await Effect.runPromise(observeProgram(plan(), { links: ["chosen"], allowedLocators: [
    "https://example.test/a", "https://example.test/b", kg, otherUid, otherSource,
  ] }).pipe(Effect.provide(layer)))
  assert.ok(Either.isRight(validateObservation(report)))
  for (const resolvedLocator of [otherUid, otherSource]) {
    const copy = structuredClone(report)
    ;(copy.groundings[0]!.resolution as MutableResolution).resolvedLocator = resolvedLocator
    const { observationDigest: _old, ...payload } = copy
    copy.observationDigest = digestJson(payload)
    const checked = validateObservation(copy)
    assert.ok(Either.isLeft(checked), resolvedLocator)
    assert.match(checked.left.detail, /KG.*identity/)
  }
})

test("malformed resolver snapshots and changed KG identities fail with ObservationError", async () => {
  for (const edit of [
    (value: MutableResolution) => { value.contentHash = "" },
    (value: MutableResolution) => { value.matchCount = -1 },
    (value: MutableResolution) => { value.resolvedLocator = "kg://canonical-neo4j/sym:Concept:other" },
  ]) {
    const layer = Layer.succeed(Resolvers, { resolve: (locator) => {
      const value = resolution(locator)
      if (locator.kind === "kg") edit(value)
      return Effect.succeed(value)
    } })
    const result = await Effect.runPromise(Effect.either(observeProgram(plan(), { links: ["chosen"] })).pipe(Effect.provide(layer)))
    assert.ok(Either.isLeft(result))
    assert.equal(result.left._tag, "ObservationError")
  }
})
