/** Read-only inspection and owner-bound reconciliation for durable CLI attempts.
 * This module deliberately has no dependency on cli-host: callers inject one
 * registered owner query, while receipt files remain the evidence boundary.
 */
import { constants } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { z } from "zod"
import { contractDigest, contractHash, contractSnapshot, contractText, freezeContract } from "./contract-core.js"

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024
const MAX_EVIDENCE_BYTES = 1024 * 1024
const digest = contractHash

const planSchema = z.object({ schema: z.literal("usl-cli-plan/v1"), status: z.literal("READY"),
  planDigest: digest, action: contractText, hostDigest: digest, bindingsDigest: digest, requestDigest: digest }).passthrough()
const intentSchema = z.object({
  schema: z.literal("usl-cli-intent/v1"), attempt: contractText, startedAt: z.string().datetime(),
  plan: planSchema,
  status: z.literal("ATTEMPTING"), recovery: contractText, intentDigest: digest,
  operation: z.object({ namespace: contractText, key: contractText, semanticDigest: digest }).strict().optional(),
}).passthrough()
const resultSchema = z.object({
  schema: z.literal("usl-cli-execution/v1"), status: z.enum(["SUCCEEDED", "INDETERMINATE", "REJECTED"]),
  attempt: contractText, attempts: z.number().int().min(0).max(1), startedAt: z.string().datetime(), finishedAt: z.string().datetime(),
  planDigest: digest, intentDigest: digest, receiptDigest: digest, automaticRetry: z.literal(false).optional(),
  reason: z.string().nullable(), output: z.unknown().optional(),
  process: z.object({ started: z.boolean(), exitCode: z.number().int().nullable(), reason: z.string().nullable() }).passthrough().optional(),
  lifecycle: z.object({ phase: z.enum(["REJECTED", "SUCCEEDED", "INDETERMINATE"]) }).passthrough().optional(),
}).passthrough()
const reconciliationSchema = z.object({
  schema: z.literal("usl-cli-reconciliation/v1"), origin: z.literal("REGISTERED_OWNER_CALLBACK"),
  attempt: contractText, intentDigest: digest, planDigest: digest, requestDigest: digest,
  action: contractText, hostDigest: digest, bindingsDigest: digest, inspectionDigest: digest, reconcilerId: contractText,
  queriedAt: z.string().datetime(), observedAt: z.string().datetime(), externalOutcome: z.enum(["APPLIED", "NOT_APPLIED", "UNKNOWN"]),
  evidence: z.array(z.object({ locator: contractText, digest }).strict()).max(1024),
  queryDigest: digest, observationDigest: digest, automaticRetry: z.literal(false), reconciliationDigest: digest,
}).strict()

const without = (value: Record<string, unknown>, field: string) => {
  const copy = { ...value }; delete copy[field]; return copy
}
const checkDigest = (value: Record<string, unknown>, field: string) => {
  if (value[field] !== contractDigest(without(value, field))) throw new Error(`invalid ${field}`)
}
const same = (a: unknown, b: unknown) => contractDigest(a) === contractDigest(b)
const abort = (signal?: AbortSignal) => signal?.throwIfAborted()

/** Read a single leaf without following symlinks or accidentally blocking on a FIFO. */
const readLeaf = async (directory: string, name: string, maxBytes: number, signal?: AbortSignal): Promise<{ value: unknown; bytes: number }> => {
  abort(signal)
  const path = resolve(directory, name)
  if (dirname(path) !== directory) throw new Error("invalid receipt leaf")
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  const handle = await open(path, flags)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error("receipt evidence must be a regular file")
    const chunks: Buffer[] = []; let total = 0
    while (total <= maxBytes) {
      abort(signal)
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total)
      if (bytesRead === 0) break
      chunks.push(chunk.subarray(0, bytesRead)); total += bytesRead
    }
    if (total > maxBytes) throw new Error("receipt byte budget exceeded")
    let value: unknown
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total))) }
    catch { throw new Error("receipt evidence must be valid UTF-8 JSON") }
    return { value: contractSnapshot(value, maxBytes), bytes: total }
  } finally { await handle.close() }
}

