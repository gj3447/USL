import { Either, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { formatLocator, parseLocator } from "../locator.js"
import type { Locator } from "../domain.js"
import { locatorKey } from "../resolve.js"
import { compileProgram } from "./compiler.js"
import { digestJson, linkContractDigest } from "./digest.js"
import { ObservationError, type ProgramObservation, type ResourceObservation } from "./runtime.js"
import { ProgramObservationSchema } from "./observation-schema.js"

const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x)
const fingerprint = (x: unknown) => typeof x === "string" && /^sha256:[a-f0-9]{64}$/.test(x)
const fail = (detail: string): never => { throw new ObservationError({ detail }) }

/** Reject old or damaged snapshots before comparing. Digests detect corruption, not authorship. */
export const validateObservation = (input: unknown): Either.Either<ProgramObservation, ObservationError> => Either.try({
  try: () => {
    if (!object(input) || input.schema !== "usl-program-observation/v2") return fail("baseline must be a usl-program-observation/v2 report; observe again to establish semantic identity")
    const snapshot = structuredClone(input)
    const { observationDigest, ...payload } = snapshot
    if (!fingerprint(observationDigest) || digestJson(payload) !== observationDigest) return fail("observation digest mismatch")
    const decoded = Schema.decodeUnknownEither(ProgramObservationSchema)(snapshot, { onExcessProperty: "error" })
    if (Either.isLeft(decoded)) return fail(`invalid observation fields: ${decoded.left.message}`)
    // Keep the original JSON property order: decoding must not rewrite hashed payloads.
    const report = snapshot as unknown as ProgramObservation
    for (const field of ["resources", "groundings", "meanings", "links"] as const) {
      const entries = report[field]
      if (new Set(entries.map((x) => x.name)).size !== entries.length) return fail(`duplicate ${field}`)
    }
    // Recompile the selected declarations to validate names, roles, bindings and contracts.
    const compiled = compileProgram({ languageVersion: "0.1", namespace: report.namespace, declarations: [
      ...report.resources.map((r) => ({ tag: "resource" as const, name: r.name, locator: r.locator })),
      ...report.meanings.map((m) => { const { grounded, ...definition } = m.definition; return { ...definition, tag: "meaning" as const, ...(grounded ? { grounded: formatLocator(grounded) } : {}) } }),
      ...report.links.map((l) => ({ tag: "link" as const, name: l.name, meaning: l.meaning, participants: l.participants })),
    ] })
    if (Either.isLeft(compiled)) return fail(`invalid observation declarations: ${compiled.left.message}`)
    const same = (actual: unknown, expected: unknown, field: string) => {
      if (!isDeepStrictEqual(actual, expected)) return fail(`inconsistent observation ${field}`)
    }
    const parse = (value: string) => {
      const parsed = parseLocator(value)
      if (Either.isLeft(parsed) || formatLocator(parsed.right) !== value) return fail(`invalid observation locator: ${value}`)
      return parsed.right
    }
    const observations = [...report.resources, ...report.groundings]
    const representatives = new Map<string, Locator>()
    for (const r of observations) {
      const locator = parse(r.locator), key = locatorKey(locator)
      if (!representatives.has(key)) representatives.set(key, locator)
    }
    const requested = [...representatives.values()].map(formatLocator)
    const normalizedAllowlist = [...new Set(report.readScope.allowedLocators.map((l) => locatorKey(parse(l))))].sort()
    same(report.readScope.allowedLocators, normalizedAllowlist, "readScope.allowedLocators")
    same(report.readScope.requestedLocators, requested, "readScope.requestedLocators")
    same(report.readScope.links, report.links.map((l) => l.name), "readScope.links")
    if (report.readScope.resourceBudget < requested.length) return fail("observation exceeds readScope.resourceBudget")
    const allowed = new Set(normalizedAllowlist)
    const observedByLocator = new Map<string, Omit<ResourceObservation, "name" | "locator">>()
    for (const r of observations) {
      const locator = parse(r.locator)
      const key = locatorKey(locator)
      same(r.fingerprintScope, locator.kind === "kg" ? "KG_METADATA" : "RESOLVER_REPRESENTATION", `${r.name}.fingerprintScope`)
      if (!allowed.has(locatorKey(locator)) && r.status !== "DENIED") return fail("observation outside allowed read scope must be DENIED")
      if (r.resolution !== null) {
        same(r.resolution.locator, representatives.get(key), `${r.name}.resolution.locator`)
        const resolved = parse(r.resolution.resolvedLocator)
        if (resolved.kind !== locator.kind) return fail("resolved locator kind differs from requested kind")
        if (locator.kind === "kg") same(resolved, locator, `${r.name}.resolved KG identity`)
        if ((resolved.kind === "url" || resolved.kind === "filesystem") && !allowed.has(locatorKey(resolved))) return fail("resolved address is outside allowed read scope")
        same(r.status, r.resolution.matchCount === 1 ? "RESOLVES" : "AMBIGUOUS", `${r.name}.status`)
        if (r.resolution.matchCount === 1) same(r.issue, null, `${r.name}.issue`)
        else if (r.issue?.reason !== "AMBIGUOUS") return fail("non-unique resolution needs an AMBIGUOUS issue")
      } else {
        if (r.status === "RESOLVES" || r.issue === null) return fail("unresolved observation needs a failure status and issue")
        const status = r.issue.reason === "ORPHAN" ? "ORPHAN" : r.issue.reason === "DENIED" ? "DENIED" : "AMBIGUOUS"
        same(r.status, status, `${r.name}.status/issue`)
      }
      // Authored aliases differ; their single collected result must not.
      const { name, locator: _authoredLocator, ...value } = r
      const prior = observedByLocator.get(key)
      if (prior) same(value, prior, `${name}: shared locator result`)
      else observedByLocator.set(key, value)
    }
    const usedResources = new Set(report.links.flatMap((l) => l.participants.map((p) => p.resource)))
    const usedMeanings = new Set(report.links.map((l) => l.meaning))
    same(new Set(report.resources.map((r) => r.name)), usedResources, "selected resources")
    same(new Set(report.meanings.map((m) => m.name)), usedMeanings, "selected meanings")
    for (const m of report.meanings) {
      if (m.name !== m.definition.name || m.digest !== digestJson(m.definition)) return fail("meaning digest mismatch")
      const grounding = report.groundings.find((g) => g.name === m.name)
      if (m.definition.grounded ? grounding?.locator !== formatLocator(m.definition.grounded) : grounding !== undefined) return fail("meaning grounding mismatch")
    }
    if (report.groundings.some((g) => !report.meanings.some((m) => m.name === g.name))) return fail("unknown grounding")
    for (const l of report.links) {
      const m = report.meanings.find((m) => m.name === l.meaning)
      if (!m || l.meaningDigest !== m.digest || l.contractDigest !== linkContractDigest(m.definition)) return fail("link meaning/contract digest mismatch")
      same(l.participants, compiled.right.links.find((link) => link.name === l.name)!.participants, `${l.name}.participants`)
      same(l.resourcesResolve, l.participants.every((p) => report.resources.find((r) => r.name === p.resource)?.status === "RESOLVES"), `${l.name}.resourcesResolve`)
      const expectedChecks = (m.definition.contract?.checks ?? []).map((check) => {
        const evidence = check.evidenceRoles.map((role) => ({ role, resource: l.participants.find((p) => p.role === role)!.resource }))
        return { ...check, scope: m.definition.contract!.scope, evidence,
          evidenceAvailable: evidence.every((p) => report.resources.find((r) => r.name === p.resource)?.status === "RESOLVES"), status: "NOT_EXECUTED" }
      })
      same(l.verification, expectedChecks, `${l.name}.verification`)
    }
    same(report.status, observations.every((r) => r.status === "RESOLVES") ? "RESOLVES" : "UNRESOLVED", "status")
    same(report.metrics.selectedResources, report.resources.length, "metrics.selectedResources")
    same(report.metrics.uniqueLocators, requested.length, "metrics.uniqueLocators")
    same(report.metrics.resolverCalls, requested.filter((l) => allowed.has(locatorKey(parse(l)))).length, "metrics.resolverCalls")
    same(report.metrics.deniedLocators, new Set(observations.filter((r) => r.status === "DENIED").map((r) => locatorKey(parse(r.locator)))).size, "metrics.deniedLocators")
    // The selected report cannot reconstruct the complete original plan or its resource count.
    if (report.metrics.declaredResources < report.resources.length) return fail("metrics.declaredResources is smaller than selected resources")
    return report
  },
  catch: (e) => e instanceof ObservationError ? e : new ObservationError({ detail: `invalid observation: ${String(e)}` }),
})

