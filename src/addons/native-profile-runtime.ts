/** Compile and activate an owner-selected environment without changing graph identity. */
import { isAbsolute } from "node:path"
import { z } from "zod"
import { Either } from "effect"
import { contractDigest, contractHash, contractSnapshot, contractText, freezeContract, uniqueContractIds } from "../contract-core.js"
import { digestSource } from "../language/digest.js"
import { parseResourceGraph } from "../integrations/resource-graph.js"
import { bindResourceGraph } from "../integrations/resource-bindings.js"
import { parseCheckoutGuardPolicy, type CheckoutGuardHost, type CheckoutGuardPolicy } from "./checkout-guard.js"
import { createNativeProfileSnapshot, parseNativeProfileManifest, parseNativeProfileSnapshot } from "./native-profile.js"
import { prepareNativeObservation, recheckNativeObservation } from "./native-observation.js"
import { prepareNativeHttp, recheckNativeHttp } from "./native-http.js"
import type { NativeProfileStore } from "./native-profile-store.js"

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/u).max(256)
const absolutePath = z.string().min(1).max(4096).refine(isAbsolute, "host root must be absolute")
const httpUrl = z.string().max(4096).refine(value => {
  try { const parsed = new URL(value); return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.hash && parsed.href === value }
  catch { return false }
}, "expected normalized credential-free HTTP(S) URL")
const httpPolicySchema = z.strictObject({ resource: contractText, representation: identifier, url: httpUrl,
  scopeDigest: contractHash, allowedUrls: z.array(httpUrl).min(1).max(256),
  maxBytes: z.number().int().min(1).max(16 * 1024 * 1024).default(1024 * 1024),
  timeoutMs: z.number().int().min(1).max(60_000).default(15_000),
  accept: z.string().max(256).regex(/^[^\r\n]*$/u).optional() })
const environmentSchema = z.strictObject({
  workspaces: z.record(identifier, absolutePath),
  checkouts: z.record(identifier, z.strictObject({ workspace: identifier, root: absolutePath })),
  checkoutPolicies: z.array(z.unknown()).max(128),
  httpPolicies: z.array(httpPolicySchema).max(128).default([]),
})
export interface NativeProfileEnvironment {
  readonly workspaces: Readonly<Record<string, string>>
  readonly checkouts: CheckoutGuardHost["checkouts"]
  readonly checkoutPolicies: readonly CheckoutGuardPolicy[]
  readonly httpPolicies: readonly z.infer<typeof httpPolicySchema>[]
}
export class NativeProfileRuntimeError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "PIN_MISMATCH" | "RESOURCE_SCOPE" | "UNAVAILABLE", message: string) {
    super(message); this.name = "NativeProfileRuntimeError"
  }
}
export const parseNativeProfileEnvironment = (input: unknown): NativeProfileEnvironment => {
  const raw = environmentSchema.parse(contractSnapshot(input)), checkoutPolicies = raw.checkoutPolicies.map(parseCheckoutGuardPolicy)
  uniqueContractIds(checkoutPolicies.map(policy => policy.resource), "checkout resource policy")
  uniqueContractIds(raw.httpPolicies.map(policy => policy.resource), "HTTP resource policy")
  for (const policy of raw.httpPolicies) {
    if (!policy.allowedUrls.includes(policy.url) || checkoutPolicies.some(item => item.resource === policy.resource)) throw new NativeProfileRuntimeError("RESOURCE_SCOPE", "HTTP policy is not allowlisted or conflicts with a checkout policy")
  }
  for (const entry of Object.values(raw.checkouts)) {
    if (raw.workspaces[entry.workspace] !== entry.root) throw new NativeProfileRuntimeError("RESOURCE_SCOPE", "checkout root differs from its registered workspace")
  }
  return freezeContract({ ...raw, checkoutPolicies })
}
/** Opaque portable pin for the host-local configuration; the configuration itself stays with the owner. */
export const nativeHostBindingDigest = (environment: unknown): string => contractDigest(parseNativeProfileEnvironment(environment))

