import { test } from "node:test"
import assert from "node:assert/strict"
import { Effect, Either, Layer } from "effect"
import type { Locator, Resolution } from "../src/domain.js"
import { formatLocator } from "../src/locator.js"
import { ResolveError, Resolvers } from "../src/resolve.js"
import { compileSource, digestSource, observeProgram, validateObservation } from "../src/language/index.js"

const source = `usl "0.1"; namespace "options.errors";
resource a = "https://example.test/a"; resource b = "https://example.test/b"; resource extra = "https://example.test/extra";
meaning relates(left: url, right: url) = "a relates to b" grounded "kg://canonical-neo4j/sym:Concept:relates";
link chosen = relates(left: a, right: b); link ignored = relates(left: a, right: extra);`
const plan = () => Either.getOrThrow(compileSource(source))
const resolution = (locator: Locator): Resolution => ({ locator, resolvedLocator: formatLocator(locator), contentHash: "content",
  resolvedAt: "2026-09-08T00:00:00.000Z", guaranteeLevel: "pure", matchCount: 1 })
const successful = (calls: string[]) => Layer.succeed(Resolvers, { resolve: (locator: Locator) => {
  calls.push(formatLocator(locator)); return Effect.succeed(resolution(locator))
} })
const run = (options: unknown, layer: Layer.Layer<Resolvers>) => Effect.runPromise(Effect.either(observeProgram(plan(), options as never)).pipe(Effect.provide(layer)))

test("option snapshots honor class, inherited, and non-enumerable fields without widening reads", async () => {
  const allowed = ["https://example.test/a", "https://example.test/b", "kg://canonical-neo4j/sym:Concept:relates"]
  class ClassOptions {
    reads = { links: 0, allowedLocators: 0, maxResources: 0, sourceText: 0 }
    linkNames = ["chosen"]
    get links() { this.reads.links++; return this.linkNames }
    get allowedLocators() { this.reads.allowedLocators++; this.linkNames.push("ignored"); return allowed }
    get maxResources() { this.reads.maxResources++; return 3 }
    get sourceText() { this.reads.sourceText++; return source }
  }
  const options = new ClassOptions()
  const calls: string[] = []
  const observed = await run(options, successful(calls))
  assert.ok(Either.isRight(observed))
  assert.deepEqual(observed.right.readScope.links, ["chosen"])
  assert.equal(observed.right.sourceDigest, digestSource(source))
  assert.deepEqual(options.reads, { links: 1, allowedLocators: 1, maxResources: 1, sourceText: 1 })
  assert.deepEqual(calls.sort(), allowed.sort())

  const inherited = Object.create({ links: ["chosen"], allowedLocators: allowed, maxResources: 3, sourceText: source })
  const inheritedCalls: string[] = []
  const inheritedObserved = await run(inherited, successful(inheritedCalls))
  assert.ok(Either.isRight(inheritedObserved))
  assert.deepEqual(inheritedObserved.right.readScope.links, ["chosen"])
  assert.deepEqual(inheritedCalls.sort(), allowed.sort())

  const hidden: Record<string, unknown> = {}
  for (const [key, value] of Object.entries({ links: ["chosen"], allowedLocators: allowed, maxResources: 3, sourceText: source }))
    Object.defineProperty(hidden, key, { enumerable: false, value })
  const hiddenCalls: string[] = []
  const hiddenObserved = await run(hidden, successful(hiddenCalls))
  assert.ok(Either.isRight(hiddenObserved))
  assert.deepEqual(hiddenObserved.right.readScope.links, ["chosen"])
  assert.deepEqual(hiddenCalls.sort(), allowed.sort())

  class DenyingClassOptions { get links() { return ["chosen"] } get allowedLocators() { return [] } }
  const denyCalls: string[] = []
  const denied = await run(new DenyingClassOptions(), successful(denyCalls))
  assert.ok(Either.isRight(denied))
  assert.deepEqual(denyCalls, [])
  assert.ok(denied.right.resources.every((resource) => resource.status === "DENIED"))

  class ZeroBudgetClassOptions { get links() { return ["chosen"] } get maxResources() { return 0 } }
  const budgetCalls: string[] = []
  const budget = await run(new ZeroBudgetClassOptions(), successful(budgetCalls))
  assert.ok(Either.isLeft(budget))
  assert.equal(budget.left._tag, "ObservationError")
  assert.deepEqual(budgetCalls, [])
})

test("explicit null option fields remain typed failures before resolver IO", async () => {
  for (const options of [{ links: null }, { allowedLocators: null }, { maxResources: null }, { sourceText: null }]) {
    const calls: string[] = []
    const observed = await run(options, successful(calls))
    assert.ok(Either.isLeft(observed), JSON.stringify(options))
    assert.equal(observed.left._tag, "ObservationError")
    assert.deepEqual(calls, [])
  }
})

test("malformed resolver failures are typed ObservationErrors and valid failures remain detached", async () => {
  type Corruption = "null" | "reason" | "kind" | "locator" | "detail"
  const corruptions: Corruption[] = ["null", "reason", "kind", "locator", "detail"]
  for (const corruption of corruptions) {
    const layer = Layer.succeed(Resolvers, { resolve: (locator: Locator) => {
      // All fields start valid for this requested locator; each case corrupts only one field.
      const failure: unknown = corruption === "null" ? null : {
        kind: corruption === "kind" ? "other" : locator.kind,
        locator: corruption === "locator" ? "https://example.test/other" : formatLocator(locator),
        reason: corruption === "reason" ? "NOT_A_REASON" : "ORPHAN",
        detail: corruption === "detail" ? null : "bad",
      }
      return Effect.fail(failure as never) as never
    } })
    const observed = await run({ links: ["chosen"] }, layer)
    assert.ok(Either.isLeft(observed), corruption)
    assert.equal(observed.left._tag, "ObservationError")
  }

  let retained: ResolveError | undefined
  const layer = Layer.succeed(Resolvers, { resolve: (locator: Locator) => {
    const error = new ResolveError({ kind: locator.kind, locator: formatLocator(locator), reason: "ORPHAN", detail: "missing at observation" })
    retained ??= error
    return Effect.fail(error)
  } })
  const observed = await run({ links: ["chosen"] }, layer)
  assert.ok(Either.isRight(observed))
  assert.ok(Either.isRight(validateObservation(observed.right)))
  ;(retained as { detail: string }).detail = "mutated after observation"
  assert.equal(observed.right.resources[0]!.issue?.detail, "missing at observation")
  assert.ok(Either.isRight(validateObservation(observed.right)))
})