export const compareObservations = (previous: unknown, current: unknown) => Either.gen(function* () {
  const before = yield* validateObservation(previous)
  const after = yield* validateObservation(current)
  if (before.namespace !== after.namespace) return yield* Either.left(new ObservationError({ detail: "cannot compare observations from different namespaces" }))
  const links = after.links.map((link) => {
    const prior = before.links.find((l) => l.name === link.name)
    const addressChanged: string[] = [], contentChanged: string[] = [], unavailable: string[] = [], baselineMissing: string[] = []
    const inspect = (label: string, old: ResourceObservation | undefined, now: ResourceObservation | undefined) => {
      if (!now) { if (old) addressChanged.push(label); return }
      if (now.status !== "RESOLVES") unavailable.push(label)
      if (!old || old.status !== "RESOLVES") baselineMissing.push(label)
      if (old && (old.locator !== now.locator || old.status === "RESOLVES" && now.status === "RESOLVES" && old.resolution!.resolvedLocator !== now.resolution!.resolvedLocator)) addressChanged.push(label)
      if (old?.status === "RESOLVES" && now.status === "RESOLVES" && (old.fingerprintScope !== now.fingerprintScope || old.resolution!.contentHash !== now.resolution!.contentHash)) contentChanged.push(label)
    }
    for (const p of link.participants) {
      const old = prior?.participants.find((x) => x.role === p.role)
      inspect(p.role, old ? before.resources.find((r) => r.name === old.resource) : undefined, after.resources.find((r) => r.name === p.resource))
      if (old && old.resource !== p.resource && !addressChanged.includes(p.role)) addressChanged.push(p.role)
    }
    const oldGrounding = prior ? before.groundings.find((g) => g.name === prior.meaning) : undefined
    const grounding = after.groundings.find((g) => g.name === link.meaning)
    if (grounding || oldGrounding) {
      inspect(`grounding:${link.meaning}`, oldGrounding, grounding)
      if (!oldGrounding && grounding && prior) addressChanged.push(`grounding:${link.meaning}`)
    }
    const semanticContractChanged = prior ? prior.contractDigest !== link.contractDigest : null
    const actions: string[] = []
    if (addressChanged.length) actions.push("REVIEW_ADDRESS_BINDING")
    if (contentChanged.length) actions.push("RECHECK_EVIDENCE")
    if (semanticContractChanged) actions.push("REVIEW_SEMANTIC_CONTRACT")
    if (unavailable.length) actions.push("RESTORE_AUTHORIZED_READ")
    if (!prior || baselineMissing.length) actions.push("ESTABLISH_BASELINE")
    return { name: link.name, addressChanged, contentChanged, semanticContractChanged, unavailable, baselineMissing, actions }
  })
  return { schema: "usl-program-observation-comparison/v1" as const, namespace: after.namespace,
    previousPlanDigest: before.planDigest, currentPlanDigest: after.planDigest,
    previousObservationDigest: before.observationDigest, currentObservationDigest: after.observationDigest,
    linksOutsideCurrentScope: before.links.filter((l) => !after.links.some((x) => x.name === l.name)).map((l) => l.name),
    links, semanticTruth: "NOT_EVALUATED" as const }
})
