/** Optional native profile contracts. These declarations never grant access or execute actions. */
import { z } from "zod"
import { contractDigest, contractHash, contractIri, contractSnapshot, contractText, freezeContract, uniqueContractIds } from "../contract-core.js"
import { parseResourceBindings, selectResourceRepresentation, type ResourceBindings } from "../resource-bindings.js"

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/u).max(256)
const generation = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1)
const byteLength = z.number().int().min(0).max(16 * 1024 * 1024)
const instant = z.string().refine(value => {
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}, "expected canonical UTC ISO timestamp")
const selectorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("whole") }),
  z.strictObject({ kind: z.literal("json-pointer"), value: z.string().min(1).max(4096).regex(/^\/(?:[^~]|~[01])*$/u) }),
])
const selectionSchema = z.strictObject({ resource: contractText, representation: identifier })
const requiredSourceSchema = z.strictObject({
  id: contractIri, ...selectionSchema.shape, selector: selectorSchema, revision: contractText,
  /** The digest/length always describe the complete backing document, including for a logical JSON selector. */
  digest: contractHash, bytes: byteLength,
})
const evaluatorSchema = z.strictObject({ id: contractIri, digest: contractHash })
const capabilitySchema = z.strictObject({ id: contractIri, descriptorDigest: contractHash, scopeDigest: contractHash })
const manifestSchema = z.strictObject({
  schema: z.literal("usl-native-profile/v1"), id: contractIri, ownerNamespace: contractIri,
  workspaceAliases: z.array(identifier).max(256), bindings: z.unknown(),
  selections: z.array(selectionSchema).min(1).max(1024),
  graphDigest: contractHash, policy: z.strictObject({ id: contractIri, digest: contractHash }),
  requiredSources: z.array(requiredSourceSchema).max(256),
  requiredEvaluators: z.array(evaluatorSchema).max(256),
  capabilities: z.array(capabilitySchema).max(256),
})
export type NativeRequiredSource = z.infer<typeof requiredSourceSchema>
export type NativeProfileManifest = Omit<z.infer<typeof manifestSchema>, "bindings"> & { readonly bindings: ResourceBindings }
export interface NativeProfileSnapshot {
  readonly schema: "usl-native-profile-snapshot/v1"
  readonly manifest: NativeProfileManifest
  readonly manifestDigest: string
  readonly generation: number
  /** Digest of the independently registered host mapping; roots do not enter the portable manifest. */
  readonly hostBindingDigest: string
  readonly digest: string
}
const snapshotSchema = z.strictObject({ schema: z.literal("usl-native-profile-snapshot/v1"), manifest: z.unknown(),
  manifestDigest: contractHash, generation, hostBindingDigest: contractHash, digest: contractHash })
const require = (condition: unknown, reason: string): void => { if (!condition) throw new Error(reason) }
const equal = (a: unknown, b: unknown): boolean => contractDigest(a) === contractDigest(b)
const checkedDigest = <T extends { digest: string }>(value: T): T => {
  const { digest, ...body } = value
  require(contractDigest(body) === digest, "native contract digest mismatch")
  return freezeContract(value)
}
const sealed = <T extends object>(value: T): T & { readonly digest: string } => freezeContract({ ...value, digest: contractDigest(value) })

export const parseNativeProfileManifest = (input: unknown): NativeProfileManifest => {
  const raw = manifestSchema.parse(contractSnapshot(input))
  const bindings = parseResourceBindings(raw.bindings)
  uniqueContractIds(raw.workspaceAliases, "workspace alias")
  uniqueContractIds(raw.selections.map(s => s.resource), "selected resource")
  uniqueContractIds(raw.requiredSources.map(s => s.id), "required source")
  uniqueContractIds(raw.requiredSources.map(({ resource, representation, selector, revision }) => contractDigest({ resource, representation, selector, revision })), "required source tuple")
  uniqueContractIds(raw.requiredEvaluators.map(e => e.id), "required evaluator")
  uniqueContractIds(raw.capabilities.map(c => c.id), "capability")
  require(raw.selections.length === bindings.resources.length, "every profile resource needs one explicit selection")
  for (const binding of bindings.resources) for (const representation of binding.representations) {
    if (representation.kind === "workspace") require(raw.workspaceAliases.includes(representation.workspace), "unregistered profile workspace alias")
  }
  for (const selection of raw.selections) selectResourceRepresentation(bindings, selection)
  const documentPins = new Map<string, string>()
  for (const source of raw.requiredSources) {
    require(raw.selections.some(s => s.resource === source.resource && s.representation === source.representation), "required source is not selected")
    const selected = selectResourceRepresentation(bindings, { resource: source.resource, representation: source.representation })
    require(selected.representation.digest === undefined || selected.representation.digest === source.digest, "required source conflicts with binding content pin")
    const key = contractDigest({ resource: source.resource, representation: source.representation })
    const pin = contractDigest({ revision: source.revision, digest: source.digest, bytes: source.bytes })
    require(!documentPins.has(key) || documentPins.get(key) === pin, "selected document has conflicting required-source pins")
    documentPins.set(key, pin)
  }
  return freezeContract({ ...raw, bindings })
}

