// Read-only adversarial probes. Deliberate malformed inputs stay outside test/.
import { Effect, Either } from "effect"
import { connectUsl, adapterResult } from "../src/adapters.js"
import { adaptPropertyGraph } from "../src/integrations/property-graph.js"
import { DEFAULT_USL_POLICY, executeUslOperation } from "../src/application.js"
import { compareObservations } from "../src/language/comparison.js"
import { digestJson } from "../src/language/digest.js"
import { formatLocator } from "../src/locator.js"

const native = {
  nodes: [{ uid: "a", properties: { locator: "file://fixture/a" } }, { uid: "b", properties: { locator: "file://fixture/b" } }],
  relations: [{ uid: "edge", from_uid: "a", to_uid: "b", type: "BEFORE", properties: {
    participants: [{ role: "first", uid: "a" }, { role: "second", uid: "b" }],
  } }],
}
const raw = JSON.stringify(native)
const adapt = (text: string) => adaptPropertyGraph(text, { namespace: "adversarial.native" })
const graph = Either.getOrThrow(adapt(raw))
const usl = connectUsl({ read: () => Effect.succeed(raw), adapt })

const originalQuery = { focus: "a", target: "b", maxHops: 0 }
const limited = await Effect.runPromise(usl.context(undefined, originalQuery))
const overridden = await Effect.runPromise(usl.context(undefined, originalQuery, { query: { ...originalQuery, maxHops: 2 } } as any))

const callerOwnedResult = { status: "UNRESOLVED", evidence: [] as string[] }
const envelope = adapterResult(graph, callerOwnedResult)
const receiptInitiallyValid = envelope.receipt.resultDigest === digestJson(envelope.result)
callerOwnedResult.status = "READY"
callerOwnedResult.evidence.push("mutated after receipt returned")

const malformedGraph = { ...graph, identities: { resources: {}, links: {} } }
const inconsistent = connectUsl({ read: () => Effect.succeed(raw), adapt: () => Either.right(malformedGraph), policy: { ...DEFAULT_USL_POLICY, maxOutputBytes: 1 } })
const snapshot = await Effect.runPromise(inconsistent.snapshot(undefined))
let checkError = ""
try { await Effect.runPromise(inconsistent.check(undefined)) } catch (failure) { checkError = String(failure) }

const reversed = structuredClone(native)
reversed.relations[0]!.from_uid = "b"
reversed.relations[0]!.to_uid = "a"
const reversedGraph = Either.getOrThrow(adapt(JSON.stringify(reversed)))
const observe = (input: typeof graph) => executeUslOperation("observe", { connection: "fixed", options: { links: ["edge"] } }, {
  ...DEFAULT_USL_POLICY, getConnection: async () => input,
  allowedLocators: input.plan.resources.map(resource => formatLocator(resource.locator)),
  // Isolated deterministic resolver fixture; no endpoint is actually accessed.
  resolvers: { resolve: locator => Effect.succeed({ locator, resolvedLocator: formatLocator(locator), contentHash: "a".repeat(64), resolvedAt: "2026-09-08T00:00:00.000Z", guaranteeLevel: "pure", matchCount: 1 }) },
})
const before: any = await observe(graph), after: any = await observe(reversedGraph)
const comparison = Either.getOrThrow(compareObservations(before.result, after.result))
const reordered = structuredClone(native)
reordered.relations[0]!.properties.participants.reverse()
const reorderedObservation: any = await observe(Either.getOrThrow(adapt(JSON.stringify(reordered))))
const orderingComparison = Either.getOrThrow(compareObservations(before.result, reorderedObservation.result))
const described = structuredClone(native) as any
described.relations[0].properties.description = "original description"
const encodedType = structuredClone(native) as any
encodedType.relations[0].type = JSON.stringify({ type: native.relations[0]!.type, description: "original description" })
const descriptionA = Either.getOrThrow(adapt(JSON.stringify(described)))
const descriptionB = Either.getOrThrow(adapt(JSON.stringify(encodedType)))
console.log(JSON.stringify({
  contextOptionsOverride: { originalQuery, limitedStatus: (limited.result as any).target.status,
    overwrittenStatus: (overridden.result as any).target.status,
    effectiveLimitsBefore: (limited.result as any).coverage.limits, effectiveLimitsAfter: (overridden.result as any).coverage.limits },
  receiptAliasing: { receiptInitiallyValid, callerMutationChangedReturnedResult: envelope.result.status === "READY",
    receiptValidAfterMutation: envelope.receipt.resultDigest === digestJson(envelope.result) },
  snapshotValidation: { acceptedInvalidIdentities: snapshot.identities, outputBytes: Buffer.byteLength(JSON.stringify(snapshot)), maxOutputBytes: 1, checkError },
  directionReversal: { sourceDigestChanged: before.source.digest !== after.source.digest,
    samePlanDigest: before.result.planDigest === after.result.planDigest,
    sameMeaningsDigest: before.result.meaningsDigest === after.result.meaningsDigest,
    versions: [before, after].map(value => ({ sourceDigest: value.source.digest,
      planDigest: value.result.planDigest, meaningsDigest: value.result.meaningsDigest,
      status: value.result.status })), comparison },
  participantReordering: { sameRoleBindings: true, comparison: orderingComparison },
  relationDescriptionCollision: { sourceDigestChanged: descriptionA.source.digest !== descriptionB.source.digest,
    samePlan: digestJson(descriptionA.plan) === digestJson(descriptionB.plan),
    sourceDigests: [descriptionA.source.digest, descriptionB.source.digest],
    renderedDescriptions: [descriptionA.plan.meanings[0]!.description, descriptionB.plan.meanings[0]!.description] },
}, null, 2))