const optionalLeaf = async (directory: string, name: string, maxBytes: number, signal?: AbortSignal) => {
  try { return await readLeaf(directory, name, maxBytes, signal) }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

export interface CliAttemptInspection {
  readonly schema: "usl-cli-attempt-inspection/v1"
  readonly attempt: string
  readonly intent: Readonly<Record<string, unknown>>
  readonly result?: Readonly<Record<string, unknown>>
  readonly reconciliation?: Readonly<Record<string, unknown>>
  readonly status: "UNKNOWN" | "RECORDED"
  readonly recordedStatus?: "SUCCEEDED" | "INDETERMINATE" | "REJECTED"
  readonly executionStart: "UNKNOWN" | "RECORDED"
  readonly externalEffect: "UNKNOWN"
  readonly automaticRetry: false
  readonly inspectionDigest: string
  /** A durable lock blocks another owner callback; it is deliberately outside the content digest. */
  readonly recoveryLock: boolean
}

const inspectInternal = async (receiptDirectory: string, options: { maxBytes?: number; signal?: AbortSignal } = {}) => {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_BYTES) throw new Error("invalid receipt byte budget")
  abort(options.signal)
  const directory = resolve(receiptDirectory), directoryInfo = await lstat(directory)
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error("receipt directory must be a real directory")
  let remaining = maxBytes
  const intentLeaf = await readLeaf(directory, "intent.json", remaining, options.signal); remaining -= intentLeaf.bytes
  const intent = intentSchema.parse(intentLeaf.value) as Record<string, unknown>
  checkDigest(intent, "intentDigest")
  checkDigest(intent.plan as Record<string, unknown>, "planDigest")
  const resultLeaf = await optionalLeaf(directory, "result.json", remaining, options.signal)
  if (resultLeaf !== undefined) remaining -= resultLeaf.bytes
  const result = resultLeaf === undefined ? undefined : resultSchema.parse(resultLeaf.value) as Record<string, unknown>
  if (result) {
    checkDigest(result, "receiptDigest")
    if (result.attempt !== intent.attempt || result.intentDigest !== intent.intentDigest || result.planDigest !== (intent.plan as { planDigest: string }).planDigest ||
      result.startedAt !== intent.startedAt || new Date(result.finishedAt as string).getTime() < new Date(intent.startedAt as string).getTime()) throw new Error("result does not belong to intent")
    if (result.status === "REJECTED" && result.attempts !== 0) throw new Error("rejected receipt has attempts")
    if (result.status !== "REJECTED" && result.attempts !== 1) throw new Error("terminal receipt has invalid attempts")
    const processEvidence = result.process as { started: boolean; exitCode: number | null; reason: string | null } | undefined
    if (result.status === "REJECTED" && processEvidence?.started === true) throw new Error("rejected receipt cannot claim a started process")
    if (result.attempts === 1 && processEvidence?.started !== true) throw new Error("started attempt lacks process evidence")
    if (result.status === "SUCCEEDED" && (processEvidence === undefined || processEvidence.exitCode !== 0 || processEvidence.reason !== null)) throw new Error("successful receipt has invalid process evidence")
    if (result.status === "SUCCEEDED" && (result.reason !== null || !Object.hasOwn(result, "output"))) throw new Error("successful receipt lacks a successful output")
    const lifecycle = result.lifecycle as { phase: string } | undefined
    if (lifecycle !== undefined && lifecycle.phase !== result.status) throw new Error("result lifecycle differs from status")
    if (result.automaticRetry !== undefined && result.automaticRetry !== false) throw new Error("automatic retry is forbidden")
  }
  const base = { schema: "usl-cli-attempt-inspection/v1" as const, attempt: intent.attempt as string, intent,
    ...(result === undefined ? {} : { result }), status: result === undefined ? "UNKNOWN" as const : "RECORDED" as const,
    ...(result === undefined ? {} : { recordedStatus: result.status as "SUCCEEDED" | "INDETERMINATE" | "REJECTED" }),
    executionStart: result === undefined ? "UNKNOWN" as const : "RECORDED" as const, externalEffect: "UNKNOWN" as const, automaticRetry: false as const }
  const baseDigest = contractDigest(base)
  const reconciliationLeaf = await optionalLeaf(directory, "reconciliation.json", remaining, options.signal)
  if (reconciliationLeaf !== undefined) remaining -= reconciliationLeaf.bytes
  const reconciliation = reconciliationLeaf === undefined ? undefined : reconciliationSchema.parse(reconciliationLeaf.value) as Record<string, unknown>
  if (reconciliation) {
    checkDigest(reconciliation, "reconciliationDigest")
    const plan = intent.plan as Record<string, unknown>
    if ((result !== undefined && result.status !== "INDETERMINATE") || reconciliation.attempt !== intent.attempt || reconciliation.intentDigest !== intent.intentDigest ||
      reconciliation.planDigest !== plan.planDigest || reconciliation.requestDigest !== plan.requestDigest || reconciliation.action !== plan.action ||
      reconciliation.hostDigest !== plan.hostDigest || reconciliation.bindingsDigest !== plan.bindingsDigest || reconciliation.inspectionDigest !== baseDigest) throw new Error("reconciliation does not belong to unresolved intent")
    const context = { attempt: intent.attempt, intentDigest: intent.intentDigest, planDigest: plan.planDigest, requestDigest: plan.requestDigest,
      action: plan.action, ownerId: reconciliation.reconcilerId, ...(intent.operation === undefined ? {} : { operation: intent.operation }) }
    const registered = { id: reconciliation.reconcilerId, action: reconciliation.action, hostDigest: reconciliation.hostDigest, bindingsDigest: reconciliation.bindingsDigest }
    if (reconciliation.queryDigest !== contractDigest({ registration: registered, context }) ||
      reconciliation.observationDigest !== contractDigest({ outcome: reconciliation.externalOutcome, evidence: reconciliation.evidence, observedAt: reconciliation.observedAt })) throw new Error("reconciliation digest does not match its recorded evidence")
  }
  const body = { ...base, ...(reconciliation === undefined ? {} : { reconciliation }) }
  const lockPath = resolve(directory, "reconciliation.lock")
  let recoveryLock = false
  try { const lock = await lstat(lockPath); if (!lock.isFile() || lock.isSymbolicLink()) throw new Error("invalid reconciliation lock"); recoveryLock = true }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  return freezeContract({ ...body, inspectionDigest: contractDigest(body), recoveryLock }) as CliAttemptInspection
}

