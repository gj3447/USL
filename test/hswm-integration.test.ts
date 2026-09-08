import { test } from "node:test"
import assert from "node:assert/strict"
import { Effect, Either, Layer } from "effect"
import { compileSource, observeProgram } from "../src/language/index.js"
import { formatLocator } from "../src/locator.js"
import { Resolvers } from "../src/resolve.js"
import type { Locator, Resolution } from "../src/domain.js"
import { HswmIntegrationError, hswmDigest, prepareHswmAdapterArguments, type HswmObservationPolicyV2 } from "../src/integrations/hswm.js"

const source = `usl "0.1"; namespace "hswm.integration";
resource code = "https://example.test/code"; resource spec = "https://example.test/spec";
meaning implements(implementation: url, requirement: url) = "code implements spec" grounded "kg://canonical-neo4j/sym:Concept:implements"
  applies "pinned build" check review(implementation, requirement) = "compare";
link edge = implements(implementation: code, requirement: spec);`
const plan = () => Either.getOrThrow(compileSource(source))
const hash = (letter: string) => letter.repeat(64)
const layer = Layer.succeed(Resolvers, { resolve: (locator: Locator): Effect.Effect<Resolution, never> => Effect.succeed({
  locator, resolvedLocator: formatLocator(locator), contentHash: hash(locator.kind === "kg" ? "b" : "a"),
  resolvedAt: "2026-09-08T00:00:00.000Z", guaranteeLevel: "pure", matchCount: 1,
}) })
const observe = async (text = source) => {
  const compiled = Either.getOrThrow(compileSource(text))
  return Effect.runPromise(observeProgram(compiled, { links: ["edge"], sourceText: text }).pipe(Effect.provide(layer)))
}
const policyFor = (compiled: ReturnType<typeof plan>, report: Awaited<ReturnType<typeof observe>>): HswmObservationPolicyV2 => ({
  schema_version: "hswm-usl-observation-policy/v2", namespace: compiled.namespace, plan_digest: hswmDigest(compiled),
  usl_plan_digest: report.planDigest, source_digest: report.sourceDigest, max_age_seconds: 60,
  bindings: [{ link: "edge", role: "hswm_reference", field: "resolves" }],
  resources: [
    ...report.resources.map((row) => ({ name: row.name, content_hash: row.resolution!.contentHash, resolved_locator: row.resolution!.resolvedLocator })),
    ...report.groundings.map((row) => ({ name: `meaning:${row.name}`, content_hash: row.resolution!.contentHash, resolved_locator: row.resolution!.resolvedLocator })),
  ],
})

test("prepares deep-copied, exact HSWM v2 adapter arguments without creating authority", async () => {
  const compiled = plan(), report = await observe(), policy = policyFor(compiled, report)
  const prepared = prepareHswmAdapterArguments({ plan: compiled, report, policy, allowed_reads: [["hswm_reference", "resolves"]], now: 1_789_000_000, revision: "game-flow-1" })
  assert.equal(prepared.policy.schema_version, "hswm-usl-observation-policy/v2")
  assert.equal(prepared.policy.plan_digest, hswmDigest(prepared.plan))
  assert.deepEqual(prepared.allowed_reads, [["hswm_reference", "resolves"]])
  assert.notEqual(prepared.plan, compiled); assert.notEqual(prepared.report, report); assert.notEqual(prepared.policy, policy)
  ;(policy.resources[0]! as { content_hash: string }).content_hash = hash("f")
  assert.equal(prepared.policy.resources[0]!.content_hash, hash("a"))
  assert.equal(report.semanticTruth, "NOT_EVALUATED")
})

test("requires caller authorization and independent exact pins; never derives either from the report", async () => {
  const compiled = plan(), report = await observe(), policy = policyFor(compiled, report)
  const base = { plan: compiled, report, policy, allowed_reads: [] as Array<readonly [string, string]>, now: 1_789_000_000, revision: "r" }
  assert.throws(() => prepareHswmAdapterArguments(base), HswmIntegrationError)
  const badPin = structuredClone(policy) as HswmObservationPolicyV2; (badPin.resources[0]! as { content_hash: string }).content_hash = hash("f")
  const pinnedForConsumer = prepareHswmAdapterArguments({ ...base, policy: badPin, allowed_reads: [["hswm_reference", "resolves"]] })
  assert.equal(pinnedForConsumer.policy.resources[0]!.content_hash, hash("f"))
  const stale = structuredClone(policy) as HswmObservationPolicyV2; (stale as { source_digest: string | null }).source_digest = `sha256:${hash("f")}`
  assert.throws(() => prepareHswmAdapterArguments({ ...base, policy: stale, allowed_reads: [["hswm_reference", "resolves"]] }), HswmIntegrationError)
})

test("rejects canonical URL aliases that the current HSWM v2 validator cannot consume", async () => {
  const aliases = source.replace('resource code = "https://example.test/code"; resource spec = "https://example.test/spec";', 'resource code = "https://example.test"; resource spec = "https://example.test/";')
  const compiled = Either.getOrThrow(compileSource(aliases)), report = await observe(aliases), policy = policyFor(compiled, report)
  assert.throws(() => prepareHswmAdapterArguments({ plan: compiled, report, policy, allowed_reads: [["hswm_reference", "resolves"]], now: 1_789_000_000, revision: "r" }), /canonical locator aliases/)
})
