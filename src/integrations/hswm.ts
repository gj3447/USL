/**
 * Prepare the exact four values consumed by HSWM's `adapt_usl` v2 adapter.
 * This is an IO-free transport boundary: it never resolves, authorizes,
 * admits, executes checks, assigns ownership, credits, or learns.
 */
import { createHash } from "node:crypto"
import { Either } from "effect"
import { parseLocator } from "../locator.js"
import { locatorKey } from "../resolve.js"
import { planDigest } from "../language/digest.js"
import type { SemanticPlan } from "../language/model.js"
import { validateObservation } from "../language/comparison.js"
import type { ProgramObservation } from "../language/runtime.js"
import { composePlans } from "../language/code.js"

export class HswmIntegrationError extends Error {
  readonly _tag = "HswmIntegrationError"
}

export interface HswmReadBinding { readonly link: string; readonly role: string; readonly field: string }
export interface HswmResourcePin { readonly name: string; readonly content_hash: string; readonly resolved_locator: string }
/** The caller owns this policy. USL never derives it from an observation. */
export interface HswmObservationPolicyV2 {
  readonly schema_version: "hswm-usl-observation-policy/v2"
  readonly namespace: string
  /** HSWM's sorted-key JSON SHA-256 digest, without the `sha256:` prefix. */
  readonly plan_digest: string
  readonly usl_plan_digest: string
  readonly source_digest: string | null
  readonly max_age_seconds: number
  readonly bindings: ReadonlyArray<HswmReadBinding>
  readonly resources: ReadonlyArray<HswmResourcePin>
}
export interface HswmAdapterArguments {
  readonly plan: SemanticPlan
  readonly report: ProgramObservation
  readonly policy: HswmObservationPolicyV2
  /** JSON transport form; the Python consumer converts these to `set(tuple(x))`. */
  readonly allowed_reads: ReadonlyArray<readonly [string, string]>
  readonly now: number
  readonly revision: string
}

const fail = (detail: string): never => { throw new HswmIntegrationError(detail) }
const name = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) fail(label)
  return value as string
}
const hash = (value: unknown, label: string, prefix = false): string => {
  if (typeof value !== "string" || !(prefix ? /^sha256:[a-f0-9]{64}$/ : /^[a-f0-9]{64}$/).test(value)) fail(label)
  return value as string
}
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") { if (!Number.isSafeInteger(value)) fail("HSWM wire requires safe JSON integers"); return JSON.stringify(value) }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object") {
    const input = value as Record<string, unknown>
    return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`).join(",")}}`
  }
  return fail("HSWM wire requires JSON values")
}
/** Matches `hswm.cells.conditional.digest`: sorted-key compact UTF-8 JSON SHA-256. */
export const hswmDigest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex")

const clone = <T>(value: T): T => structuredClone(value)
const validateAliases = (report: ProgramObservation) => {
  const representatives = new Map<string, string>()
  for (const row of [...report.resources, ...report.groundings]) {
    const parsed = parseLocator(row.locator)
    if (Either.isLeft(parsed)) fail("report locator is invalid")
    const raw = row.locator, key = locatorKey(Either.getOrThrow(parsed))
    const prior = representatives.get(key)
    if (prior !== undefined && prior !== raw) fail(`HSWM v2 consumer cannot accept canonical locator aliases (${prior} and ${raw}); re-observe with one spelling`)
    representatives.set(key, raw)
  }
}

/**
 * Validates and deep-copies existing HSWM adapter arguments.
 * `policy` and `allowed_reads` must be independently supplied by the caller.
 */
