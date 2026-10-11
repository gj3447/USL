/** Required-source delivery through owner-registered loaders and invocation targets. */
import { createHash } from "node:crypto"
import { z } from "zod"
import { contractDigest, contractHash, contractIri, contractSnapshot, freezeContract } from "../contract-core.js"
import { checkNativeRequiredReads, createNativeReadReceipt, parseNativeProfileSnapshot, type NativeReadReceipt, type NativeRequiredSource } from "./native-profile.js"

export interface NativeReadRequest {
  readonly source: NativeRequiredSource
  readonly snapshotDigest: string
  readonly invocationId: string
  readonly maxBytes: number
  readonly signal: AbortSignal
}
export interface NativeDeliveryRequest extends Omit<NativeReadRequest, "maxBytes"> {
  readonly loaderId: string
  readonly targetId: string
  readonly bytes: Uint8Array
}
export interface NativeDeliveryHost {
  readonly loaderId: string
  readonly targetId: string
  readonly maxBytes?: number
  readonly timeoutMs?: number
  /** The registered loader must enforce its own access scope and honor cancellation. */
  readonly read: (request: NativeReadRequest) => Promise<{ readonly bytes: Uint8Array; readonly revision: string }>
  /** This is a delivery acknowledgement, never proof of model understanding. */
  readonly deliver: (request: NativeDeliveryRequest) => Promise<unknown>
}
export interface NativeDeliveryReport {
  readonly schema: "usl-native-delivery/v1"
  readonly snapshotDigest: string
  readonly invocationId: string
  readonly loaderId: string
  readonly targetId: string
  readonly status: "PASS" | "HOLD"
  readonly receipts: readonly NativeReadReceipt[]
  readonly reasons: readonly string[]
  readonly authority: "NOT_GRANTED"
  readonly acknowledgement: "DELIVERY_ACK_ONLY_NOT_COMPREHENSION"
  readonly automaticRetry: false
  readonly digest: string
}
export interface PreparedNativeDelivery {
  readonly schema: "usl-prepared-native-delivery/v1"
  readonly report: NativeDeliveryReport
  readonly limitation: "PROCESS_LOCAL;REVOKE_ON_CONTEXT_LOSS;OWNER_CALLBACKS"
}
const delivered = new WeakMap<object, NativeDeliveryReport>()
const byteLimit = z.number().int().min(1).max(16 * 1024 * 1024)
const duration = z.number().int().min(1).max(60_000)
const acknowledgement = z.strictObject({ snapshotDigest: contractHash, invocationId: contractIri, sourceId: contractIri,
  loaderId: contractIri, targetId: contractIri, deliveredDigest: contractHash, deliveredBytes: z.number().int().min(0).max(16 * 1024 * 1024) })
