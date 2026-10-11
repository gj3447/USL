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
  const compiled = await compileNativeProfileGraph(request.graph, snapshot, environment)
  const observations: Array<{ readonly digest: string; readonly recheck: () => Promise<{ readonly status: "PASS" | "HOLD" }> }> = []
  for (const selection of manifest.selections) {
    const resolved = compiled.bindingReceipt.selections.find(item => item.resource === selection.resource)!
    const requiredSource = manifest.requiredSources.find(source => source.resource === selection.resource)
    const expectedDigest = resolved.expectedDigest ?? requiredSource?.digest
    const httpPolicy = environment.httpPolicies.find(policy => policy.resource === selection.resource)
    if (httpPolicy !== undefined) {
      if (httpPolicy.representation !== selection.representation || httpPolicy.url !== resolved.locator || resolved.kind !== "locator") return freezeContract({ status: "HOLD" as const, reason: "HTTP_REGISTRATION_MISMATCH" })
      const { resource: _resource, representation: _representation, accept, ...httpInput } = httpPolicy
      const prepared = await prepareNativeHttp({ ...httpInput, ...(accept === undefined ? {} : { accept }) })
      if (prepared.report.status !== "PASS" || (expectedDigest !== undefined && prepared.report.bodyDigest !== expectedDigest) || (requiredSource !== undefined && prepared.report.bytes !== requiredSource.bytes)) return freezeContract({ status: "HOLD" as const, reason: "HTTP_OBSERVATION_HELD", observation: prepared.report })
      observations.push({ digest: prepared.report.digest, recheck: () => recheckNativeHttp(prepared) })
      continue
    }
    const policy = environment.checkoutPolicies.find(p => p.resource === selection.resource)
    const prepared = await prepareNativeObservation(manifest.bindings, selection, { workspaces: environment.workspaces,
      ...(policy === undefined ? {} : { checkout: { policy, checkouts: environment.checkouts } }) })
    if (prepared.report.status !== "PASS" || (expectedDigest !== undefined && prepared.report.content.digest !== expectedDigest) || (requiredSource !== undefined && prepared.report.content.bytes !== requiredSource.bytes)) return freezeContract({ status: "HOLD" as const, reason: "NATIVE_OBSERVATION_HELD", observation: prepared.report })
    observations.push({ digest: prepared.report.digest, recheck: () => recheckNativeObservation(prepared) })
  }
  const fresh = await compileNativeProfileGraph(request.graph, snapshot, environment)
  if (fresh.digest !== compiled.digest) return freezeContract({ status: "HOLD" as const, reason: "PROFILE_BINDING_CHANGED" })
  for (const prepared of observations) {
    const report = await prepared.recheck()
    if (report.status !== "PASS") return freezeContract({ status: "HOLD" as const, reason: "NATIVE_RECHECK_HELD", observation: report })
  }
  const result = await activate(request.expectedStateDigest, snapshot)
  if (result.status !== "COMMITTED") return result
  return freezeContract({ ...result, compilation: compiled, observationDigests: observations.map(o => o.digest),
    consistency: "READ_ONLY_OBSERVATIONS_THEN_OWNER_CAS" as const, execution: "NOT_REQUESTED" as const })
}