export const createNativeProfileSnapshot = (input: unknown, nextGeneration: number, hostBindingDigest: string): NativeProfileSnapshot => {
  const manifest = parseNativeProfileManifest(input)
  return sealed({ schema: "usl-native-profile-snapshot/v1" as const, manifest, manifestDigest: contractDigest(manifest),
    generation: generation.parse(nextGeneration), hostBindingDigest: contractHash.parse(hostBindingDigest) })
}
export const parseNativeProfileSnapshot = (input: unknown): NativeProfileSnapshot => {
  const raw = snapshotSchema.parse(contractSnapshot(input)), manifest = parseNativeProfileManifest(raw.manifest)
  require(contractDigest(manifest) === raw.manifestDigest, "profile manifest digest mismatch")
  return checkedDigest({ ...raw, manifest })
}

const readBodySchema = z.strictObject({
  schema: z.literal("usl-native-read-receipt/v1"), snapshotDigest: contractHash, invocationId: contractIri,
  source: requiredSourceSchema, deliveredDigest: contractHash, deliveredBytes: byteLength,
  coverage: z.literal("FULL_BACKING_DOCUMENT"), acknowledgedBy: contractIri,
  acknowledgement: z.literal("DELIVERY_ACK_ONLY_NOT_COMPREHENSION"),
})
export type NativeReadReceipt = z.infer<typeof readBodySchema> & { readonly digest: string }
export const createNativeReadReceipt = (input: unknown): NativeReadReceipt => {
  const value = readBodySchema.parse(contractSnapshot(input))
  require(value.deliveredDigest === value.source.digest && value.deliveredBytes === value.source.bytes, "required document delivery is incomplete or differs")
  return sealed(value)
}
export const parseNativeReadReceipt = (input: unknown): NativeReadReceipt => {
  const { digest, ...body } = readBodySchema.extend({ digest: contractHash }).parse(contractSnapshot(input))
  const expected = createNativeReadReceipt(body)
  require(expected.digest === digest, "read receipt digest mismatch")
  return expected
}
/** Validate full source coverage. A receipt is an assertion by a registered loader, not proof of understanding. */
export const checkNativeRequiredReads = (snapshotInput: unknown, invocationId: string, receiptInputs: readonly unknown[]) => {
  const snapshot = parseNativeProfileSnapshot(snapshotInput)
  contractIri.parse(invocationId)
  const receipts = receiptInputs.map(parseNativeReadReceipt)
  uniqueContractIds(receipts.map(r => r.source.id), "read receipt source")
  const expected = snapshot.manifest.requiredSources
  const reasons: string[] = []
  if (receipts.length !== expected.length) reasons.push("REQUIRED_SOURCE_COVERAGE")
  for (const source of expected) {
    const receipt = receipts.find(r => r.source.id === source.id)
    if (!receipt || receipt.snapshotDigest !== snapshot.digest || receipt.invocationId !== invocationId || !equal(receipt.source, source)) reasons.push("REQUIRED_SOURCE_MISMATCH")
  }
  return sealed({ schema: "usl-native-required-reads/v1" as const, snapshotDigest: snapshot.digest, invocationId,
    status: reasons.length ? "HOLD" as const : "PASS" as const, reasons,
    receiptDigests: receipts.map(r => r.digest), authority: "NOT_GRANTED" as const })
}

const evaluationSchema = z.strictObject({ schema: z.literal("usl-native-evaluator-receipt/v1"),
  evaluator: evaluatorSchema, snapshotDigest: contractHash, invocationId: contractIri, inputDigest: contractHash,
  status: z.enum(["PASS", "FAIL", "UNKNOWN"]), evidenceDigest: contractHash })
export type NativeEvaluatorReceipt = z.infer<typeof evaluationSchema> & { readonly digest: string }
export const createNativeEvaluatorReceipt = (input: unknown): NativeEvaluatorReceipt => sealed(evaluationSchema.parse(contractSnapshot(input)))
export const parseNativeEvaluatorReceipt = (input: unknown): NativeEvaluatorReceipt => checkedDigest(evaluationSchema.extend({ digest: contractHash }).parse(contractSnapshot(input)))
export const checkNativeEvaluations = (snapshotInput: unknown, invocationId: string, inputDigest: string, inputs: readonly unknown[]) => {
  const snapshot = parseNativeProfileSnapshot(snapshotInput)
  contractIri.parse(invocationId); contractHash.parse(inputDigest)
  const receipts = inputs.map(parseNativeEvaluatorReceipt)
  uniqueContractIds(receipts.map(r => r.evaluator.id), "evaluator receipt")
  const expected = snapshot.manifest.requiredEvaluators, reasons: string[] = []
  if (receipts.length !== expected.length) reasons.push("EVALUATOR_COVERAGE")
  for (const evaluator of expected) {
    const receipt = receipts.find(r => r.evaluator.id === evaluator.id)
    if (!receipt || !equal(receipt.evaluator, evaluator) || receipt.snapshotDigest !== snapshot.digest || receipt.invocationId !== invocationId || receipt.inputDigest !== inputDigest || receipt.status !== "PASS") reasons.push("EVALUATOR_NOT_PASS")
  }
  return sealed({ schema: "usl-native-evaluations/v1" as const, snapshotDigest: snapshot.digest, invocationId, inputDigest,
    status: reasons.length ? "HOLD" as const : "PASS" as const, reasons, receiptDigests: receipts.map(r => r.digest), authority: "NOT_GRANTED" as const })
}