export const compileNativeProfileGraph = async (graphInput: string, snapshotInput: unknown, environmentInput: unknown) => {
  // Capture every caller-owned value before the first asynchronous resolver.
  const snapshot = parseNativeProfileSnapshot(snapshotInput), environment = parseNativeProfileEnvironment(environmentInput)
  if (typeof graphInput !== "string" || Buffer.byteLength(graphInput) > 1024 * 1024) throw new NativeProfileRuntimeError("INVALID_INPUT", "profile graph exceeds 1 MiB")
  if (snapshot.manifest.graphDigest !== digestSource(graphInput) || snapshot.hostBindingDigest !== contractDigest(environment)) throw new NativeProfileRuntimeError("PIN_MISMATCH", "profile graph or registered host mapping differs")
  const graph = Either.getOrThrowWith(parseResourceGraph(graphInput), error => new NativeProfileRuntimeError("INVALID_INPUT", error.message))
  const resources = graph.resources.map(r => r.id).sort(), selected = snapshot.manifest.selections.map(s => s.resource).sort()
  if (contractDigest(resources) !== contractDigest(selected)) throw new NativeProfileRuntimeError("RESOURCE_SCOPE", "profile selections must exactly cover the graph resources")
  if (contractDigest(Object.keys(environment.workspaces).sort()) !== contractDigest([...snapshot.manifest.workspaceAliases].sort())) throw new NativeProfileRuntimeError("RESOURCE_SCOPE", "host workspace aliases differ from the profile")
  let bound: Awaited<ReturnType<typeof bindResourceGraph>>
  try { bound = await bindResourceGraph(graphInput, snapshot.manifest.bindings, snapshot.manifest.selections, { workspaces: environment.workspaces }) }
  catch { throw new NativeProfileRuntimeError("UNAVAILABLE", "selected profile representations cannot be resolved") }
  const body = { schema: "usl-native-profile-compilation/v1" as const, snapshotDigest: snapshot.digest,
    sourceGraphDigest: snapshot.manifest.graphDigest, hostBindingDigest: snapshot.hostBindingDigest,
    graph: bound.graph, bindingReceipt: bound.bindingReceipt, authority: "NOT_GRANTED" as const,
    observation: "NOT_PERFORMED" as const, execution: "NOT_REQUESTED" as const }
  return freezeContract({ ...body, digest: contractDigest(body) })
}

const switchSchema = z.strictObject({ expectedStateDigest: contractHash, graph: z.string().max(1024 * 1024),
  manifest: z.unknown(), environment: z.unknown(), maxResources: z.number().int().min(1).max(128).default(16) })

export interface NativeProfileObservationReport {
  readonly schema: "usl-native-profile-observation/v1"
  readonly status: "PASS" | "HOLD"
  readonly snapshotDigest: string
  readonly compilationDigest?: string
  readonly observationDigests: readonly string[]
  readonly reasons: readonly string[]
  readonly authority: "NOT_GRANTED"
  readonly consistency: "READ_ONLY_NON_ATOMIC"
  readonly digest: string
}
export interface PreparedNativeProfileObservation {
  readonly schema: "usl-prepared-native-profile-observation/v1"
  readonly report: NativeProfileObservationReport
  /** Informational compilation data; only this process's WeakMap entry is a valid recheck handle. */
  readonly compilation?: Awaited<ReturnType<typeof compileNativeProfileGraph>>
  readonly limitation: "PROCESS_LOCAL_HANDLE;READ_ONLY_NON_ATOMIC"
}
type PreparedProfileItem = { readonly digest: string; readonly recheck: () => Promise<{ readonly status: "PASS" | "HOLD"; readonly digest: string }> }
type StoredProfileObservation = { readonly graph: string; readonly snapshot: ReturnType<typeof parseNativeProfileSnapshot>; readonly environment: NativeProfileEnvironment; readonly compilation?: Awaited<ReturnType<typeof compileNativeProfileGraph>>; readonly items: readonly PreparedProfileItem[]; readonly report: NativeProfileObservationReport }
const preparedProfileObservations = new WeakMap<object, StoredProfileObservation>()
const observationReport = (snapshotDigest: string, status: "PASS" | "HOLD", reasons: readonly string[], observationDigests: readonly string[], compilationDigest?: string): NativeProfileObservationReport => {
  const body = { schema: "usl-native-profile-observation/v1" as const, status, snapshotDigest, ...(compilationDigest === undefined ? {} : { compilationDigest }), observationDigests: [...observationDigests], reasons: [...reasons], authority: "NOT_GRANTED" as const, consistency: "READ_ONLY_NON_ATOMIC" as const }
  return freezeContract({ ...body, digest: contractDigest(body) })
}
const prepareProfileValue = (stored: StoredProfileObservation): PreparedNativeProfileObservation => {
  const value = freezeContract({ schema: "usl-prepared-native-profile-observation/v1" as const, report: stored.report, ...(stored.compilation === undefined ? {} : { compilation: stored.compilation }), limitation: "PROCESS_LOCAL_HANDLE;READ_ONLY_NON_ATOMIC" as const })
  preparedProfileObservations.set(value, stored); return value
}
const httpObservationDigest = (selection: { readonly resource: string; readonly representation: string }, report: Awaited<ReturnType<typeof prepareNativeHttp>>["report"]): string => contractDigest({ schema: "usl-native-profile-http-observation/v1", selection, finalUrl: report.finalUrl, bodyDigest: report.bodyDigest, bytes: report.bytes })

