import { Data, Effect, Either, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { formatLocator, parseLocator } from "../locator.js"
import type { Locator, Resolution } from "../domain.js"
import { locatorKey, Resolvers, ResolveError } from "../resolve.js"
import { compileSource } from "./compiler.js"
import { digestJson, digestSource, linkContractDigest, planDigest } from "./digest.js"
import type { SemanticPlan } from "./model.js"
import { ResolutionSchema, ResolveFailureSchema } from "./observation-schema.js"

export class ObservationError extends Data.TaggedError("ObservationError")<{
  readonly detail: string
}> { get message() { return this.detail } }

export interface ResourceObservation {
  readonly name: string
  readonly locator: string
  readonly fingerprintScope: "KG_METADATA" | "RESOLVER_REPRESENTATION"
  readonly status: "RESOLVES" | "ORPHAN" | "AMBIGUOUS" | "DENIED"
  readonly resolution: Resolution | null
  readonly issue: { readonly reason: ResolveError["reason"]; readonly detail: string } | null
}
export interface ObserveOptions {
  /** Omitted: all declared links. Unused resources/meanings are never resolved. */
  readonly links?: ReadonlyArray<string>
  /** Omitted: exact selected participant and grounding locators. Empty: deny every read. */
  readonly allowedLocators?: ReadonlyArray<string>
  /** Maximum distinct requested locators, including groundings; checked before any IO. */
  readonly maxResources?: number
  /** When provided, must compile to this plan; preserves exact original source identity. */
  readonly sourceText?: string
}

// Reachability and evidence availability never execute or prove authored checks.
export const observeProgram = (inputPlan: SemanticPlan, options: ObserveOptions = {}) => Effect.gen(function* () {
  const fail = (detail: string) => new ObservationError({ detail })
  // Read caller-owned data once, before selecting or resolving any resources.
  const { plan, settings } = yield* Effect.try({
    try: () => {
      if (!inputPlan || typeof inputPlan !== "object" || !Array.isArray(inputPlan.links) || !Array.isArray(inputPlan.resources) || !Array.isArray(inputPlan.meanings)) throw fail("a semantic plan is required")
      if (!options || typeof options !== "object" || Array.isArray(options)) throw fail("observation options must be an object")
      const plan = structuredClone(inputPlan)
      // Read known fields, including inherited/getter/non-enumerable properties.
      // Clone each array immediately: a later getter can mutate an earlier value.
      const settings = {
        links: structuredClone(options.links),
        allowedLocators: structuredClone(options.allowedLocators),
        maxResources: options.maxResources,
        sourceText: options.sourceText,
      }
      return { plan, settings }
    },
    catch: (e) => e instanceof ObservationError ? e : fail(`cannot snapshot observation input: ${String(e)}`),
  })
  const sourceText = settings.sourceText
  const originalDigest = planDigest(plan)
  if (sourceText !== undefined) {
    if (typeof sourceText !== "string") return yield* fail("sourceText must be a string")
    const source = compileSource(sourceText)
    if (Either.isLeft(source) || planDigest(source.right) !== originalDigest) return yield* fail("sourceText does not compile to the supplied plan")
  }
  const names = settings.links === undefined ? plan.links.map((l) => l.name) : settings.links
  if (!Array.isArray(names) || names.some((name) => !plan.links.some((l) => l.name === name))) return yield* fail("observation selection contains an unknown link")
  const selectedNames = new Set(names)
  const selectedLinks = plan.links.filter((l) => selectedNames.has(l.name))
  const resourceNames = new Set(selectedLinks.flatMap((l) => l.participants.map((p) => p.resource)))
  const meaningNames = new Set(selectedLinks.map((l) => l.meaning))
  const selectedResources = plan.resources.filter((r) => resourceNames.has(r.name))
  const selectedMeanings = plan.meanings.filter((m) => meaningNames.has(m.name))
  const targets = new Map<string, Locator>()
  const addTarget = (locator: Locator) => {
    const key = locatorKey(locator)
    // Retain the first authored locator as the actual request for this identity.
    if (!targets.has(key)) targets.set(key, locator)
  }
  for (const r of selectedResources) addTarget(r.locator)
  for (const m of selectedMeanings) if (m.grounded) addTarget(m.grounded)
  const resourceBudget = settings.maxResources === undefined ? 256 : settings.maxResources
  if (!Number.isSafeInteger(resourceBudget) || resourceBudget < 0) return yield* fail("maxResources must be a nonnegative safe integer")
  if (targets.size > resourceBudget) return yield* fail(`observation needs ${targets.size} locators, exceeding maxResources=${resourceBudget}`)
  const allowed = settings.allowedLocators === undefined ? [...targets.keys()] : settings.allowedLocators
  if (!Array.isArray(allowed) || allowed.some((l) => typeof l !== "string" || Either.isLeft(parseLocator(l)))) return yield* fail("allowedLocators must contain valid locators")
  const allowedLocators = [...new Set(allowed.map((l) => locatorKey(Either.getOrThrow(parseLocator(l)))))].sort()
  const permission = new Set(allowedLocators)
  const locators = [...targets.values()].filter((l) => permission.has(locatorKey(l)))
  const resolvers = yield* Resolvers
  const results = yield* Effect.all(locators.map((l) =>
    // Defer invocation too: constructing a later resolver effect may mutate an earlier result.
    Effect.suspend(() => resolvers.resolve(structuredClone(l), { allowedLocators: [...allowedLocators] })).pipe(
      Effect.either,
      Effect.flatMap((result) => Effect.try({
        try: () => Either.match(result, {
          onLeft: (e) => {
            // Error subclasses may keep fields on their prototype; copy the
            // metadata explicitly, then validate it just like a successful reply.
            const copy = { kind: e.kind, locator: e.locator, reason: e.reason, detail: e.detail }
            const decoded = Schema.decodeUnknownEither(ResolveFailureSchema)(copy)
            if (Either.isLeft(decoded)) throw fail(`invalid resolver failure: ${decoded.left.message}`)
            if (copy.kind !== l.kind || copy.locator !== formatLocator(l)) throw fail("resolver failure differs from requested locator")
            return Either.left(new ResolveError(copy))
          },
          onRight: (resolution) => {
            // Snapshot each completion before waiting for any other endpoint.
            const copy = structuredClone(resolution)
            const decoded = Schema.decodeUnknownEither(ResolutionSchema)(copy, { onExcessProperty: "error" })
            if (Either.isLeft(decoded)) throw fail(`invalid resolver response: ${decoded.left.message}`)
            if (!isDeepStrictEqual(copy.locator, l)) throw fail("resolver response differs from requested locator")
            const resolved = parseLocator(copy.resolvedLocator)
            if (Either.isLeft(resolved) || formatLocator(resolved.right) !== copy.resolvedLocator || resolved.right.kind !== l.kind) throw fail("invalid resolved locator")
            if (l.kind === "kg" && !isDeepStrictEqual(resolved.right, l)) throw fail("resolved KG identity differs from requested identity")
            if ((l.kind === "url" || l.kind === "filesystem") && !permission.has(locatorKey(resolved.right))) throw fail("resolved address is outside allowed read scope")
            return Either.right(copy)
          },
        }),
        catch: (e) => e instanceof ObservationError ? e : fail(`cannot snapshot resolver response: ${String(e)}`),
      })),
    )), { concurrency: 4 })
  const byLocator = new Map(locators.map((l, i) => [locatorKey(l), results[i]!]))
  const observation = (name: string, locator: Locator): ResourceObservation => {
    const base = { name, locator: formatLocator(locator), fingerprintScope: locator.kind === "kg" ? "KG_METADATA" as const : "RESOLVER_REPRESENTATION" as const }
    const result = byLocator.get(locatorKey(locator))
    if (!result) return { ...base, status: "DENIED", resolution: null, issue: { reason: "DENIED", detail: "locator is outside the observation allowlist" } }
    return Either.match(result, {
      onLeft: (e) => ({ ...base, status: e.reason === "ORPHAN" ? "ORPHAN" : e.reason === "DENIED" ? "DENIED" : "AMBIGUOUS", resolution: null, issue: { reason: e.reason, detail: e.detail } }),
      onRight: (resolution) => ({ ...base, status: resolution.matchCount === 1 ? "RESOLVES" : "AMBIGUOUS", resolution, issue: resolution.matchCount === 1 ? null : { reason: "AMBIGUOUS", detail: "endpoint is not unique" } }),
    })
  }
  const resources = selectedResources.map((r) => observation(r.name, r.locator))
  const groundings = selectedMeanings.flatMap((m) => m.grounded ? [observation(m.name, m.grounded)] : [])
  const meanings = selectedMeanings.map((m) => ({ name: m.name, digest: digestJson(m), definition: m }))
  const links = selectedLinks.map((l) => {
    const meaning = selectedMeanings.find((m) => m.name === l.meaning)!
    return { ...l, meaningDigest: digestJson(meaning), contractDigest: linkContractDigest(meaning),
      resourcesResolve: l.participants.every((p) => resources.find((r) => r.name === p.resource)?.status === "RESOLVES"), semanticTruth: "NOT_EVALUATED" as const,
      verification: (meaning.contract?.checks ?? []).map((check) => {
        const evidence = check.evidenceRoles.map((role) => ({ role, resource: l.participants.find((p) => p.role === role)!.resource }))
        return { ...check, scope: meaning.contract!.scope, evidence, evidenceAvailable: evidence.every((p) => resources.find((r) => r.name === p.resource)?.status === "RESOLVES"), status: "NOT_EXECUTED" as const }
      }) }
  })
  const report = { schema: "usl-program-observation/v2" as const, namespace: plan.namespace,
    planDigest: originalDigest, meaningsDigest: digestJson(plan.meanings), sourceDigest: sourceText === undefined ? null : digestSource(sourceText),
    digestFormat: "sha256:utf8:JSON.stringify/v1" as const,
    status: resources.every((r) => r.status === "RESOLVES") && groundings.every((r) => r.status === "RESOLVES") ? "RESOLVES" as const : "UNRESOLVED" as const,
    readScope: { links: selectedLinks.map((l) => l.name), allowedLocators, requestedLocators: [...targets.values()].map(formatLocator), resourceBudget },
    metrics: { declaredResources: plan.resources.length, selectedResources: resources.length, uniqueLocators: targets.size, resolverCalls: locators.length,
      deniedLocators: new Set([...resources, ...groundings].filter((r) => r.status === "DENIED").map((r) => locatorKey(Either.getOrThrow(parseLocator(r.locator))))).size },
    resources, groundings, meanings, links, semanticTruth: "NOT_EVALUATED" as const }
  return { ...report, observationDigest: digestJson(report) }
})
export type ProgramObservation = Effect.Effect.Success<ReturnType<typeof observeProgram>>
