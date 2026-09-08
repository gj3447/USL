/** Read-only second-pass adversarial probes. Run: npx tsx audit/round2-semantics.ts */
import { writeFile } from "node:fs/promises"
import { Effect, Either, Layer } from "effect"
import { compileSource, observeProgram, validateObservation } from "../src/language/index.js"
import { formatLocator } from "../src/locator.js"
import { Resolvers } from "../src/resolve.js"
import type { Locator, Resolution } from "../src/domain.js"

const base = `usl "0.1"; namespace "round2";
resource a = "https://example.test/a"; resource b = "https://example.test/b"; resource extra = "https://example.test/extra";
meaning relation(left: url, right: url) = "left relates to right" grounded "kg://canonical-neo4j/sym:Concept:relation";
link chosen = relation(left: a, right: b); link ignored = relation(left: a, right: extra);`
const plan = (source = base) => Either.getOrThrow(compileSource(source))
const result = (locator: Locator): Resolution => ({ locator, resolvedLocator: formatLocator(locator), contentHash: "hash",
  resolvedAt: "2026-09-08T00:00:00.000Z", guaranteeLevel: "pure", matchCount: 1 })
const resolver = (calls: string[] = []) => Layer.succeed(Resolvers, { resolve: (locator: Locator) => {
  calls.push(formatLocator(locator)); return Effect.succeed(result(locator))
} })
type Verdict = "RESISTED" | "FINDING" | "LIMITATION"
type Row = { id: string; verdict: Verdict; severity: "none" | "low" | "medium" | "high"; expected: string; actual: string; precondition: string; source: string }
const rows: Row[] = []
const add = (row: Row) => rows.push(row)
const run = (input: unknown, options: unknown, layer: Layer.Layer<Resolvers>) => Effect.runPromise(observeProgram(input as never, options as never).pipe(Effect.provide(layer)))

