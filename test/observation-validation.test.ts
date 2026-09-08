import { test } from "node:test"
import assert from "node:assert/strict"
import { Effect, Either, Layer } from "effect"
import { ResolveError, Resolvers, type ResolveError as ResolveFailure } from "../src/resolve.js"
import { compileSource, digestJson, observeProgram, validateObservation, type ProgramObservation } from "../src/language/index.js"
import type { Locator, Resolution } from "../src/domain.js"
import { formatLocator } from "../src/locator.js"

const source = `usl "0.1";
namespace "validation.observation";
resource a = "https://example.test/shared";
resource b = "https://example.test/shared";
resource unused = "https://example.test/unused";
meaning implements(left: url, right: url) = "left implements right" grounded "kg://canonical-neo4j/sym:Concept:implements"
  applies "pinned game build"
  check review(left, right) = "compare both assets";
link selected = implements(left: a, right: b);`

const plan = () => Either.getOrThrow(compileSource(source))
const success = Layer.succeed(Resolvers, { resolve: (locator: Locator): Effect.Effect<Resolution, ResolveFailure> =>
  Effect.succeed({ locator, resolvedLocator: formatLocator(locator), contentHash: "content", resolvedAt: "2026-09-08T00:00:00.000Z", guaranteeLevel: "pure", matchCount: 1 }),
})
const orphan = Layer.succeed(Resolvers, { resolve: (locator: Locator): Effect.Effect<Resolution, ResolveFailure> =>
  Effect.fail(new ResolveError({ kind: locator.kind, locator: formatLocator(locator), reason: "ORPHAN", detail: "fixture missing" })),
})
const nonUnique = Layer.succeed(Resolvers, { resolve: (locator: Locator): Effect.Effect<Resolution, ResolveFailure> =>
  Effect.succeed({ locator, resolvedLocator: formatLocator(locator), contentHash: "content", resolvedAt: "2026-09-08T00:00:00.000Z", guaranteeLevel: "pure", matchCount: 2 }),
})
const deniedByConfig = Layer.succeed(Resolvers, { resolve: (locator: Locator): Effect.Effect<Resolution, ResolveFailure> =>
  Effect.fail(new ResolveError({ kind: locator.kind, locator: formatLocator(locator), reason: "DENIED", detail: "ambient policy denied this locator" })),
})
const observe = (layer = success, options = {}) => Effect.runPromise(observeProgram(plan(), { links: ["selected"], ...options }).pipe(Effect.provide(layer)))
const observeSource = (text: string) => Effect.runPromise(observeProgram(Either.getOrThrow(compileSource(text))).pipe(Effect.provide(success)))

const rewrite = (report: ProgramObservation, mutate: (copy: any) => void): unknown => {
  const copy: any = structuredClone(report)
  mutate(copy)
  const { observationDigest: _old, ...payload } = copy
  copy.observationDigest = digestJson(payload)
  return copy
}
const rejected = (report: unknown) => assert.ok(Either.isLeft(validateObservation(report)))

test("valid successful, denied, failed, alias, and grounding-deduplicated reports validate", async () => {
  const ok = await observe()
  const denied = await observe(success, { allowedLocators: [] })
  const failed = await observe(orphan)
  for (const report of [ok, denied, failed]) assert.ok(Either.isRight(validateObservation(report)))
  assert.equal(ok.resources.length, 2) // a and b are distinct participants.
  assert.equal(ok.metrics.uniqueLocators, 2) // shared participant address + grounding.
  assert.equal(ok.metrics.resolverCalls, 2)
  assert.equal(ok.readScope.requestedLocators.includes("https://example.test/unused"), false)
  const deduplicated = await observeSource(`usl "0.1"; namespace "dedup";
resource anchor = "kg://canonical-neo4j/sym:Concept:anchor";
meaning points(left: kg, right: kg) = "same anchor" grounded "kg://canonical-neo4j/sym:Concept:anchor";
link l = points(left: anchor, right: anchor);`)
  assert.ok(Either.isRight(validateObservation(deduplicated)))
  assert.equal(deduplicated.metrics.uniqueLocators, 1)
  assert.equal(deduplicated.metrics.resolverCalls, 1)
})

test("validator accepts non-unique and config-policy denials within the requested scope", async () => {
  const ambiguous = await observe(nonUnique)
  assert.ok(ambiguous.resources.every((r) => r.status === "AMBIGUOUS" && r.resolution?.matchCount === 2))
  assert.ok(Either.isRight(validateObservation(ambiguous)))
  const denied = await observe(deniedByConfig)
  assert.ok(denied.readScope.allowedLocators.includes("https://example.test/shared"))
  assert.ok(denied.resources.every((r) => r.status === "DENIED"))
  assert.ok(Either.isRight(validateObservation(denied)))
})

test("validation rejects forged execution, report shape, scope, and metrics after digest recomputation", async () => {
  const report = await observe()
  const mutations: Array<(copy: any) => void> = [
    (x) => { x.links[0].verification[0].status = "EXECUTED" },
    (x) => { delete x.readScope },
    (x) => { x.unexpected = true },
    (x) => { x.metrics.unexpected = true },
    (x) => { x.resources[0].name = 3 },
    (x) => { delete x.resources[0].resolution.resolvedAt },
    (x) => { x.readScope.links = ["wrong"] },
    (x) => { x.readScope.requestedLocators = [] },
    (x) => { x.readScope.allowedLocators = [] },
    (x) => { x.metrics.resolverCalls = "2" },
    (x) => { x.metrics.uniqueLocators = -1 },
    (x) => { x.readScope.resourceBudget = -1 },
    (x) => { x.metrics.resolverCalls = 99 },
  ]
  for (const mutate of mutations) rejected(rewrite(report, mutate))
})

test("validation ties statuses, checks, resolutions, and fingerprints to the selected declarations", async () => {
  const report = await observe()
  const mutations: Array<(copy: any) => void> = [
    (x) => { x.links[0].resourcesResolve = false },
    (x) => { x.links[0].verification[0].evidenceAvailable = false },
    (x) => { x.status = "UNRESOLVED" },
    (x) => { x.links[0].verification[0].description = "forged check" },
    (x) => { x.links[0].verification[0].evidence[0].resource = "b" },
    (x) => { x.resources[0].issue = { reason: "ORPHAN", detail: "forged" } },
    (x) => { x.resources[0].resolution.locator = { kind: "url", href: "https://example.test/other" } },
    (x) => { x.resources[0].fingerprintScope = "KG_METADATA" },
    (x) => { x.resources[0].resolution.matchCount = 2 },
  ]
  for (const mutate of mutations) rejected(rewrite(report, mutate))
})

test("validation rejects unused selected-report declarations even with a fresh digest", async () => {
  const report = await observe()
  const withResource = rewrite(report, (x) => {
    x.resources.push({ ...x.resources[0], name: "unused", locator: "https://example.test/unused", resolution: { ...x.resources[0].resolution, locator: { kind: "url", href: "https://example.test/unused" }, resolvedLocator: "https://example.test/unused" } })
  })
  rejected(withResource)
  const withMeaning = rewrite(report, (x) => {
    const definition = structuredClone(x.meanings[0].definition)
    definition.name = "unusedMeaning"
    delete definition.grounded
    x.meanings.push({ name: "unusedMeaning", definition, digest: digestJson(definition) })
  })
  rejected(withMeaning)
})