/** Prepare every selected local/HTTP representation once for a later process-local gate. */
export const prepareNativeProfileObservation = async (graphInput: string, snapshotInput: unknown, environmentInput: unknown, maxResources = 16): Promise<PreparedNativeProfileObservation> => {
  const snapshot = parseNativeProfileSnapshot(snapshotInput), environment = parseNativeProfileEnvironment(environmentInput)
  if (!Number.isSafeInteger(maxResources) || maxResources < 1 || maxResources > 128) throw new Error("maxResources must be an integer from 1 to 128")
  if (snapshot.manifest.selections.length > maxResources) {
    const report = observationReport(snapshot.digest, "HOLD", ["OBSERVATION_RESOURCE_BUDGET"], [])
    return prepareProfileValue({ graph: graphInput, snapshot, environment, items: [], report })
  }
  let compilation: Awaited<ReturnType<typeof compileNativeProfileGraph>>
  try { compilation = await compileNativeProfileGraph(graphInput, snapshot, environment) }
  catch { const report = observationReport(snapshot.digest, "HOLD", ["PROFILE_COMPILATION_HELD"], []); return prepareProfileValue({ graph: graphInput, snapshot, environment, items: [], report }) }
  const items: PreparedProfileItem[] = []
  for (const selection of snapshot.manifest.selections) {
    const resolved = compilation.bindingReceipt.selections.find(item => item.resource === selection.resource)
    if (!resolved) return prepareProfileValue({ graph: graphInput, snapshot, environment, compilation, items, report: observationReport(snapshot.digest, "HOLD", ["PROFILE_SELECTION_MISSING"], items.map(item => item.digest), compilation.digest) })
    const requiredSource = snapshot.manifest.requiredSources.find(source => source.resource === selection.resource)
    const expectedDigest = resolved.expectedDigest ?? requiredSource?.digest
    const httpPolicy = environment.httpPolicies.find(policy => policy.resource === selection.resource)
    if (httpPolicy !== undefined) {
      if (httpPolicy.representation !== selection.representation || httpPolicy.url !== resolved.locator || resolved.kind !== "locator") return prepareProfileValue({ graph: graphInput, snapshot, environment, compilation, items, report: observationReport(snapshot.digest, "HOLD", ["HTTP_REGISTRATION_MISMATCH"], items.map(item => item.digest), compilation.digest) })
      const { resource: _resource, representation: _representation, accept, ...httpInput } = httpPolicy
      const prepared = await prepareNativeHttp({ ...httpInput, ...(accept === undefined ? {} : { accept }) })
      if (prepared.report.status !== "PASS" || (expectedDigest !== undefined && prepared.report.bodyDigest !== expectedDigest) || (requiredSource !== undefined && prepared.report.bytes !== requiredSource.bytes)) return prepareProfileValue({ graph: graphInput, snapshot, environment, compilation, items, report: observationReport(snapshot.digest, "HOLD", ["HTTP_OBSERVATION_HELD"], items.map(item => item.digest), compilation.digest) })
      const digest = httpObservationDigest(selection, prepared.report)
      items.push({ digest, recheck: async () => { const report = await recheckNativeHttp(prepared); return { status: report.status, digest: httpObservationDigest(selection, report) } } })
      continue
    }
    const policy = environment.checkoutPolicies.find(p => p.resource === selection.resource)
    const prepared = await prepareNativeObservation(snapshot.manifest.bindings, selection, { workspaces: environment.workspaces, ...(policy === undefined ? {} : { checkout: { policy, checkouts: environment.checkouts } }) })
    if (prepared.report.status !== "PASS" || (expectedDigest !== undefined && prepared.report.content.digest !== expectedDigest) || (requiredSource !== undefined && prepared.report.content.bytes !== requiredSource.bytes)) return prepareProfileValue({ graph: graphInput, snapshot, environment, compilation, items, report: observationReport(snapshot.digest, "HOLD", ["NATIVE_OBSERVATION_HELD"], items.map(item => item.digest), compilation.digest) })
    items.push({ digest: prepared.report.digest, recheck: async () => { const report = await recheckNativeObservation(prepared); return { status: report.status, digest: report.digest } } })
  }
  const report = observationReport(snapshot.digest, "PASS", [], items.map(item => item.digest), compilation.digest)
  return prepareProfileValue({ graph: graphInput, snapshot, environment, compilation, items, report })
}

