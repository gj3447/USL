/** Shared CLI/MCP application boundary. No filesystem paths, writes or command execution. */
import { Effect, Either, Layer } from "effect"
import { ConfigLive, Resolvers, ResolversLive, locatorKey } from "./resolve.js"
import type { Locator, Resolution } from "./domain.js"
import type { ResolveError, ResolverOptions } from "./resolve.js"
import { parseLocator } from "./locator.js"
import { compileSource, agentContext, compactAgentContext, observeProgram, compareObservations,
  validateObservation, planDigest, digestSource, digestJson, toSemanticBundle, composePlans } from "./language/index.js"
import type { AdaptedGraph, AdapterResult } from "./adapters.js"
import type { SemanticPlan, NavigationQuery, ObserveOptions, SemanticProjectionOptions } from "./language/index.js"
import { parseGraphEngineeringSource, toGraphEngineeringPlan } from "./integrations/graph-engineering.js"
import type { GraphEngineeringBindings } from "./integrations/graph-engineering.js"
import { prepareHswmAdapterArguments } from "./integrations/hswm.js"
import type { HswmAdapterArguments } from "./integrations/hswm.js"

export const USL_OPERATIONS = ["check", "compile", "context", "observe", "compare", "validate_observation", "graph_import", "hswm_prepare", "project"] as const
export type UslOperation = typeof USL_OPERATIONS[number]
export interface UslProgramSnapshot { readonly source: string; readonly plan: SemanticPlan }
export interface UslOperationPolicy {
  readonly allowedLocators: ReadonlyArray<string>
  readonly maxResources: number
  readonly maxInputBytes: number
  readonly maxOutputBytes: number
  readonly resolvers?: { readonly resolve: (locator: Locator, options?: ResolverOptions) => Effect.Effect<Resolution, ResolveError> }
  /** An administrator-owned name lookup; never interprets a client ID as a filesystem path. */
  readonly getProgram?: (id: string) => Promise<UslProgramSnapshot>
  readonly getConnection?: (id: string) => Promise<AdaptedGraph>
}
export const DEFAULT_USL_POLICY: UslOperationPolicy = Object.freeze({ allowedLocators: Object.freeze([]), maxResources: 64, maxInputBytes: 1024 * 1024, maxOutputBytes: 1024 * 1024 })
export class UslApplicationError extends Error { readonly _tag = "UslApplicationError" }
const fail = (message: string): never => { throw new UslApplicationError(message) }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const record = (value: unknown, label: string) => object(value) ? value : fail(`${label} must be an object`)
const string = (value: unknown, label: string) => typeof value === "string" && value.length > 0 ? value : fail(`${label} must be a nonempty string`)
const integer = (value: unknown, label: string) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fail(`${label} must be a nonnegative safe integer`)
const unwrap = <A, E>(result: Either.Either<A, E>): A => Either.getOrThrowWith(result, (e) => e)
const fields = (value: Record<string, unknown>, allowed: ReadonlyArray<string>) => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`unknown input field: ${key}`)
}
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8")
const normalizeLocator = (value: unknown) => locatorKey(unwrap(parseLocator(string(value, "allowed locator"))))

// This boundary accepts JSON data. Reject options that JSON/structuredClone
// would silently erase (inherited limits, accessors, sparse arrays, undefined).
const assertJsonData = (value: unknown, ancestors = new Set<object>()): void => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return
  if (typeof value === "number" && Number.isFinite(value)) return
  if (typeof value !== "object" || value === null) fail("input must contain JSON data only")
  const item = value as object
  const prototype = Object.getPrototypeOf(item)
  if (Array.isArray(item) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail("input must use plain JSON objects; inherited options are not supported")
  if (ancestors.has(item)) fail("input must not contain cycles")
  ancestors.add(item)
  const descriptors = Object.getOwnPropertyDescriptors(item)
  if (Array.isArray(item) && Object.keys(descriptors).length !== item.length + 1) fail("input arrays must be dense JSON arrays")
  for (const key of Reflect.ownKeys(descriptors)) {
    if (Array.isArray(item) && key === "length") continue
    if (typeof key !== "string") return fail("input cannot contain symbol keys")
    const descriptor = descriptors[key]!
    if (!descriptor.enumerable || !("value" in descriptor)) fail("input must contain enumerable JSON values, not accessors")
    if (Array.isArray(item) && !/^(0|[1-9][0-9]*)$/.test(key)) fail("input arrays cannot carry extra options")
    assertJsonData(descriptor.value, ancestors)
  }
  ancestors.delete(item)
}