const admissionRequestSchema = z.strictObject({
  id: contractIri, invocationId: contractIri, actionId: contractIri, scopeDigest: contractHash, inputDigest: contractHash,
  observationDigest: contractHash, deliveryDigest: contractHash, evaluatorDigest: contractHash,
  issuedAt: instant, expiresAt: instant,
})
const admissionBodySchema = admissionRequestSchema.extend({
  schema: z.literal("usl-native-admission/v1"), ownerNamespace: contractIri, profileId: contractIri,
  generation, snapshotDigest: contractHash, authority: z.literal("OWNER_HOST_ONLY"),
})
export type NativeAdmission = z.infer<typeof admissionBodySchema> & { readonly digest: string }
const checkAdmissionTime = (admission: z.infer<typeof admissionRequestSchema>) => {
  const ttl = Date.parse(admission.expiresAt) - Date.parse(admission.issuedAt)
  require(ttl > 0 && ttl <= 15 * 60_000, "admission TTL must be positive and at most 15 minutes")
}
/** Data contract only. The owner registry must independently issue, persist, and consume this declaration. */
export const createNativeAdmission = (input: unknown, snapshotInput: unknown): NativeAdmission => {
  const snapshot = parseNativeProfileSnapshot(snapshotInput), request = admissionRequestSchema.parse(contractSnapshot(input))
  checkAdmissionTime(request)
  require(snapshot.manifest.capabilities.some(c => c.id === request.actionId && c.scopeDigest === request.scopeDigest), "action/scope absent from pinned profile")
  return sealed({ schema: "usl-native-admission/v1" as const, ...request, ownerNamespace: snapshot.manifest.ownerNamespace,
    profileId: snapshot.manifest.id, generation: snapshot.generation, snapshotDigest: snapshot.digest, authority: "OWNER_HOST_ONLY" as const })
}
export const parseNativeAdmission = (input: unknown): NativeAdmission => {
  const value = admissionBodySchema.extend({ digest: contractHash }).parse(contractSnapshot(input))
  checkAdmissionTime(value)
  return checkedDigest(value)
}

const effectSchema = z.strictObject({
  schema: z.literal("usl-native-effect-receipt/v1"), attemptId: contractIri, admissionDigest: contractHash,
  dispatch: z.enum(["NOT_DISPATCHED", "DISPATCHED"]), outcome: z.enum(["SUCCEEDED", "FAILED", "UNKNOWN"]),
  sourceStatus: z.enum(["REJECTED", "SUCCEEDED", "INDETERMINATE", "OWNER_REPORTED"]), sourceReceiptDigest: contractHash,
  reason: contractText.nullable(), automaticRetry: z.literal(false),
})
export type NativeEffectReceipt = z.infer<typeof effectSchema> & { readonly digest: string }
export const createNativeEffectReceipt = (input: unknown): NativeEffectReceipt => {
  const value = effectSchema.parse(contractSnapshot(input))
  require(!(value.dispatch === "NOT_DISPATCHED" && value.outcome === "SUCCEEDED"), "an undispatched action cannot succeed")
  if (value.sourceStatus === "INDETERMINATE") require(value.outcome === "UNKNOWN", "indeterminate effects must remain unknown")
  if (value.sourceStatus === "REJECTED") require(value.dispatch === "NOT_DISPATCHED" && value.outcome === "FAILED", "rejected CLI action did not dispatch")
  if (value.sourceStatus === "SUCCEEDED") require(value.dispatch === "DISPATCHED" && value.outcome === "SUCCEEDED", "CLI success mapping differs")
  return sealed(value)
}
export const parseNativeEffectReceipt = (input: unknown): NativeEffectReceipt => {
  const { digest, ...body } = effectSchema.extend({ digest: contractHash }).parse(contractSnapshot(input))
  const expected = createNativeEffectReceipt(body)
  require(expected.digest === digest, "effect receipt digest mismatch")
  return expected
}
export const mapNativeCliEffect = (input: { readonly attemptId: string; readonly admissionDigest: string; readonly sourceStatus: "REJECTED" | "SUCCEEDED" | "INDETERMINATE"; readonly sourceReceiptDigest: string; readonly reason: string | null }): NativeEffectReceipt => {
  const value = contractSnapshot(input)
  return createNativeEffectReceipt({ schema: "usl-native-effect-receipt/v1", ...value,
    dispatch: value.sourceStatus === "REJECTED" ? "NOT_DISPATCHED" : "DISPATCHED",
    outcome: value.sourceStatus === "INDETERMINATE" ? "UNKNOWN" : value.sourceStatus === "SUCCEEDED" ? "SUCCEEDED" : "FAILED", automaticRetry: false })
}
