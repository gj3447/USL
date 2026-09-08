import { test } from "node:test"
import assert from "node:assert/strict"
import { Effect, Either, Layer } from "effect"
import type { Locator } from "../src/domain.js"
import { formatLocator } from "../src/locator.js"
import { ResolveError, Resolvers } from "../src/resolve.js"
import { compileSource, digestJson, observeProgram, validateObservation } from "../src/language/index.js"

const first = "https://EXAMPLE.test:443", alias = "https://example.test/", kg = "kg://canonical-neo4j/sym:Concept:rel"
const plan = (reverse = false) => Either.getOrThrow(compileSource(`usl "0.1"; namespace "url.aliases";
${(reverse ? [`resource b = "${alias}";`, `resource a = "${first}";`] : [`resource a = "${first}";`, `resource b = "${alias}";`]).join("\n")}
meaning rel(left: url, right: url) = "a relates to b" grounded "${kg}";
link chosen = rel(left: a, right: b);`))
const resolver = (calls: string[], denied = false) => Layer.succeed(Resolvers, { resolve: (locator: Locator) => {
  calls.push(formatLocator(locator))
  return denied
    ? Effect.fail(new ResolveError({ kind: locator.kind, locator: formatLocator(locator), reason: "DENIED", detail: "config policy" }))
    : Effect.succeed({ locator, resolvedLocator: formatLocator(locator), contentHash: `hash-${calls.length}`, resolvedAt: "2026-09-08T00:00:00.000Z", guaranteeLevel: "pure" as const, matchCount: 1 })
} })

test("equivalent URL declarations share one budget slot and exact resolver snapshot", async () => {
  for (const reverse of [false, true]) {
    const calls: string[] = []
    const representative = reverse ? alias : first
    const report = await Effect.runPromise(observeProgram(plan(reverse), { maxResources: 2, allowedLocators: [alias, kg] }).pipe(Effect.provide(resolver(calls))))
    assert.deepEqual(calls, [representative, kg])
    assert.deepEqual(report.readScope.requestedLocators, [representative, kg])
    assert.deepEqual(report.resources.map((r) => r.locator), reverse ? [alias, first] : [first, alias])
    assert.equal(report.metrics.selectedResources, 2)
    assert.equal(report.metrics.uniqueLocators, 2)
    assert.equal(report.metrics.resolverCalls, 2)
    assert.deepEqual(report.resources[0]!.resolution, report.resources[1]!.resolution)
    assert.equal(formatLocator(report.resources[1]!.resolution!.locator), representative)
    assert.ok(Either.isRight(validateObservation(JSON.parse(JSON.stringify(report)))))
  }
})

test("URL aliases share denial counts for request policy and resolver policy failures", async () => {
  for (const byResolver of [false, true]) {
    const calls: string[] = []
    const report = await Effect.runPromise(observeProgram(plan(), { maxResources: 2, allowedLocators: byResolver ? [alias, kg] : [] }).pipe(Effect.provide(resolver(calls, byResolver))))
    assert.equal(report.metrics.deniedLocators, 2)
    assert.equal(calls.length, byResolver ? 2 : 0)
    assert.ok(Either.isRight(validateObservation(report)))
  }
})

test("URL aliases cannot carry conflicting evidence or forged raw-address statistics", async () => {
  const report = await Effect.runPromise(observeProgram(plan(), { maxResources: 2 }).pipe(Effect.provide(resolver([]))))
  const rewrite = (edit: (copy: any) => void) => {
    // JSON parsing gives each alias a separate object so only one row is tampered with.
    const copy = JSON.parse(JSON.stringify(report))
    edit(copy)
    const { observationDigest: _old, ...payload } = copy
    copy.observationDigest = digestJson(payload)
    return validateObservation(copy)
  }
  for (const edit of [
    (copy: any) => { copy.resources[1].resolution.contentHash = "conflicting hash" },
    (copy: any) => { copy.resources[1].resolution.resolvedAt = "2026-09-08T00:00:01.000Z" },
    (copy: any) => { copy.resources[1].resolution.locator.href = alias },
    (copy: any) => { copy.readScope.resourceBudget = 3; copy.readScope.requestedLocators = [first, alias, kg]; copy.metrics.uniqueLocators = 3; copy.metrics.resolverCalls = 3 },
  ]) assert.ok(Either.isLeft(rewrite(edit)))
})

test("different URL paths remain separate requests and budget entries", async () => {
  const input = Either.getOrThrow(compileSource(`usl "0.1"; namespace "distinct.urls";
resource a = "https://example.test/one"; resource b = "https://example.test/two";
meaning rel(left: url, right: url) = "different references"; link l = rel(left: a, right: b);`))
  const calls: string[] = []
  const tooSmall = await Effect.runPromise(Effect.either(observeProgram(input, { maxResources: 1 })).pipe(Effect.provide(resolver(calls))))
  assert.ok(Either.isLeft(tooSmall))
  assert.deepEqual(calls, [])
  const report = await Effect.runPromise(observeProgram(input, { maxResources: 2 }).pipe(Effect.provide(resolver(calls))))
  assert.deepEqual(calls, ["https://example.test/one", "https://example.test/two"])
  assert.ok(Either.isRight(validateObservation(report)))
})
