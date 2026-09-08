/**
 * Read-only adversarial probes for USL's language observation boundary.
 * Uses injected resolvers only; it never invokes live resolver implementations.
 * Run: npx tsx audit/semantic-probes.ts
 */
import { writeFile } from "node:fs/promises"
import { Effect, Either, Layer } from "effect"
import { compareObservations, compileProgram, compileSource, digestJson, observeProgram, parseProgram, validateObservation } from "../src/language/index.js"
import { formatLocator } from "../src/locator.js"
import { Resolvers, type ResolveError } from "../src/resolve.js"
import type { Locator, Resolution } from "../src/domain.js"

const source = `usl "0.1";
namespace "audit.semantic";
resource a = "https://example.test/a";
resource b = "https://example.test/b";
resource unused = "https://example.test/unused";
meaning implements(left: url, right: url) = "left implements right" grounded "kg://canonical-neo4j/sym:Concept:implements"
  applies "pinned game build"
  check review(left, right) = "compare both assets";
link selected = implements(left: a, right: b);`

const plan = Either.getOrThrow(compileSource(source))
const hash = (label: string) => `sha256:${label.padEnd(64, "0").slice(0, 64)}`
const resolution = (locator: Locator, contentHash = hash("stable")): Resolution => ({
  locator, resolvedLocator: formatLocator(locator), contentHash,
  resolvedAt: "2026-09-08T00:00:00.000Z", guaranteeLevel: "pure", matchCount: 1,
})
const normalLayer = (calls: string[] = []) => Layer.succeed(Resolvers, {
  resolve: (locator: Locator): Effect.Effect<Resolution, ResolveError> => {
    calls.push(formatLocator(locator)); return Effect.succeed(resolution(locator))
  },
})
const observe = (layer = normalLayer(), options: object = { links: ["selected"] }) =>
  Effect.runPromise(observeProgram(plan, options as never).pipe(Effect.provide(layer)))
const observeText = (text: string) => Effect.runPromise(observeProgram(Either.getOrThrow(compileSource(text)), { links: ["selected"] }).pipe(Effect.provide(normalLayer())))
const rewrite = (report: any, edit: (copy: any) => void) => {
  const copy = structuredClone(report); edit(copy)
  const { observationDigest: _old, ...payload } = copy
  copy.observationDigest = digestJson(payload)
  return copy
}
const validates = (input: unknown) => Either.isRight(validateObservation(input))
type Result = { id: string; expected: string; actual: string; verdict: "RESISTED" | "FINDING" | "LIMITATION"; severity: "none" | "low" | "medium" | "high"; reproduction: string }
const results: Result[] = []
const record = (id: string, expected: string, actual: string, verdict: Result["verdict"], severity: Result["severity"], reproduction: string) =>
  results.push({ id, expected, actual, verdict, severity, reproduction })