/** Inspect historical receipt files only; this performs no host lookup or execution. */
export const inspectCliAttempt = async (receiptDirectory: string, options: { maxBytes?: number; signal?: AbortSignal } = {}): Promise<CliAttemptInspection> =>
  inspectInternal(receiptDirectory, options)

export interface CliReconcilerRegistration {
  readonly id: string
  readonly action: string
  readonly hostDigest: string
  readonly bindingsDigest: string
  readonly query: (context: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<{ outcome: "APPLIED" | "NOT_APPLIED" | "UNKNOWN"; evidence: readonly { locator: string; digest: string }[]; observedAt: string }>
  readonly timeoutMs: number
  readonly maxEvidenceBytes: number
}

const registrationSchema = z.object({ id: contractText, action: contractText, hostDigest: digest, bindingsDigest: digest,
  timeoutMs: z.number().int().min(1).max(10 * 60 * 1000), maxEvidenceBytes: z.number().int().min(1).max(MAX_EVIDENCE_BYTES) }).strict()
const responseSchema = z.object({ outcome: z.enum(["APPLIED", "NOT_APPLIED", "UNKNOWN"]),
  evidence: z.array(z.object({ locator: contractText, digest }).strict()).max(1024), observedAt: z.string().datetime() }).strict()

const captureRegistration = (input: unknown) => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("reconciler registration must be an object")
  if (Object.getPrototypeOf(input) !== Object.prototype) throw new Error("reconciler registration must be a plain object")
  const descriptors = Object.getOwnPropertyDescriptors(input)
  const keys = ["id", "action", "hostDigest", "bindingsDigest", "query", "timeoutMs", "maxEvidenceBytes"]
  const ownKeys = Reflect.ownKeys(input)
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key)) || keys.some(key => descriptors[key] === undefined)) throw new Error("invalid reconciler registration fields")
  const value = (key: string) => {
    const descriptor = descriptors[key]
    if (descriptor === undefined || !("value" in descriptor)) throw new Error("reconciler registration getters are forbidden")
    return descriptor.value
  }
  const query = value("query")
  if (typeof query !== "function") throw new Error("reconciler query must be a function")
  const registration = freezeContract(registrationSchema.parse(contractSnapshot({ id: value("id"), action: value("action"), hostDigest: value("hostDigest"),
    bindingsDigest: value("bindingsDigest"), timeoutMs: value("timeoutMs"), maxEvidenceBytes: value("maxEvidenceBytes") })))
  return { registration, query: query as CliReconcilerRegistration["query"] }
}

const writeExclusive = async (directory: string, name: string, value: unknown) => {
  const handle = await open(resolve(directory, name), "wx", 0o600)
  try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); await handle.sync() } finally { await handle.close() }
  if (process.platform !== "win32") { const dir = await open(directory, "r"); try { await dir.sync() } finally { await dir.close() } }
}