/** Input is source text or an administrator-registered program name, never a file path. */
export const executeUslOperation = async (operation: UslOperation, input: unknown, policy: UslOperationPolicy = DEFAULT_USL_POLICY): Promise<unknown> => {
  if (!USL_OPERATIONS.includes(operation)) return fail(`unknown USL operation: ${operation}`)
  // Capture permission-bearing settings explicitly, including inherited fields.
  const settings = { allowedLocators: structuredClone(policy.allowedLocators), maxResources: integer(policy.maxResources, "policy.maxResources"),
    maxInputBytes: integer(policy.maxInputBytes, "policy.maxInputBytes"), maxOutputBytes: integer(policy.maxOutputBytes, "policy.maxOutputBytes"),
    resolvers: policy.resolvers, getProgram: policy.getProgram, getConnection: policy.getConnection }
  if (!Array.isArray(settings.allowedLocators)) return fail("policy.allowedLocators must be an array")
  const allowed = [...new Set(settings.allowedLocators.map(normalizeLocator))]
  assertJsonData(input)
  const data = record(structuredClone(input), "input")
  if (size(data) > settings.maxInputBytes) return fail("input exceeds maxInputBytes")
  const output = (value: unknown) => {
    if (size(value) > settings.maxOutputBytes) return fail("output exceeds maxOutputBytes; narrow the request or use compact context")
    return value
  }
  if (operation === "compare") { fields(data, ["before", "after"]); return output(unwrap(compareObservations(data.before, data.after))) }
  if (operation === "validate_observation") {
    fields(data, ["report"])
    const report = unwrap(validateObservation(data.report))
    return output({ valid: true, namespace: report.namespace, observationDigest: report.observationDigest, planDigest: report.planDigest })
  }
  if (operation === "graph_import") {
    fields(data, ["graph", "bindings"])
    const source = unwrap(parseGraphEngineeringSource(string(data.graph, "graph")))
    const bindings = record(data.bindings, "bindings") as unknown as GraphEngineeringBindings
    return output(unwrap(toGraphEngineeringPlan(source, bindings)))
  }
  if (operation === "hswm_prepare") { fields(data, ["arguments"]); return output(prepareHswmAdapterArguments(data.arguments as HswmAdapterArguments)) }

  const permitted = ["source", "program", "connection", ...(operation === "context" ? ["query", "compact", "maxBytes", "knownContextDigest"] : operation === "observe" ? ["options", "baseline"] : operation === "project" ? ["options"] : [])]
  fields(data, permitted)
  if ([data.source, data.program, data.connection].filter((v) => v !== undefined).length !== 1) return fail("provide exactly one of source, program or connection")
  let snapshot: UslProgramSnapshot
  let connection: AdaptedGraph | undefined
  if (data.source !== undefined) {
    const source = string(data.source, "source")
    snapshot = { source, plan: unwrap(compileSource(source)) }
  } else if (data.program !== undefined) {
    if (!settings.getProgram) return fail("registered programs are not configured")
    // getProgram returns a validated immutable version; no full recompilation on a cache hit.
    snapshot = structuredClone(await settings.getProgram(string(data.program, "program")))
  } else {
    if (!settings.getConnection) return fail("connections are not configured")
    connection = structuredClone(await settings.getConnection(string(data.connection, "connection")))
    if (!connection || typeof connection !== "object" || !connection.source?.adapter || !connection.source.digest || !connection.identities || !connection.plan) return fail("invalid connection snapshot")
    const checked = unwrap(composePlans(connection.plan.namespace, [connection.plan]))
    snapshot = { source: "", plan: checked }
  }
  const { source, plan } = snapshot
  if (Buffer.byteLength(source, "utf8") > settings.maxInputBytes) return fail("program exceeds maxInputBytes")
  const external = (value: unknown) => {
    if (!connection) return output(value)
    const sourceDigest = connection.source.digest, planHash = planDigest(plan), resultDigest = digestJson(value)
    const receipt = { sourceDigest, planDigest: planHash, resultDigest, digest: digestJson({ source: connection.source, identities: connection.identities, sourceDigest, planDigest: planHash, resultDigest }) }
    return output({ source: connection.source, identities: connection.identities, result: value, receipt } satisfies AdapterResult)
  }
  if (operation === "check") return external({ valid: true, namespace: plan.namespace, resources: plan.resources.length, meanings: plan.meanings.length,
    links: plan.links.length, planDigest: planDigest(plan), sourceDigest: connection ? null : digestSource(source) })
  if (operation === "compile") return external(plan)
  if (operation === "context") {
    const query = record(data.query, "query")
    fields(query, ["focus", "target", "routes", "maxHops", "maxResources", "maxLinks", "maxVisits"])
    const resourceLimit = query.maxResources === undefined ? settings.maxResources : integer(query.maxResources, "query.maxResources")
    if (resourceLimit > settings.maxResources) return fail("query.maxResources exceeds server policy")
    const boundedQuery = { ...query, maxResources: resourceLimit } as unknown as NavigationQuery
    if (data.compact !== undefined && typeof data.compact !== "boolean") return fail("compact must be a boolean")
    if (data.compact) {
      const maxBytes = data.maxBytes === undefined ? settings.maxOutputBytes : integer(data.maxBytes, "maxBytes")
      if (maxBytes > settings.maxOutputBytes) return fail("maxBytes exceeds server policy")
      const result = unwrap(compactAgentContext(plan, boundedQuery, { maxBytes,
        ...(data.knownContextDigest === undefined ? {} : { knownContextDigest: string(data.knownContextDigest, "knownContextDigest") }) }))
      return output({ context: JSON.parse(result.text), stats: result.stats })
    }
    if (data.maxBytes !== undefined || data.knownContextDigest !== undefined) return fail("maxBytes and knownContextDigest require compact")
    return output(unwrap(agentContext(plan, boundedQuery)))
  }
  if (operation === "observe") {
    const options = data.options === undefined ? {} : record(data.options, "options")
    fields(options, ["links", "allowedLocators", "maxResources"])
    const maxResources = options.maxResources === undefined ? settings.maxResources : integer(options.maxResources, "options.maxResources")
    if (maxResources > settings.maxResources) return fail("options.maxResources exceeds server policy")
    const requested = options.allowedLocators === undefined ? allowed : options.allowedLocators
    if (!Array.isArray(requested)) return fail("options.allowedLocators must be an array")
    const narrowed = [...new Set(requested.map(normalizeLocator))]
    if (narrowed.some((locator) => !allowed.includes(locator))) return fail("request attempts to expand the server read allowlist")
    const baseline = data.baseline === undefined ? undefined : unwrap(validateObservation(data.baseline))
    if (baseline && baseline.namespace !== plan.namespace) return fail("baseline namespace differs from program")
    const observed = observeProgram(plan, { sourceText: source, maxResources, allowedLocators: narrowed,
      ...(options.links === undefined ? {} : { links: options.links as ReadonlyArray<string> }) })
    const report = await Effect.runPromise(settings.resolvers ? observed.pipe(Effect.provideService(Resolvers, settings.resolvers))
      : observed.pipe(Effect.provide(ResolversLive.pipe(Layer.provide(ConfigLive())))))
    return output(baseline ? { observation: report, comparison: unwrap(compareObservations(baseline, report)) } : report)
  }
  const options = record(data.options, "options")
  fields(options, ["bundle_uid", "title", "trigger", "evidence", "kgAnchors", "targetKgSource"])
  return output(unwrap(toSemanticBundle(plan, { ...options, source: { name: typeof data.program === "string" ? data.program : "inline.usl", text: source } } as unknown as SemanticProjectionOptions)))
}