/** Recheck only a local opaque handle; copied reports cannot recreate its captured callbacks. */
export const recheckNativeProfileObservation = async (value: PreparedNativeProfileObservation): Promise<NativeProfileObservationReport> => {
  if (value === null || typeof value !== "object") throw new Error("native profile observation was not prepared by this process")
  const saved = preparedProfileObservations.get(value)
  if (!saved) throw new Error("native profile observation was not prepared by this process")
  if (saved.report.status !== "PASS") return saved.report
  if (saved.compilation === undefined) return observationReport(saved.snapshot.digest, "HOLD", ["PREPARED_OBSERVATION_UNAVAILABLE"], saved.report.observationDigests)
  let fresh: Awaited<ReturnType<typeof compileNativeProfileGraph>>
  try { fresh = await compileNativeProfileGraph(saved.graph, saved.snapshot, saved.environment) }
  catch { return observationReport(saved.snapshot.digest, "HOLD", ["PROFILE_COMPILATION_HELD"], saved.report.observationDigests, saved.compilation.digest) }
  if (fresh.digest !== saved.compilation.digest) return observationReport(saved.snapshot.digest, "HOLD", ["PROFILE_BINDING_CHANGED"], saved.report.observationDigests, saved.compilation.digest)
  for (const item of saved.items) {
    const result = await item.recheck()
    if (result.status !== "PASS" || result.digest !== item.digest) return observationReport(saved.snapshot.digest, "HOLD", ["NATIVE_RECHECK_HELD"], saved.report.observationDigests, saved.compilation.digest)
  }
  return saved.report
}

/**
 * A switch uses read-only native rechecks followed by the owner's registry CAS.
 * Filesystem observations and registry commit are not one atomic transaction.
 * HTTP requires a separately pinned host allowlist. Other remote schemes hold.
 */
export const switchNativeProfile = async (store: NativeProfileStore, input: unknown) => {
  const request = switchSchema.parse(contractSnapshot(input, 2 * 1024 * 1024))
  const manifest = parseNativeProfileManifest(request.manifest), environment = parseNativeProfileEnvironment(request.environment)
  const read = store.read.bind(store), activate = store.activate.bind(store)
  const current = await read()
  if (current.digest !== request.expectedStateDigest) return freezeContract({ status: "CONFLICT" as const, reason: "STALE_STATE" })
  if (manifest.ownerNamespace !== current.ownerNamespace) return freezeContract({ status: "HOLD" as const, reason: "OWNER_NAMESPACE_MISMATCH" })
  if (current.active !== null && manifest.graphDigest !== current.active.manifest.graphDigest) return freezeContract({ status: "HOLD" as const, reason: "ENVIRONMENT_SWITCH_MUST_PRESERVE_SOURCE_GRAPH" })
  if (manifest.selections.length > request.maxResources) return freezeContract({ status: "HOLD" as const, reason: "OBSERVATION_RESOURCE_BUDGET" })
  const snapshot = createNativeProfileSnapshot(manifest, current.generation + 1, contractDigest(environment))
  const prepared = await prepareNativeProfileObservation(request.graph, snapshot, environment, request.maxResources)
  if (prepared.report.status !== "PASS") return freezeContract({ status: "HOLD" as const, reason: prepared.report.reasons[0] ?? "NATIVE_OBSERVATION_HELD", observation: prepared.report })
  const checked = await recheckNativeProfileObservation(prepared)
  if (checked.status !== "PASS") return freezeContract({ status: "HOLD" as const, reason: checked.reasons[0] ?? "NATIVE_RECHECK_HELD", observation: checked })
  const compiled = prepared.compilation
  if (compiled === undefined) return freezeContract({ status: "HOLD" as const, reason: "PREPARED_OBSERVATION_UNAVAILABLE", observation: checked })
  const result = await activate(request.expectedStateDigest, snapshot)
  if (result.status !== "COMMITTED") return result
  return freezeContract({ ...result, compilation: compiled, observationDigests: prepared.report.observationDigests,
    consistency: "READ_ONLY_OBSERVATIONS_THEN_OWNER_CAS" as const, execution: "NOT_REQUESTED" as const })
}
