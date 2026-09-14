/** A transient view of a source owned by another system. USL stores no copy. */
import type { SemanticPlan } from "./language/model.js"
import { Effect, Either } from "effect"
import { executeUslOperation, DEFAULT_USL_POLICY, assertJsonData, captureAdaptedGraph, preflightUslOperationInput, type UslOperationPolicy } from "./application.js"
import { digestJson, digestSource, planDigest } from "./language/digest.js"
import type { NavigationQuery } from "./language/navigation.js"
import type { ObserveOptions, ProgramObservation } from "./language/runtime.js"
import { prepareHswmAdapterArguments, validateHswmAuthority, validateHswmAuthorityForPlan, type HswmAdapterArguments } from "./integrations/hswm.js"

export interface AdaptedGraph {
  readonly plan: SemanticPlan
  readonly source: { readonly adapter: string; readonly digest: string }
  readonly identities: {
    readonly resources: Readonly<Record<string, string>>
    readonly links: Readonly<Record<string, string>>
  }
}

export interface AdapterResult<A = unknown> {
  readonly source: AdaptedGraph["source"]
  readonly identities: AdaptedGraph["identities"]
  readonly result: A
  readonly receipt: {
    readonly sourceDigest: string
    readonly planDigest: string
    readonly resultDigest: string
    readonly digest: string
  }
}

