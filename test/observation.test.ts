import { test } from "node:test"
import assert from "node:assert/strict"
import { Effect, Either, Layer } from "effect"
import { Resolvers, type ResolveError } from "../src/resolve.js"
import { formatLocator } from "../src/locator.js"
import { agentContext, compareObservations, compileSource, digestSource, observeProgram } from "../src/language/index.js"
import type { Locator, Resolution } from "../src/domain.js"

const source = `usl "0.1";
namespace "test.observation";
resource a = "https://example.test/shared";
resource b = "https://example.test/shared";
resource c = "https://example.test/other";
resource concept = "kg://canonical-neo4j/sym:Concept:target";
meaning implements(left: url, right: url) = "왼쪽이 오른쪽을 구현한다" grounded "kg://canonical-neo4j/sym:Concept:implements"
  applies "고정된 문서 버전 범위"
  check review(left, right) = "두 문서를 대조한다";
link chosen = implements(left: a, right: b);
link ignored = implements(left: a, right: c);`

const plan = (text = source) => Either.getOrThrowWith(compileSource(text), (error) => error)

const fakeResolvers = (calls: string[], hashes: Readonly<Record<string, string>> = {}) => Layer.succeed(Resolvers, {
  resolve: (locator: Locator): Effect.Effect<Resolution, ResolveError> => {
    const address = formatLocator(locator)
    calls.push(address)
    return Effect.succeed({ locator, resolvedLocator: address, contentHash: hashes[address] ?? `hash:${address}`, resolvedAt: "2026-09-08T00:00:00.000Z", guaranteeLevel: "pure", matchCount: 1 })
  },
})
const observe = (compiled = plan(), options = {}, calls: string[] = [], hashes: Readonly<Record<string, string>> = {}) =>
  Effect.runPromise(observeProgram(compiled, options).pipe(Effect.provide(fakeResolvers(calls, hashes))))
const comparison = (previous: unknown, current: unknown) => Either.getOrThrowWith(compareObservations(previous, current), (error) => error)

test("observations bind their exact plan and meaning contracts even with identical endpoint results", async () => {
  const calls: string[] = []
  const baseline = await observe(plan(), { links: ["chosen"], sourceText: source }, calls)
  const reversedSource = source.replace("왼쪽이 오른쪽을 구현한다", "오른쪽이 왼쪽을 구현한다")
  const changed = await observe(plan(reversedSource), { links: ["chosen"], sourceText: reversedSource }, [], {})
  assert.notEqual(baseline.planDigest, changed.planDigest)
  assert.notEqual(baseline.meaningsDigest, changed.meaningsDigest)
  assert.notEqual(baseline.links[0]?.meaningDigest, changed.links[0]?.meaningDigest)
  assert.notEqual(baseline.links[0]?.contractDigest, changed.links[0]?.contractDigest)
  assert.equal(baseline.sourceDigest, digestSource(source))
  assert.equal(baseline.planDigest, Either.getOrThrow(agentContext(plan(), { focus: "a" })).planDigest)
  assert.deepEqual(calls.sort(), ["https://example.test/shared", "kg://canonical-neo4j/sym:Concept:implements"])
})

test("selected observation reads only selected participants and groundings, deduplicates aliases, and never runs checks", async () => {
  const calls: string[] = []
  const report = await observe(plan(), { links: ["chosen"] }, calls)
  assert.deepEqual(report.readScope.links, ["chosen"])
  assert.equal(report.metrics.selectedResources, 2)
  assert.equal(report.metrics.uniqueLocators, 2)
  assert.equal(report.metrics.resolverCalls, 2)
  assert.equal(report.resources.some((resource) => resource.name === "c"), false)
  assert.equal(report.links[0]?.verification[0]?.evidenceAvailable, true)
  assert.equal(report.links[0]?.verification[0]?.status, "NOT_EXECUTED")
  const emptyCalls: string[] = []
  const empty = await observe(plan(), { links: [] }, emptyCalls)
  assert.equal(empty.resources.length, 0); assert.equal(empty.groundings.length, 0)
  assert.equal(empty.metrics.resolverCalls, 0); assert.deepEqual(emptyCalls, [])
})

