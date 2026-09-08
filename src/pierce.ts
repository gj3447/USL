// pierce(): resolve both ends and mint one USL record (Longinus "관통" at link granularity).
// audit(): re-resolve and classify drift; BX GetPut/PutGet diagnostics are pure functions over resolutions.
import { Data, Effect, Either } from "effect"
import { TOOL_VERSION, type Direction, type Locator, type Resolution, type UslRecord } from "./domain.js"
import { parseLocator, formatLocator } from "./locator.js"
import { ResolveError, Resolvers, weakest } from "./resolve.js"

export interface PierceInput {
  readonly link_id: string
  readonly semantic_relation: string
  readonly from: string
  readonly to: string
  readonly direction?: Direction
  readonly actor?: string
  readonly command?: string
  readonly hswm_owner_ref?: string | null
}

export class LinkInputError extends Data.TaggedError("LinkInputError")<{ readonly detail: string }> {
  get message() { return this.detail }
}

const parseOrFail = (s: string) => Either.match(parseLocator(s), { onLeft: (e) => Effect.fail(e), onRight: (l) => Effect.succeed(l) })

type EndResult = Either.Either<Resolution, ResolveError>

const endStatus = (r: EndResult): "OK" | "ORPHAN" | "AMBIGUOUS" | "IO" => Either.match(r, { onLeft: (e) => e.reason === "DENIED" ? "IO" : e.reason, onRight: () => "OK" as const })

export const pierce = (input: PierceInput) =>
  Effect.gen(function* () {
    if (!input.link_id?.trim() || !input.semantic_relation?.trim()) return yield* new LinkInputError({ detail: "link_id and semantic_relation must be non-empty" })
    if (input.direction !== undefined && input.direction !== "directed" && input.direction !== "undirected") return yield* new LinkInputError({ detail: "direction must be directed or undirected" })
    const resolvers = yield* Resolvers
    const fromLoc: Locator = yield* parseOrFail(input.from)
    const toLoc: Locator = yield* parseOrFail(input.to)
    const [rf, rt] = yield* Effect.all([Effect.either(resolvers.resolve(fromLoc)), Effect.either(resolvers.resolve(toLoc))], { concurrency: 2 })
    const sf = endStatus(rf), st = endStatus(rt)
    // IO (transport/host) failures are NOT evidence of absence → AMBIGUOUS (human/retry gate), never ORPHAN
    const status: UslRecord["status"] = sf === "AMBIGUOUS" || st === "AMBIGUOUS" || sf === "IO" || st === "IO" ? "AMBIGUOUS" : sf !== "OK" ? "ORPHAN_FROM" : st !== "OK" ? "ORPHAN_TO" : "RESOLVES"
    const confidence: UslRecord["confidence"] = status === "AMBIGUOUS" ? "AMBIGUOUS" : status === "RESOLVES" ? "EXTRACTED" : "INFERRED"
    const gl = weakest(Either.getOrElse(rf, () => ({ guaranteeLevel: "trust_host" as const })).guaranteeLevel, Either.getOrElse(rt, () => ({ guaranteeLevel: "trust_host" as const })).guaranteeLevel)
    const pick = <K extends keyof Resolution>(r: EndResult, k: K): Resolution[K] | null => Either.match(r, { onLeft: () => null, onRight: (x) => x[k] })
    const record: UslRecord = {
      link_id: input.link_id,
      semantic_relation: input.semantic_relation,
      from_endpoint_kind: fromLoc.kind, from_locator: formatLocator(fromLoc),
      to_endpoint_kind: toLoc.kind, to_locator: formatLocator(toLoc),
      direction: input.direction ?? "directed",
      resolved_at_from: pick(rf, "resolvedAt"), resolved_at_to: pick(rt, "resolvedAt"),
      resolved_locator_from: pick(rf, "resolvedLocator"), resolved_locator_to: pick(rt, "resolvedLocator"),
      pierced_at: new Date().toISOString(),
      drift_detected_at: null, drift_score: 0,
      content_hash_from: pick(rf, "contentHash"), content_hash_to: pick(rt, "contentHash"),
      confidence, guarantee_level: gl, status,
      provenance_actor: input.actor ?? "usl-cli", provenance_tool_version: TOOL_VERSION,
      provenance_command: input.command ?? `usl pierce ${input.from} ${input.to}`, provenance_date: new Date().toISOString().slice(0, 10),
      hswm_owner_ref: input.hswm_owner_ref ?? null,
    }
    const notes = [rf, rt].flatMap((r) => Either.match(r, { onLeft: (e) => [`${e.kind}:${e.reason}:${e.detail}`], onRight: () => [] }))
    return { record, notes }
  })

// ---- Drift audit (Longinus 5 drift types collapsed to what a single link can witness in v0.1)
export interface DriftReport {
  readonly link_id: string
  readonly before: UslRecord["status"]
  readonly after: UslRecord["status"]
  readonly drift_type: "NONE" | "SigMismatch" | "Orphan" | "LabelRot" | "Ambiguous" | "Unbaselined"
  readonly changed_ends: ReadonlyArray<"from" | "to">
  readonly relocated_ends: ReadonlyArray<"from" | "to">
  readonly missing_baseline_ends: ReadonlyArray<"from" | "to">
  readonly issues: ReadonlyArray<{ readonly end: "from" | "to"; readonly reason: ResolveError["reason"]; readonly detail: string }>
  readonly observations: { readonly from: Resolution | null; readonly to: Resolution | null }
  readonly bx: { readonly getPut: boolean; readonly putGet: boolean; readonly note: string }
  readonly updated: UslRecord
}

