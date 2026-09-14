// Local deterministic probes; no network, resolver host, or HSWM call.
import { Effect, Either } from "effect"
import { connectUsl } from "../src/adapters.js"
import { compileSource } from "../src/language/compiler.js"
import { digestSource } from "../src/language/digest.js"
import { formatLocator } from "../src/locator.js"

const source = 'usl "0.1"; namespace "probe"; resource a = "file://host/a"; resource b = "file://host/b"; meaning relates(left: filesystem, right: filesystem) = "declared"; link l = relates(left: a, right: b);'
const plan = Either.getOrThrow(compileSource(source))
const graph = { plan, source: { adapter: "probe", digest: digestSource(source) }, identities: { resources: { a: "a", b: "b" }, links: { l: "l" } } }
const run = async (input: object) => {
  let reads = 0
  const api = connectUsl({ read: () => { reads++; return Effect.succeed(source) }, adapt: () => Either.right(graph), policy: { allowedLocators: [], maxResources: 2, maxInputBytes: 10000, maxOutputBytes: 10000 } })
  const result = await Effect.runPromise(Effect.either(api.observe({}, input as never)))
  return { reads, failed: Either.isLeft(result), error: Either.isLeft(result) ? String(result.left) : null }
}
const malformedAuthority = async () => {
  let sourceReadCalls = 0, resolverCalls = 0
  const api = connectUsl({
    read: () => { sourceReadCalls++; return Effect.succeed(source) }, adapt: () => Either.right(graph),
    policy: { allowedLocators: ["file://host/a", "file://host/b"], maxResources: 2, maxInputBytes: 10000, maxOutputBytes: 10000,
      resolvers: { resolve: (locator) => { resolverCalls++; return Effect.succeed({ locator, resolvedLocator: formatLocator(locator), contentHash: "a".repeat(64), resolvedAt: "2026-09-08T00:00:00.000Z", guaranteeLevel: "pure" as const, matchCount: 1 }) } } },
  })
  const result = await Effect.runPromise(Effect.either(api.hswm({}, {}, { policy: {}, allowed_reads: [], revision: "x" } as never)))
  return { sourceReadCalls, resolverCalls, failed: Either.isLeft(result), error: Either.isLeft(result) ? String(result.left) : null }
}
console.log(JSON.stringify({ schema: "usl-native-hswm-probe/v1", invalidObserveOptions: await run({ links: null }), malformedAuthority: await malformedAuthority(), note: "Both entries should show rejected input after the recorded IO counts." }, null, 2))