const hash = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`
class DeliveryHeld extends Error {}
const hold = (reason: string): never => { throw new DeliveryHeld(reason) }

/** RFC 6901 existence check. The full backing document is delivered even for a logical selector. */
const checkSelector = (source: NativeRequiredSource, bytes: Uint8Array): void => {
  if (source.selector.kind === "whole") return
  let value: unknown
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) }
  catch { hold("REQUIRED_SOURCE_NOT_UTF8_JSON") }
  for (const encoded of source.selector.value.split("/").slice(1)) {
    const token = encoded.replace(/~1/gu, "/").replace(/~0/gu, "~")
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, token)) hold("REQUIRED_SELECTOR_MISSING")
    if (Array.isArray(value) && !/^(?:0|[1-9][0-9]*)$/u.test(token)) hold("REQUIRED_SELECTOR_MISSING")
    value = (value as Record<string, unknown>)[token]
  }
}

/**
 * Runs a registered loader and target under a shared deadline and byte budget.
 * A timeout revokes this attempt; cancellation of owner callbacks is cooperative.
 * No document, URL or graph can supply these callbacks or authorize their access.
 */
export const deliverNativeRequiredSources = async (snapshotInput: unknown, invocationIdInput: string, host: NativeDeliveryHost): Promise<PreparedNativeDelivery> => {
  const snapshot = parseNativeProfileSnapshot(snapshotInput), invocationId = contractIri.parse(invocationIdInput)
  const loaderId = contractIri.parse(host.loaderId), targetId = contractIri.parse(host.targetId)
  const maxBytes = byteLimit.parse(host.maxBytes ?? 1024 * 1024), timeoutMs = duration.parse(host.timeoutMs ?? 15_000)
  if (typeof host.read !== "function" || typeof host.deliver !== "function") throw new Error("owner loader and target callbacks are required")
  const read = host.read.bind(host), deliver = host.deliver.bind(host)
  const receipts: NativeReadReceipt[] = [], reasons: string[] = []
  const controller = new AbortController()
  let rejectDeadline!: (error: Error) => void
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject })
  // Register a handler even if an upfront budget check holds before the first callback.
  void deadline.catch(() => undefined)
  const timer = setTimeout(() => { controller.abort(); rejectDeadline(new DeliveryHeld("DELIVERY_TIMEOUT_UNKNOWN")) }, timeoutMs)
  const bounded = <T>(task: () => Promise<T>): Promise<T> => Promise.race([Promise.resolve().then(task), deadline])
  try {
    const expectedBytes = snapshot.manifest.requiredSources.reduce((sum, source) => sum + source.bytes, 0)
    if (expectedBytes > maxBytes) hold("REQUIRED_DELIVERY_BYTE_BUDGET")
    for (const source of snapshot.manifest.requiredSources) {
      const common = { source, snapshotDigest: snapshot.digest, invocationId }
      const result = await bounded(() => read(Object.freeze({ ...common, maxBytes: source.bytes, signal: controller.signal })))
      const returnedBytes = result?.bytes, revision = result?.revision
      if (!(returnedBytes instanceof Uint8Array) || returnedBytes.byteLength !== source.bytes) hold("REQUIRED_SOURCE_LENGTH_MISMATCH")
      if (revision !== source.revision) hold("REQUIRED_SOURCE_REVISION_MISMATCH")
      // Copy at the trust boundary: later loader mutation cannot alter the pinned bytes.
      const bytes = new Uint8Array(returnedBytes)
      if (hash(bytes) !== source.digest) hold("REQUIRED_SOURCE_DIGEST_MISMATCH")
      checkSelector(source, bytes)
      const expected = { snapshotDigest: snapshot.digest, invocationId, sourceId: source.id, loaderId, targetId,
        deliveredDigest: source.digest, deliveredBytes: bytes.byteLength }
      const ackInput = await bounded(() => deliver(Object.freeze({ ...common, loaderId, targetId, bytes, signal: controller.signal })))
      if (hash(bytes) !== source.digest) hold("DELIVERED_PAYLOAD_MUTATED")
      const ack = (() => {
        try { return acknowledgement.parse(contractSnapshot(ackInput)) }
        catch { return hold("DELIVERY_ACK_INVALID") }
      })()
      if (contractDigest(ack) !== contractDigest(expected)) hold("DELIVERY_ACK_MISMATCH")
      receipts.push(createNativeReadReceipt({ schema: "usl-native-read-receipt/v1", ...common,
        deliveredDigest: source.digest, deliveredBytes: source.bytes, coverage: "FULL_BACKING_DOCUMENT",
        acknowledgedBy: targetId, acknowledgement: "DELIVERY_ACK_ONLY_NOT_COMPREHENSION" }))
    }
    if (checkNativeRequiredReads(snapshot, invocationId, receipts).status !== "PASS") hold("REQUIRED_SOURCE_COVERAGE")
  } catch (error) { reasons.push(error instanceof DeliveryHeld ? error.message : "OWNER_DELIVERY_FAILED") }
  finally { clearTimeout(timer); controller.abort() }
  const body = { schema: "usl-native-delivery/v1" as const, snapshotDigest: snapshot.digest, invocationId, loaderId, targetId,
    status: reasons.length ? "HOLD" as const : "PASS" as const, receipts, reasons, authority: "NOT_GRANTED" as const,
    acknowledgement: "DELIVERY_ACK_ONLY_NOT_COMPREHENSION" as const, automaticRetry: false as const }
  const report = freezeContract({ ...body, digest: contractDigest(body) })
  const handle = freezeContract({ schema: "usl-prepared-native-delivery/v1" as const, report,
    limitation: "PROCESS_LOCAL;REVOKE_ON_CONTEXT_LOSS;OWNER_CALLBACKS" as const })
  if (report.status === "PASS") delivered.set(handle, report)
  return handle
}

/** Serialized receipts cannot stand in for actual delivery by this runtime. */
export const checkNativeDelivery = (handle: unknown, snapshotInput: unknown, invocationId: string, targetId: string) => {
  const snapshot = parseNativeProfileSnapshot(snapshotInput)
  contractIri.parse(invocationId); contractIri.parse(targetId)
  const report = handle !== null && typeof handle === "object" ? delivered.get(handle) : undefined
  const reasons: string[] = []
  if (!report) reasons.push("LIVE_DELIVERY_HANDLE_REQUIRED")
  else if (report.snapshotDigest !== snapshot.digest || report.invocationId !== invocationId || report.targetId !== targetId) reasons.push("DELIVERY_CONTEXT_MISMATCH")
  else if (checkNativeRequiredReads(snapshot, invocationId, report.receipts).status !== "PASS") reasons.push("REQUIRED_SOURCE_COVERAGE")
  return freezeContract({ status: reasons.length ? "HOLD" as const : "PASS" as const, reasons, deliveryDigest: report?.digest ?? null, authority: "NOT_GRANTED" as const })
}
/** The host must revoke on compaction, handoff, target loss, or any loss of the delivered context. */
export const revokeNativeDelivery = (handle: unknown): void => {
  if (handle !== null && typeof handle === "object") delivered.delete(handle)
}