export interface UslAdapterConfig<Q, E, R, A> {
  /** Caller-owned, bounded read from an existing system. No USL storage required. */
  readonly read: (request: Q) => Effect.Effect<string, E, R>
  /** Interpret that exact response; no source re-read or endpoint IO here. */
  readonly adapt: (source: string) => Either.Either<AdaptedGraph, A>
  readonly policy?: UslOperationPolicy
}
export interface AdapterContextOptions {
  readonly compact?: boolean
  readonly maxBytes?: number
  readonly knownContextDigest?: string
}
export type AdapterObserveOptions = Omit<ObserveOptions, "sourceText">
export type HswmAuthority = Omit<HswmAdapterArguments, "plan" | "report" | "now"> & {
  /** Omit to evaluate freshness after observation. Supply for explicit replay. */
  readonly now?: number
}
const error = (failure: unknown): Error => failure instanceof Error ? failure : new Error(String(failure))
const snapshotData = <T>(value: T): T => { assertJsonData(value); return structuredClone(value) }
const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
const capturedPolicy = (policy: UslOperationPolicy): UslOperationPolicy => {
  const allowedLocators = structuredClone(policy.allowedLocators)
  const maxResources = policy.maxResources, maxInputBytes = policy.maxInputBytes, maxOutputBytes = policy.maxOutputBytes
  if (!Array.isArray(allowedLocators) || allowedLocators.some((value) => typeof value !== "string") ||
    [maxResources, maxInputBytes, maxOutputBytes].some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error("invalid adapter policy")
  const resolvers = policy.resolvers
  return Object.freeze({ allowedLocators: Object.freeze(allowedLocators), maxResources, maxInputBytes, maxOutputBytes,
    ...(resolvers === undefined ? {} : { resolvers }) })
}

/** A checksum binds the native response version to the transient view and result.
 * This is not a signature or a grant of authority. */
export const adapterResult = <T>(graph: AdaptedGraph, result: T): AdapterResult<T> => {
  const captured = snapshotData({ graph, result })
  const { source, identities, plan } = captured.graph
  const receipt = { sourceDigest: source.digest, planDigest: planDigest(plan), resultDigest: digestJson(captured.result) }
  return freeze({ source, identities, result: captured.result, receipt: { ...receipt, digest: digestJson({ source, identities, ...receipt }) } })
}

/** Bind source IO, interpretation and existing USL operations without creating a DB.
 * Every invocation asks the owner for a fresh response. An in-flight invocation
 * and its HSWM handoff share one immutable snapshot. */
export const connectUsl = <Q, E, R, A>(config: UslAdapterConfig<Q, E, R, A>) => {
  const read = config.read, adapt = config.adapt, policy = capturedPolicy(config.policy ?? DEFAULT_USL_POLICY)
  if (typeof read !== "function" || typeof adapt !== "function") throw new Error("read and adapt functions are required")
  const readSnapshot = (request: Q) => Effect.gen(function* () {
    const input = yield* Effect.try({ try: () => request === undefined ? request : snapshotData(request), catch: error })
    if (input !== undefined && Buffer.byteLength(JSON.stringify(input), "utf8") > policy.maxInputBytes) return yield* Effect.fail(new Error("adapter request exceeds maxInputBytes"))
    const reading = yield* Effect.try({ try: () => read(input), catch: error })
    const raw = yield* reading
    if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > policy.maxInputBytes) return yield* Effect.fail(new Error("adapter source exceeds maxInputBytes or is not text"))
    const converted = yield* Effect.try({ try: () => adapt(raw), catch: error })
    const graph = yield* converted
    return yield* Effect.try({ try: () => {
      const copy = captureAdaptedGraph(graph, policy.maxInputBytes)
      if (copy.source.digest !== digestSource(raw)) throw new Error("adapter digest must identify the exact native source response")
      return freeze(copy)
    }, catch: error })
  })
  const snapshot = (request: Q) => readSnapshot(request).pipe(Effect.flatMap(graph =>
    Buffer.byteLength(JSON.stringify(graph), "utf8") > policy.maxOutputBytes
      ? Effect.fail(new Error("adapter snapshot exceeds maxOutputBytes")) : Effect.succeed(graph)))
  const onSnapshot = (graph: AdaptedGraph, operation: "check" | "context" | "observe", input: object) =>
    Effect.tryPromise({ try: () => executeUslOperation(operation, { ...input, connection: "current" }, {
      ...policy, getConnection: async (id) => { if (id !== "current") throw new Error("unknown adapter connection"); return graph },
    }) as Promise<AdapterResult>, catch: error })
  const run = (operation: "check" | "context" | "observe", request: Q, input: object) => Effect.gen(function* () {
    // Capture operation options before source IO can invoke caller code.
    const captured = yield* Effect.try({ try: () => preflightUslOperationInput(operation, { ...input, connection: "current" }, policy), catch: error })
    const graph = yield* readSnapshot(request)
    return yield* onSnapshot(graph, operation, captured)
  })
  return Object.freeze({
    snapshot,
    check: (request: Q) => run("check", request, {}),
    context: (request: Q, query: NavigationQuery, options: AdapterContextOptions = {}) => Effect.gen(function* () {
      const captured = yield* Effect.try({ try: () => snapshotData(options), catch: error })
      if (!captured || typeof captured !== "object" || Array.isArray(captured) || Object.keys(captured).some(key => !["compact", "maxBytes", "knownContextDigest"].includes(key))) return yield* Effect.fail(new Error("invalid context options: only compact, maxBytes and knownContextDigest are allowed"))
      return yield* run("context", request, { ...captured, query })
    }),
    observe: (request: Q, options: AdapterObserveOptions = {}) => run("observe", request, { options }) as Effect.Effect<AdapterResult<ProgramObservation>, E | A | Error, R>,
    hswm: (request: Q, options: AdapterObserveOptions, authority: HswmAuthority) => Effect.gen(function* () {
      const captured = yield* Effect.try({ try: () => ({ options: snapshotData(options), authority: snapshotData(authority) }), catch: error })
      const preflightAuthority = yield* Effect.try({ try: () => {
        preflightUslOperationInput("observe", { options: captured.options, connection: "current" }, policy)
        if (Buffer.byteLength(JSON.stringify(captured.authority), "utf8") > policy.maxInputBytes) throw new Error("HSWM authority exceeds maxInputBytes")
        const validated = validateHswmAuthority({ ...captured.authority, now: captured.authority.now === undefined ? Date.now() / 1000 : captured.authority.now })
        if (validated.policy.source_digest !== null) throw new Error("native adapter HSWM policy source_digest must be null")
        return validated
      }, catch: error })
      const graph = yield* readSnapshot(request)
      yield* Effect.try({ try: () => validateHswmAuthorityForPlan(graph.plan, preflightAuthority, null), catch: error })
      const observation = yield* onSnapshot(graph, "observe", { options: captured.options })
      return yield* Effect.try({ try: () => {
        const prepared = prepareHswmAdapterArguments({ ...captured.authority,
          now: captured.authority.now === undefined ? Date.now() / 1000 : captured.authority.now,
          plan: graph.plan, report: observation.result as ProgramObservation })
        const result = adapterResult(graph, prepared)
        if (Buffer.byteLength(JSON.stringify(result), "utf8") > policy.maxOutputBytes) throw new Error("HSWM adapter result exceeds maxOutputBytes")
        return result
      }, catch: error })
    }),
  })
}