export const prepareHswmAdapterArguments = (input: HswmAdapterArguments): HswmAdapterArguments => {
  if (!input || typeof input !== "object") fail("HSWM adapter input is required")
  // Each field is copied before reading the next getter-owned field.
  const captured = { plan: clone(input.plan), report: clone(input.report), policy: clone(input.policy), allowed: clone(input.allowed_reads), now: input.now, revision: input.revision }
  const plan = captured.plan
  // Validate structure without rewriting the caller's hashed JSON property order.
  if (Either.isLeft(composePlans(plan.namespace, [plan]))) fail("invalid full USL semantic plan")
  const policy = captured.policy
  if (!policy || policy.schema_version !== "hswm-usl-observation-policy/v2") fail("HSWM v2 policy is required")
  const checked = validateObservation(captured.report)
  if (Either.isLeft(checked)) fail(`invalid USL observation: ${checked.left.detail}`)
  const report = clone(Either.getOrThrow(checked))
  if (report.planDigest !== planDigest(plan)) fail("report planDigest does not bind supplied plan")
  if (report.sourceDigest !== policy.source_digest) fail("policy source_digest does not bind report")
  validateAliases(report)
  if (policy.namespace !== plan.namespace || policy.usl_plan_digest !== report.planDigest || policy.plan_digest !== hswmDigest(plan)) fail("HSWM policy plan identity mismatch")
  if (!Number.isFinite(policy.max_age_seconds) || policy.max_age_seconds <= 0 || policy.max_age_seconds > 86_400) fail("invalid HSWM policy max_age_seconds")
  const links = new Map(plan.links.map((link) => [link.name, link]))
  const meanings = new Map(plan.meanings.map((meaning) => [meaning.name, meaning]))
  const selected = new Set<string>(), required = new Set<string>(), mapped = new Set<string>()
  if (!Array.isArray(policy.bindings) || policy.bindings.length === 0) fail("HSWM policy bindings are required")
  for (const binding of policy.bindings) {
    const link = links.get(name(binding.link, "invalid HSWM binding link"))
    const role = name(binding.role, "invalid HSWM binding role"), field = name(binding.field, "invalid HSWM binding field")
    if (!link) return fail("duplicate or unknown HSWM policy binding")
    if (selected.has(link.name) || mapped.has(`${role}\u0000${field}`)) fail("duplicate or unknown HSWM policy binding")
    selected.add(link.name); mapped.add(`${role}\u0000${field}`)
    for (const participant of link.participants) required.add(participant.resource)
    const meaning = meanings.get(link.meaning)!; if (meaning.grounded) required.add(`meaning:${meaning.name}`)
  }
  const pins = new Map<string, HswmResourcePin>()
  if (!Array.isArray(policy.resources)) fail("HSWM policy resources are required")
  for (const pin of policy.resources) {
    const id = typeof pin.name === "string" && pin.name.length > 0 ? pin.name : fail("invalid HSWM resource pin")
    if (pins.has(id)) fail("duplicate HSWM resource pin")
    pins.set(id, { name: id, content_hash: hash(pin.content_hash, "invalid HSWM content pin"), resolved_locator: typeof pin.resolved_locator === "string" && pin.resolved_locator.length > 0 ? pin.resolved_locator : fail("invalid HSWM locator pin") })
  }
  if (pins.size !== required.size || [...required].some((id) => !pins.has(id))) fail("HSWM pins must exactly cover selected links")
  const allowed = captured.allowed
  if (!Array.isArray(allowed)) fail("HSWM allowed_reads are required")
  const permitted = new Set<string>()
  for (const entry of allowed) {
    if (!Array.isArray(entry) || entry.length !== 2) fail("invalid HSWM allowed_read")
    permitted.add(`${name(entry[0], "invalid HSWM allowed_read role")}\u0000${name(entry[1], "invalid HSWM allowed_read field")}`)
  }
  for (const target of mapped) if (!permitted.has(target)) fail("HSWM policy binding is not caller-authorized")
  if (!Number.isFinite(captured.now) || typeof captured.revision !== "string" || captured.revision.length === 0) fail("invalid HSWM observation context")
  return { plan, report, policy: { ...policy, bindings: clone(policy.bindings), resources: [...pins.values()] }, allowed_reads: allowed.map((entry) => [entry[0]!, entry[1]!] as const), now: captured.now, revision: captured.revision }
}