test("allowlists and invalid observation requests fail closed before resolver calls", async () => {
  const deniedCalls: string[] = []
  const denied = await observe(plan(), { links: ["chosen"], allowedLocators: [] }, deniedCalls)
  assert.deepEqual(deniedCalls, [])
  assert.equal(denied.status, "UNRESOLVED")
  assert.ok([...denied.resources, ...denied.groundings].every((resource) => resource.status === "DENIED"))
  const cases: Array<[string, object, RegExp]> = [
    ["unknown link", { links: ["missing"] }, /unknown link/],
    ["resource budget", { links: ["chosen"], maxResources: 1 }, /exceeding maxResources/],
    ["mismatched source", { links: ["chosen"], sourceText: source.replace("test.observation", "other") }, /sourceText does not compile/],
  ]
  for (const [name, options, expected] of cases) {
    const calls: string[] = []
    await assert.rejects(observe(plan(), options, calls), expected, name)
    assert.deepEqual(calls, [], name)
  }
})

test("observation snapshots the plan before async reads and keeps its report detached", async () => {
  const input = plan()
  const expectedDescription = input.meanings[0]!.description
  const expectedDigest = Either.getOrThrow(agentContext(input, { focus: "a" })).planDigest
  let release: (() => void) | undefined
  let started: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const begun = new Promise<void>((resolve) => { started = resolve })
  const delayed = Layer.succeed(Resolvers, { resolve: (locator: Locator): Effect.Effect<Resolution, ResolveError> => {
    started!()
    const address = formatLocator(locator)
    return Effect.promise(() => gate).pipe(Effect.as({ locator, resolvedLocator: address, contentHash: `hash:${address}`, resolvedAt: "2026-09-08T00:00:00.000Z", guaranteeLevel: "pure" as const, matchCount: 1 }))
  } })
  const pending = Effect.runPromise(observeProgram(input, { links: ["chosen"] }).pipe(Effect.provide(delayed)))
  await begun
  ;(input.meanings[0] as { description: string }).description = "caller changed this during IO"
  release!()
  const report = await pending
  assert.equal(report.planDigest, expectedDigest)
  assert.equal(report.meanings[0]?.definition.description, expectedDescription)
  ;(report.meanings[0]!.definition as { description: string }).description = "report mutation"
  assert.equal(input.meanings[0]?.description, "caller changed this during IO")
})

test("observation captures sourceText before async reads", async () => {
  const start = (options: { links: string[]; sourceText?: string }) => {
    let release: (() => void) | undefined
    let started: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const begun = new Promise<void>((resolve) => { started = resolve })
    const delayed = Layer.succeed(Resolvers, { resolve: (locator: Locator): Effect.Effect<Resolution, ResolveError> => {
      started!()
      const address = formatLocator(locator)
      return Effect.promise(() => gate).pipe(Effect.as({ locator, resolvedLocator: address, contentHash: `hash:${address}`, resolvedAt: "2026-09-08T00:00:00.000Z", guaranteeLevel: "pure" as const, matchCount: 1 }))
    } })
    return { begun, release: () => release!(), pending: Effect.runPromise(observeProgram(plan(), options).pipe(Effect.provide(delayed))) }
  }
  const supplied: { links: string[]; sourceText?: string } = { links: ["chosen"], sourceText: source }
  const first = start(supplied)
  await first.begun
  delete supplied.sourceText
  first.release()
  assert.equal((await first.pending).sourceDigest, digestSource(source))
  const swapped: { links: string[]; sourceText?: string } = { links: ["chosen"], sourceText: source }
  const third = start(swapped)
  await third.begun
  swapped.sourceText = source.replace("왼쪽이 오른쪽을 구현한다", "오른쪽이 왼쪽을 구현한다")
  third.release()
  const swappedReport = await third.pending
  assert.equal(swappedReport.sourceDigest, digestSource(source))
  assert.equal(swappedReport.planDigest, Either.getOrThrow(agentContext(plan(), { focus: "a" })).planDigest)
  const omitted: { links: string[]; sourceText?: string } = { links: ["chosen"] }
  const second = start(omitted)
  await second.begun
  omitted.sourceText = source
  second.release()
  assert.equal((await second.pending).sourceDigest, null)
})