// Read stability and locator round-trip diagnostics; these do not prove update-lens laws.
//   GetPut: resolving an unchanged binding twice yields the same (locator, hash)  → stable
//   PutGet: re-parsing the formatted resolved locator reproduces the same structure → stable
export const bxGetPut = (a: Resolution, b: Resolution): boolean => a.resolvedLocator === b.resolvedLocator && a.contentHash === b.contentHash
export const bxPutGet = (r: Resolution): boolean => Either.match(parseLocator(r.resolvedLocator), { onLeft: () => false, onRight: (l) => formatLocator(l) === r.resolvedLocator })

export const audit = (record: UslRecord) =>
  Effect.gen(function* () {
    const resolvers = yield* Resolvers
    const fromLoc = yield* parseOrFail(record.from_locator)
    const toLoc = yield* parseOrFail(record.to_locator)
    if (fromLoc.kind !== record.from_endpoint_kind || toLoc.kind !== record.to_endpoint_kind) return yield* new LinkInputError({ detail: `endpoint kind mismatch: ${record.link_id}` })
    const [rf, rt] = yield* Effect.all([Effect.either(resolvers.resolve(fromLoc)), Effect.either(resolvers.resolve(toLoc))], { concurrency: 2 })
    const sf = endStatus(rf), st = endStatus(rt)
    const changed: Array<"from" | "to"> = []
    const hashOf = (r: EndResult) => Either.match(r, { onLeft: () => null, onRight: (x) => x.contentHash })
    const locOf = (r: EndResult) => Either.match(r, { onLeft: () => null, onRight: (x) => x.resolvedLocator })
    if (sf === "OK" && record.content_hash_from !== null && hashOf(rf) !== record.content_hash_from) changed.push("from")
    if (st === "OK" && record.content_hash_to !== null && hashOf(rt) !== record.content_hash_to) changed.push("to")
    const relocated: Array<"from" | "to"> = []
    if (sf === "OK" && record.resolved_locator_from !== null && locOf(rf) !== record.resolved_locator_from) relocated.push("from")
    if (st === "OK" && record.resolved_locator_to !== null && locOf(rt) !== record.resolved_locator_to) relocated.push("to")
    const missing: Array<"from" | "to"> = []
    if (!record.content_hash_from || !record.resolved_locator_from || !record.resolved_at_from) missing.push("from")
    if (!record.content_hash_to || !record.resolved_locator_to || !record.resolved_at_to) missing.push("to")
    let after: UslRecord["status"]; let drift_type: DriftReport["drift_type"]
    if (sf === "AMBIGUOUS" || st === "AMBIGUOUS" || sf === "IO" || st === "IO") { after = "AMBIGUOUS"; drift_type = "Ambiguous" }
    else if (sf !== "OK") { after = "ORPHAN_FROM"; drift_type = "Orphan" }
    else if (st !== "OK") { after = "ORPHAN_TO"; drift_type = "Orphan" }
    else if (changed.length > 0) { after = "DRIFT"; drift_type = "SigMismatch" }
    else if (relocated.length > 0) { after = "DRIFT"; drift_type = "LabelRot" }
    else if (missing.length > 0) { after = "AMBIGUOUS"; drift_type = "Unbaselined" }
    else { after = "RESOLVES"; drift_type = "NONE" }
    const nowIso = new Date().toISOString()
    const drift_score = after === "RESOLVES" ? 0 : after === "DRIFT" ? new Set([...changed, ...relocated]).size / 2 : 1
    const getPut = Either.isRight(rf) && Either.isRight(rt) && missing.length === 0 && changed.length === 0 && relocated.length === 0
    const putGet = Either.match(rf, { onLeft: () => false, onRight: bxPutGet }) && Either.match(rt, { onLeft: () => false, onRight: bxPutGet })
    const observed = (r: EndResult) => Either.match(r, { onLeft: () => null, onRight: (x) => x })
    const issues = ([ ["from", rf], ["to", rt] ] as const).flatMap(([end, result]) => Either.match(result, { onLeft: (e) => [{ end, reason: e.reason, detail: e.detail }], onRight: () => [] }))
    const updated: UslRecord = { ...record, status: after, drift_score, audited_at: nowIso,
      confidence: after === "RESOLVES" ? "EXTRACTED" : after === "AMBIGUOUS" ? "AMBIGUOUS" : after === "ORPHAN_FROM" || after === "ORPHAN_TO" ? "INFERRED" : record.confidence,
      guarantee_level: weakest(record.guarantee_level, weakest(observed(rf)?.guaranteeLevel ?? "trust_host", observed(rt)?.guaranteeLevel ?? "trust_host")),
      drift_detected_at: after === "RESOLVES" ? record.drift_detected_at : record.drift_detected_at ?? nowIso }
    return { link_id: record.link_id, before: record.status, after, drift_type, changed_ends: changed, relocated_ends: relocated, missing_baseline_ends: missing, issues,
      observations: { from: observed(rf), to: observed(rt) }, bx: { getPut, putGet, note: "Read stability and locator round-trip checks only; no formal BX lens proof or automatic baseline repair." }, updated } satisfies DriftReport
  })

// Explicitly accept a new complete snapshot. Failure never replaces the old record.
export const rebind = (record: UslRecord, provenance: { readonly actor?: string; readonly command?: string } = {}) => Effect.gen(function* () {
  const out = yield* pierce({ link_id: record.link_id, semantic_relation: record.semantic_relation, from: record.from_locator, to: record.to_locator,
    direction: record.direction, hswm_owner_ref: record.hswm_owner_ref, actor: provenance.actor ?? "usl-rebind", command: provenance.command ?? `usl rebind --link-id ${record.link_id}` })
  if (out.record.status !== "RESOLVES") return yield* new LinkInputError({ detail: `rebind requires both endpoints to resolve: ${out.record.status}; ${out.notes.join("; ")}` })
  return out
})