const main = async () => {
  // F02: copies are made at every resolver ownership boundary. A retained result must be harmless.
  let retained: { contentHash: string } | undefined
  const mutationLayer = Layer.succeed(Resolvers, { resolve: (locator: Locator) => {
    if (locator.kind === "kg") retained!.contentHash = "mutated"
    const value = result(locator)
    if (locator.kind === "url" && locator.href.endsWith("/a")) retained = value
    return Effect.succeed(value)
  } })
  const isolated = await run(plan(), { links: ["chosen"] }, mutationLayer)
  retained!.contentHash = "post-return"
  add({ id: "f02_resolver_alias", verdict: isolated.resources[0]!.resolution!.contentHash === "hash" && Either.isRight(validateObservation(isolated)) ? "RESISTED" : "FINDING", severity: "none", expected: "Resolver-owned mutable values cannot alter the completed observation.", actual: isolated.resources[0]!.resolution!.contentHash, precondition: "resolver retains and mutates its successful result", source: "runtime.ts:67-95" })

  // F01/F09: null fields are fail-closed. A clone preserves enumerable own accessors but strips prototype properties.
  class PrototypeOptions { get links() { return ["chosen"] } get allowedLocators() { return [] } }
  const inherited = new PrototypeOptions()
  const inheritedCalls: string[] = []
  const inheritedReport = await run(plan(), inherited, resolver(inheritedCalls))
  add({ id: "prototype_option_loss", verdict: inheritedReport.readScope.links.includes("ignored") && inheritedCalls.length > 0 ? "FINDING" : "RESISTED", severity: "medium", expected: "A structurally valid options object's link/policy values are preserved or rejected.", actual: `links=${inheritedReport.readScope.links.join(",")}; calls=${inheritedCalls.length}`, precondition: "caller supplies a class instance with prototype getter links/allowedLocators", source: "runtime.ts:42-47 (structuredClone options)" })
  const nonEnumerable: Record<string, unknown> = {}
  Object.defineProperty(nonEnumerable, "links", { value: ["chosen"], enumerable: false })
  const nonEnumerableCalls: string[] = []
  const nonEnumerableReport = await run(plan(), nonEnumerable, resolver(nonEnumerableCalls))
  add({ id: "nonenumerable_option_loss", verdict: nonEnumerableReport.readScope.links.includes("ignored") ? "FINDING" : "RESISTED", severity: "low", expected: "A supplied options field is not silently dropped into all-links default.", actual: `links=${nonEnumerableReport.readScope.links.join(",")}; calls=${nonEnumerableCalls.length}`, precondition: "caller uses an own non-enumerable links property", source: "runtime.ts:42-47 (structuredClone options)" })
  let reads = 0
  const accessor = Object.defineProperty({}, "links", { enumerable: true, get: () => { reads++; return ["chosen"] } })
  const accessorCalls: string[] = []
  const accessorReport = await run(plan(), accessor, resolver(accessorCalls))
  add({ id: "accessor_option_snapshot", verdict: reads === 1 && accessorReport.readScope.links.join() === "chosen" ? "RESISTED" : "FINDING", severity: "none", expected: "An enumerable getter is read once during the snapshot.", actual: `reads=${reads}; links=${accessorReport.readScope.links.join(",")}`, precondition: "own enumerable links getter", source: "runtime.ts:42-47" })

  // Canonical policy equality disagrees with target identity: slash aliases are read twice.
  const aliases = base.replace('resource a = "https://example.test/a"; resource b = "https://example.test/b";', 'resource a = "https://example.test"; resource b = "https://example.test/";')
  const aliasBudgetCalls: string[] = []
  let aliasBudgetOutcome: string
  try { await run(plan(aliases), { links: ["chosen"], maxResources: 2 }, resolver(aliasBudgetCalls)); aliasBudgetOutcome = "unexpected success" }
  catch (error) { aliasBudgetOutcome = `${(error as { _tag?: string })._tag ?? (error as Error).name}: calls=${aliasBudgetCalls.length}` }
  const aliasCalls: string[] = []
  const aliasReport = await run(plan(aliases), { links: ["chosen"], maxResources: 3 }, resolver(aliasCalls))
  add({ id: "url_canonical_alias_double_read", verdict: aliasCalls.filter((c) => c.startsWith("https://example.test")).length === 2 && aliasBudgetCalls.length === 0 ? "FINDING" : "RESISTED", severity: "medium", expected: "URL identity should be canonicalized consistently for target deduplication, budget, and resolver calls.", actual: `maxResources=2 => ${aliasBudgetOutcome}; uniqueLocators=${aliasReport.metrics.uniqueLocators}; calls=${JSON.stringify(aliasCalls)}`, precondition: "two selected resources spell the same URL as https://host and https://host/ (two policy identities: URL + KG)", source: "runtime.ts:61-72 vs locatorKey policy normalization" })

  // A typed resolver failure is trusted as metadata. A malformed injected failure yields an emitted report that its own validator rejects.
  const malformedFailureLayer = Layer.succeed(Resolvers, { resolve: (_locator: Locator) => Effect.fail({ kind: "url", locator: "x", reason: "NOT_A_REASON", detail: "x" } as never) })
  const malformedFailure = await run(plan(), { links: ["chosen"] }, malformedFailureLayer)
  add({ id: "malformed_resolver_failure_emits_invalid_report", verdict: Either.isLeft(validateObservation(malformedFailure)) ? "FINDING" : "RESISTED", severity: "low", expected: "observeProgram either rejects malformed resolver failures or emits a schema-valid report.", actual: `validator=${Either.isLeft(validateObservation(malformedFailure)) ? "rejects output" : "accepts output"}`, precondition: "custom adapter violates the declared ResolveError failure contract", source: "runtime.ts:73-76, 101-104" })

  // A malformed public semantic plan gets an ObservationError at the boundary, not an untyped defect.
  const malformedPlan = structuredClone(plan()) as any
  malformedPlan.links[0].participants = null
  try {
    await run(malformedPlan, { links: ["chosen"] }, resolver())
    add({ id: "malformed_plan_participants", verdict: "LIMITATION", severity: "low", expected: "Known F10 boundary limitation: malformed plan fails with ObservationError.", actual: "unexpected success", precondition: "JS caller bypasses TypeScript and passes link.participants=null", source: "runtime.ts:55-59" })
  } catch (error) {
    const tag = (error as { _tag?: string })._tag
    add({ id: "malformed_plan_participants", verdict: tag === "ObservationError" ? "RESISTED" : "LIMITATION", severity: tag === "ObservationError" ? "none" : "low", expected: "Known F10 boundary limitation: malformed plan fails with ObservationError.", actual: `${(error as Error).name}: ${(error as Error).message}`, precondition: "JS caller bypasses TypeScript and passes link.participants=null", source: "runtime.ts:55-59" })
  }
  await writeFile(new URL("./round2-semantics-results.json", import.meta.url), `${JSON.stringify({ noLiveExternalIO: true, rows }, null, 2)}\n`)
  console.log(JSON.stringify(rows, null, 2))
}
void main()