test("observation comparison separates address, content, and semantic-contract changes", async () => {
  const baseline = await observe(plan(), { links: ["chosen"] }, [], { "https://example.test/shared": "same", "kg://canonical-neo4j/sym:Concept:implements": "ground" })
  const compare = async (nextSource: string, hashes: Readonly<Record<string, string>>) =>
    comparison(baseline, await observe(plan(nextSource), { links: ["chosen"] }, [], hashes))
  const addressSource = source.replace('resource b = "https://example.test/shared"', 'resource b = "https://example.test/moved"')
  const address = await compare(addressSource, { "https://example.test/shared": "same", "https://example.test/moved": "same", "kg://canonical-neo4j/sym:Concept:implements": "ground" })
  assert.deepEqual(address.links[0], { name: "chosen", addressChanged: ["right"], contentChanged: [], semanticContractChanged: false, unavailable: [], baselineMissing: [], actions: ["REVIEW_ADDRESS_BINDING"] })
  const content = await compare(source, { "https://example.test/shared": "changed", "kg://canonical-neo4j/sym:Concept:implements": "ground" })
  assert.deepEqual(content.links[0], { name: "chosen", addressChanged: [], contentChanged: ["left", "right"], semanticContractChanged: false, unavailable: [], baselineMissing: [], actions: ["RECHECK_EVIDENCE"] })
  const meaningSource = source.replace("왼쪽이 오른쪽을 구현한다", "오른쪽이 왼쪽을 구현한다")
  const meaning = await compare(meaningSource, { "https://example.test/shared": "same", "kg://canonical-neo4j/sym:Concept:implements": "ground" })
  assert.deepEqual(meaning.links[0], { name: "chosen", addressChanged: [], contentChanged: [], semanticContractChanged: true, unavailable: [], baselineMissing: [], actions: ["REVIEW_SEMANTIC_CONTRACT"] })
  const combined = await compare(addressSource.replace("왼쪽이 오른쪽을 구현한다", "오른쪽이 왼쪽을 구현한다"), { "https://example.test/shared": "changed", "https://example.test/moved": "changed", "kg://canonical-neo4j/sym:Concept:implements": "ground" })
  assert.deepEqual(combined.links[0]?.actions, ["REVIEW_ADDRESS_BINDING", "RECHECK_EVIDENCE", "REVIEW_SEMANTIC_CONTRACT"])
})

test("comparison rejects stale schemas and digest corruption before making a change claim", async () => {
  const report = await observe(plan(), { links: ["chosen"] })
  const legacy = { ...report, schema: "usl-program-observation/v1" }
  const corrupt = { ...report, planDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" }
  for (const invalid of [legacy, corrupt]) {
    assert.ok(Either.isLeft(compareObservations(invalid, report)))
  }
  const newScope = await observe(plan(), { links: ["ignored"] })
  const compared = comparison(report, newScope)
  assert.equal(compared.links[0]?.semanticContractChanged, null)
  assert.deepEqual(compared.links[0]?.baselineMissing, ["left", "right", "grounding:implements"])
  assert.ok(compared.links[0]?.actions.includes("ESTABLISH_BASELINE"))
})

test("observation allowlists use the same URL normalization as the live resolver", async () => {
  const text = `usl "0.1"; namespace "policy";
resource a = "https://example.test";
meaning same(left: url, right: url) = "same reference";
link l = same(left: a, right: a);`
  const calls: string[] = []
  const report = await observe(plan(text), { allowedLocators: ["https://example.test/"] }, calls)
  assert.equal(report.status, "RESOLVES")
  assert.equal(report.metrics.resolverCalls, 1)
})

test("rebinding a participant alias changes the address binding rather than the meaning contract", async () => {
  const baseline = await observe(plan(), { links: ["chosen"] })
  const aliased = source.replace("chosen = implements(left: a, right: b)", "chosen = implements(left: b, right: a)")
  const revised = await observe(plan(aliased), { links: ["chosen"] })
  const result = Either.getOrThrow(compareObservations(baseline, revised)).links[0]!
  assert.equal(result.semanticContractChanged, false)
  assert.deepEqual(result.contentChanged, [])
  assert.deepEqual(result.addressChanged, ["left", "right"])
  assert.deepEqual(result.actions, ["REVIEW_ADDRESS_BINDING"])
})