const main = async () => {
  const baseline = await observe()
  record("baseline_validates", "A generated v2 report validates.", String(validates(baseline)), validates(baseline) ? "RESISTED" : "FINDING", validates(baseline) ? "none" : "high", "observe injected stable resolver")

  const calls: string[] = []
  await observe(normalLayer(calls))
  const selectedOnly = calls.sort().join(",") === ["https://example.test/a", "https://example.test/b", "kg://canonical-neo4j/sym:Concept:implements"].sort().join(",")
  record("selected_reads_only", "Only selected participants and grounding are resolved.", JSON.stringify(calls.sort()), selectedOnly ? "RESISTED" : "FINDING", selectedOnly ? "none" : "high", "observe({links:['selected']}); inspect fake-resolver calls")

  const deniedCalls: string[] = []
  const denied = await observe(normalLayer(deniedCalls), { links: ["selected"], allowedLocators: [] })
  const denySafe = deniedCalls.length === 0 && denied.resources.every((r) => r.status === "DENIED")
  record("allowlist_denies_before_io", "An empty allowlist makes zero resolver calls.", `calls=${deniedCalls.length}; statuses=${denied.resources.map((r) => r.status).join(",")}`, denySafe ? "RESISTED" : "FINDING", denySafe ? "none" : "high", "observe({allowedLocators:[]})")

  const nullAllowCalls: string[] = []
  const nullAllow = await observe(normalLayer(nullAllowCalls), { links: ["selected"], allowedLocators: null } as never)
  record("null_allowed_locators_defaults", "An explicitly supplied non-array allowlist is rejected before IO.", `completed=${nullAllow.status}; calls=${nullAllowCalls.length}`, "FINDING", "medium", "observeProgram(plan,{allowedLocators:null} as any)")
  const allLinksSource = source.replace('link selected = implements(left: a, right: b);', 'link selected = implements(left: a, right: b); link extra = implements(left: a, right: unused);')
  const allLinksCalls: string[] = []
  const allLinksPlan = Either.getOrThrow(compileSource(allLinksSource))
  const nullLinks = await Effect.runPromise(observeProgram(allLinksPlan, { links: null } as never).pipe(Effect.provide(normalLayer(allLinksCalls))))
  record("null_links_defaults_to_all", "An explicitly supplied non-array link selection is rejected before IO.", `links=${nullLinks.readScope.links.join(",")}; calls=${allLinksCalls.length}`, "FINDING", "high", "observeProgram(twoLinkPlan,{links:null} as any): reads extra link/resource")
  const nullBudgetCalls: string[] = []
  const nullBudget = await observe(normalLayer(nullBudgetCalls), { links: ["selected"], maxResources: null } as never)
  record("null_resource_budget_defaults", "An explicitly supplied non-number budget is rejected before IO.", `completed=${nullBudget.status}; calls=${nullBudgetCalls.length}; budget=${nullBudget.readScope.resourceBudget}`, "FINDING", "medium", "observeProgram(plan,{maxResources:null} as any)")

  const original = source
  let release!: () => void
  let begun!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { begun = resolve })
  const delayed = Layer.succeed(Resolvers, { resolve: (locator: Locator): Effect.Effect<Resolution, ResolveError> =>
    Effect.sync(() => begun()).pipe(Effect.zipRight(Effect.promise(() => gate)), Effect.as(resolution(locator))),
  })
  const mutableOptions: { links: string[]; sourceText?: string } = { links: ["selected"], sourceText: original }
  const pending = observe(delayed, mutableOptions)
  await started; mutableOptions.sourceText = original.replace("left implements right", "right implements left"); release()
  const sourceFrozen = (await pending).sourceDigest === (await import("../src/language/digest.js")).digestSource(original)
  record("source_text_frozen", "sourceText digest stays bound to its start value.", String(sourceFrozen), sourceFrozen ? "RESISTED" : "FINDING", sourceFrozen ? "none" : "high", "mutate options.sourceText while resolver is gated")

  const keywordIdentifier = `usl "0.1"; namespace "keywords";
resource check = "https://example.test/a";
resource applies = "https://example.test/b";
meaning relation(left: url, right: url) = "a relation" applies "scope" check applies(left, right) = "proof";
link grounded = relation(left: check, right: applies);`
  const keywordSafe = Either.isRight(compileSource(keywordIdentifier))
  const duplicateClause = Either.isLeft(parseProgram(source.replace('applies "pinned game build"', 'applies "one" applies "two"')))
  record("parser_keyword_and_clause_boundary", "Keywords can be identifiers in their unambiguous position and duplicate clauses are rejected.", `keywordProgram=${keywordSafe}; duplicateAppliesRejected=${duplicateClause}`, keywordSafe && duplicateClause ? "RESISTED" : "FINDING", keywordSafe && duplicateClause ? "none" : "medium", "compile keyword-named declarations/check; parse duplicate applies clause")

  const address = await observeText(source.replace('resource b = "https://example.test/b"', 'resource b = "https://example.test/moved"'))
  const semantic = await observeText(source.replace("left implements right", "right implements left"))
  const addressComparison = Either.getOrThrow(compareObservations(baseline, address)).links[0]!
  const semanticComparison = Either.getOrThrow(compareObservations(baseline, semantic)).links[0]!
  const channelsSeparated = addressComparison.addressChanged.includes("right") && addressComparison.contentChanged.length === 0 && addressComparison.semanticContractChanged === false && semanticComparison.addressChanged.length === 0 && semanticComparison.contentChanged.length === 0 && semanticComparison.semanticContractChanged === true
  record("comparison_change_channels", "Address-only and contract-only edits are classified into separate channels.", `address=${JSON.stringify(addressComparison.actions)}; semantic=${JSON.stringify(semanticComparison.actions)}`, channelsSeparated ? "RESISTED" : "FINDING", channelsSeparated ? "none" : "high", "compare URL rebinding and reversed meaning description against stable baseline")

  let first: Resolution | undefined
  const mutableLayer = Layer.succeed(Resolvers, { resolve: (locator: Locator): Effect.Effect<Resolution, ResolveError> => {
    if (locator.kind === "url" && locator.href.endsWith("/a")) { first = resolution(locator, hash("before")); return Effect.succeed(first) }
    if (locator.kind === "kg") return Effect.sync(() => { first!.contentHash = hash("after"); return resolution(locator) })
    return Effect.succeed(resolution(locator))
  } })
  const mixed = await observe(mutableLayer)
  const mixedHash = mixed.resources.find((r) => r.name === "a")!.resolution!.contentHash
  record("mutable_resolver_result_before_assembly", "Resolution fields are snapshotted when each resolver result succeeds.", `resource a contentHash=${mixedHash}`, mixedHash === hash("before") ? "RESISTED" : "FINDING", mixedHash === hash("after") ? "high" : "none", "resolver returns a result for a; later grounding resolver mutates that same result object")
  first!.contentHash = hash("post_return")
  const postReturnHash = mixed.resources.find((r) => r.name === "a")!.resolution!.contentHash
  record("mutable_resolver_result_after_return", "Returned observation is detached from resolver-owned result objects.", `resource a contentHash=${postReturnHash}; validates=${validates(mixed)}`, postReturnHash === hash("after") ? "RESISTED" : "FINDING", postReturnHash === hash("post_return") ? "high" : "none", "mutate resolver-retained result after observeProgram resolves")

  const forgedKg = rewrite(baseline, (x) => { x.groundings[0].resolution.resolvedLocator = "kg://canonical-neo4j/sym:Concept:other" })
  record("forged_kg_redirect", "A KG resolution may only resolve to the requested KG identity (as resolveKg enforces).", `validates=${validates(forgedKg)}`, validates(forgedKg) ? "FINDING" : "RESISTED", validates(forgedKg) ? "medium" : "none", "change groundings[0].resolution.resolvedLocator; recompute observationDigest")

  const zeroMatches = rewrite(baseline, (x) => {
    const r = x.resources.find((entry: any) => entry.name === "a")
    r.resolution.matchCount = 0; r.status = "AMBIGUOUS"; r.issue = { reason: "AMBIGUOUS", detail: "zero matches" }
    x.links[0].resourcesResolve = false; x.links[0].verification[0].evidenceAvailable = false; x.status = "UNRESOLVED"
  })
  record("zero_match_resolution", "Current runtime deliberately treats every non-1 match count, including zero, as AMBIGUOUS.", `validates=${validates(zeroMatches)}`, validates(zeroMatches) ? "LIMITATION" : "RESISTED", "low", "set resolution.matchCount=0 with internally consistent AMBIGUOUS fields; recompute digest")

  const opaqueDigests = rewrite(baseline, (x) => {
    x.planDigest = `sha256:${"a".repeat(64)}`; x.meaningsDigest = `sha256:${"b".repeat(64)}`; x.sourceDigest = `sha256:${"c".repeat(64)}`
  })
  record("opaque_origin_digests", "Origin digests would need source/complete-plan material or a signature to be independently checked.", `validates=${validates(opaqueDigests)}`, validates(opaqueDigests) ? "LIMITATION" : "RESISTED", "low", "replace planDigest, meaningsDigest, sourceDigest; recompute outer digest")

  const badProgram = compileProgram({ languageVersion: "0.1", namespace: "x", declarations: null as never } as never)
  record("malformed_compile_program", "Malformed public input fails as LanguageError instead of throwing.", `Either.isLeft=${Either.isLeft(badProgram)}`, Either.isLeft(badProgram) ? "RESISTED" : "FINDING", Either.isLeft(badProgram) ? "none" : "medium", "compileProgram({declarations:null} as any)")
  try { await Effect.runPromise(observeProgram(null as never))
    record("null_observe_plan", "Malformed public input yields ObservationError.", "unexpected success", "FINDING", "low", "observeProgram(null as any)")
  } catch (error) {
    const typed = (error as { _tag?: string })._tag === "ObservationError"
    record("null_observe_plan", "Malformed public input yields ObservationError.", `${(error as Error).name}: ${(error as Error).message}`, typed ? "RESISTED" : "FINDING", typed ? "none" : "low", "observeProgram(null as any)")
  }
  try { await observe(normalLayer(), null as never)
    record("null_observe_options", "Malformed options yield ObservationError.", "unexpected success", "FINDING", "low", "observeProgram(plan, null as any)")
  } catch (error) {
    const typed = (error as { _tag?: string })._tag === "ObservationError"
    record("null_observe_options", "Malformed options yield ObservationError.", `${(error as Error).name}: ${(error as Error).message}`, typed ? "RESISTED" : "FINDING", typed ? "none" : "low", "observeProgram(plan, null as any)")
  }
  await writeFile(new URL("./semantic-results.json", import.meta.url), `${JSON.stringify({ generatedAt: new Date().toISOString(), noLiveExternalIO: true, results }, null, 2)}\n`)
  console.log(JSON.stringify(results, null, 2))
}
void main()