export const connectCliReconciler = (input: CliReconcilerRegistration) => {
  const { registration, query } = captureRegistration(input)
  const reconcile = async (receiptDirectory: string, options: { expectedInspectionDigest: string; signal?: AbortSignal }) => {
    // Capture the caller's immutable expectation before the first await: a
    // mutable options object must not alter the receipt being authorized.
    const expectedInspectionDigest = contractHash.parse(options.expectedInspectionDigest), signal = options.signal
    abort(signal)
    const initial = await inspectInternal(receiptDirectory, signal === undefined ? {} : { signal })
    const eligible = initial.status === "UNKNOWN" || initial.recordedStatus === "INDETERMINATE"
    if (initial.inspectionDigest !== expectedInspectionDigest || !eligible || initial.reconciliation !== undefined || initial.recoveryLock) throw new Error("attempt is not an unresolved expected inspection")
    const plan = initial.intent.plan as Record<string, unknown>
    if (plan.action !== registration.action || plan.hostDigest !== registration.hostDigest || plan.bindingsDigest !== registration.bindingsDigest) throw new Error("registered owner does not match receipt pins")
    const directory = resolve(receiptDirectory)
    // This lock is intentionally never removed. A crash leaves a visible
    // manual-review boundary rather than allowing another callback to race it.
    await writeExclusive(directory, "reconciliation.lock", { schema: "usl-cli-reconciliation-lock/v1", inspectionDigest: initial.inspectionDigest, registration: registration.id })
    if (signal?.aborted) return freezeContract({ schema: "usl-cli-reconciliation-result/v1" as const, status: "UNKNOWN" as const, reason: "CANCELLED" as const, automaticRetry: false as const, inspectionDigest: initial.inspectionDigest })
    const context = freezeContract({ attempt: initial.attempt, intentDigest: initial.intent.intentDigest, planDigest: plan.planDigest,
      requestDigest: plan.requestDigest, action: plan.action, ownerId: registration.id, ...(initial.intent.operation === undefined ? {} : { operation: initial.intent.operation }) })
    const controller = new AbortController()
    let response: z.infer<typeof responseSchema>
    const timedOut = Symbol("owner query timed out"), cancelled = Symbol("owner query cancelled")
    let settle: ((value: typeof timedOut | typeof cancelled) => void) | undefined
    const guard = new Promise<typeof timedOut | typeof cancelled>(resolveGuard => { settle = resolveGuard })
    const timer = setTimeout(() => { controller.abort(); settle?.(timedOut) }, registration.timeoutMs)
    const relay = () => { controller.abort(); settle?.(cancelled) }; signal?.addEventListener("abort", relay, { once: true })
    const queryPromise = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error("owner query cancelled")
      return query(context, controller.signal)
    })
    // A non-cooperative owner cannot keep the caller waiting beyond the
    // registered bound. Its eventual rejection is intentionally consumed.
    void queryPromise.catch(() => undefined)
    try {
      const answer = await Promise.race([queryPromise, guard])
      if (answer === timedOut || answer === cancelled) throw answer
      response = responseSchema.parse(contractSnapshot(answer, registration.maxEvidenceBytes))
    }
    catch (error) {
      const reason = error === timedOut ? "TIMEOUT" : error === cancelled ? "CANCELLED" : "QUERY_FAILED"
      return freezeContract({ schema: "usl-cli-reconciliation-result/v1" as const, status: "UNKNOWN" as const, reason, automaticRetry: false as const, inspectionDigest: initial.inspectionDigest })
    }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", relay) }
    if (Buffer.byteLength(JSON.stringify(response.evidence), "utf8") > registration.maxEvidenceBytes) throw new Error("reconciliation evidence exceeds registration budget")
    const after = await inspectInternal(directory, signal === undefined ? {} : { signal })
    if (after.inspectionDigest !== initial.inspectionDigest || !same(after.intent, initial.intent)) throw new Error("receipt changed during owner query")
    const registered = { id: registration.id, action: registration.action, hostDigest: registration.hostDigest, bindingsDigest: registration.bindingsDigest }
    const queryDigest = contractDigest({ registration: registered, context })
    const observationDigest = contractDigest({ outcome: response.outcome, evidence: response.evidence, observedAt: response.observedAt })
    const body = { schema: "usl-cli-reconciliation/v1" as const, origin: "REGISTERED_OWNER_CALLBACK" as const,
      attempt: initial.attempt, intentDigest: initial.intent.intentDigest as string, planDigest: plan.planDigest as string, requestDigest: plan.requestDigest as string,
      action: plan.action as string, hostDigest: plan.hostDigest as string, bindingsDigest: plan.bindingsDigest as string, inspectionDigest: initial.inspectionDigest, reconcilerId: registration.id,
      queriedAt: new Date().toISOString(), observedAt: response.observedAt, externalOutcome: response.outcome, evidence: response.evidence, queryDigest, observationDigest, automaticRetry: false as const }
    const receipt = freezeContract({ ...body, reconciliationDigest: contractDigest(body) })
    await writeExclusive(directory, "reconciliation.json", receipt)
    return freezeContract({ schema: "usl-cli-reconciliation-result/v1" as const, status: "RECORDED" as const, automaticRetry: false as const, receipt })
  }
  return freezeContract({ schema: "usl-cli-reconciler/v1" as const, id: registration.id, action: registration.action, reconcile })
}
