/** Owner-registered, single-attempt CLI dispatcher. A graph or serialized receipt grants no authority. */
import { lstat, realpath } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { z } from "zod"
import { capabilityInvocationSchema, type CapabilityInvocation } from "../capabilities.js"
import { contractDigest, contractHash, contractIri, contractSnapshot, freezeContract, uniqueContractIds } from "../contract-core.js"
import { executeCliAction, planCliAction, type CliReadyPlan } from "../cli-host.js"
import { checkNativeDelivery, type PreparedNativeDelivery } from "./native-delivery.js"
import { checkNativeEvaluations, createNativeAdmission, createNativeEffectReceipt, createNativeEvaluatorReceipt, mapNativeCliEffect, type NativeAdmission, type NativeEffectReceipt, type NativeProfileSnapshot } from "./native-profile.js"
import { compileNativeProfileGraph, prepareNativeProfileObservation, recheckNativeProfileObservation, type PreparedNativeProfileObservation } from "./native-profile-runtime.js"
import type { NativeProfileDispatchStore } from "./native-profile-store.js"

const absolutePath = z.string().min(1).max(4096).refine(isAbsolute)
const registrationSchema = z.strictObject({
  actionId: contractIri, targetId: contractIri, loaderId: contractIri,
  profilePolicy: z.strictObject({ id: contractIri, digest: contractHash }),
  cli: z.strictObject({ configFile: absolutePath, actionId: z.string().min(1).max(256), hostDigest: contractHash, descriptorDigest: contractHash, policyDigest: contractHash }),
  receiptRoot: absolutePath,
})
const inputSchema = z.strictObject({ invocationId: contractIri, admissionId: contractIri, attemptId: contractIri, request: capabilityInvocationSchema })
const evaluationSchema = z.strictObject({ status: z.enum(["PASS", "FAIL", "UNKNOWN"]), evidenceDigest: contractHash })
export interface NativeDispatchEvaluator {
  readonly id: string
  readonly digest: string
  readonly evaluate: (context: Readonly<{ snapshot: NativeProfileSnapshot; invocationId: string; inputDigest: string; request: CapabilityInvocation; signal: AbortSignal }>) => Promise<z.infer<typeof evaluationSchema>>
}
export interface NativeDispatchHost {
  readonly store: NativeProfileDispatchStore
  readonly registration: z.infer<typeof registrationSchema>
  /** Owner callback must return the current host mapping, including after an environment switch. */
  readonly readContext: () => Promise<{ readonly graph: string; readonly environment: unknown }>
  readonly evaluators: readonly NativeDispatchEvaluator[]
  readonly clock?: () => Date
  readonly ttlMs?: number
  readonly evaluatorTimeoutMs?: number
  readonly maxResources?: number
}
export interface PreparedNativeDispatch {
  readonly schema: "usl-prepared-native-dispatch/v1"
  readonly report: {
    readonly status: "READY" | "HOLD"; readonly reasons: readonly string[]
    readonly admission: NativeAdmission | null; readonly cliPlanDigest: string | null
    readonly bindingDigest: string | null; readonly automaticRetry: false; readonly digest: string
  }
}
type CliReceipt = Awaited<ReturnType<typeof executeCliAction>>
export interface NativeDispatchResult {
  readonly report: {
    readonly schema: "usl-native-dispatch-result/v1"; readonly status: "SUCCEEDED" | "HOLD" | "UNKNOWN"
    readonly reasons: readonly string[]; readonly effectDigest: string | null
    readonly cliReceiptDigest: string | null; readonly automaticRetry: false; readonly digest: string
  }
  readonly effect: NativeEffectReceipt | null
  readonly cliReceipt?: CliReceipt
}
type Host = ReturnType<typeof captureHost>
type Input = z.infer<typeof inputSchema>
type Binding = Readonly<Record<string, string>>
type Saved = {
  readonly host: Host; readonly input: Input; readonly snapshot: NativeProfileSnapshot
  readonly delivery: PreparedNativeDelivery; readonly observation: PreparedNativeProfileObservation
  readonly plan: CliReadyPlan; readonly admission: NativeAdmission; readonly binding: Binding
  used: boolean
}
const prepared = new WeakMap<object, Saved>()
const seal = <T extends object>(body: T) => freezeContract({ ...body, digest: contractDigest(body) })
class DispatchHold extends Error { constructor(readonly code: string) { super(code) } }
const requirePass: (condition: unknown, reason: string) => asserts condition = (condition, reason) => { if (!condition) throw new DispatchHold(reason) }
const reasonOf = (error: unknown) => error instanceof DispatchHold ? error.code : "HOST_CHECK_UNAVAILABLE"
const bounded = (value: number | undefined, fallback: number, max: number) => z.number().int().min(1).max(max).parse(value ?? fallback)
const captureHost = (host: NativeDispatchHost) => {
  const registration = freezeContract(registrationSchema.parse(contractSnapshot(host.registration)))
  requirePass(typeof host.readContext === "function", "OWNER_CONTEXT_CALLBACK_REQUIRED")
  const store = { read: host.store.read.bind(host.store), issue: host.store.issue.bind(host.store), beginEffect: host.store.beginEffect.bind(host.store), finalizeEffect: host.store.finalizeEffect.bind(host.store) }
  requirePass(Array.isArray(host.evaluators) && host.evaluators.length <= 256, "EVALUATOR_REGISTRY_BOUNDS")
  const evaluators = host.evaluators.map(entry => {
    requirePass(typeof entry.evaluate === "function", "OWNER_EVALUATOR_CALLBACK_REQUIRED")
    return Object.freeze({ id: contractIri.parse(entry.id), digest: contractHash.parse(entry.digest), evaluate: entry.evaluate.bind(entry) })
  })
  uniqueContractIds(evaluators.map(entry => entry.id), "registered evaluator")
  if (host.clock !== undefined) requirePass(typeof host.clock === "function", "OWNER_CLOCK_REQUIRED")
  return Object.freeze({ registration, store, evaluators, readContext: host.readContext.bind(host), clock: host.clock?.bind(host) ?? (() => new Date()),
    ttlMs: bounded(host.ttlMs, 60_000, 15 * 60_000), evaluatorTimeoutMs: bounded(host.evaluatorTimeoutMs, 5000, 60_000), maxResources: bounded(host.maxResources, 16, 128) })
}
/** Timeout bounds the wait. Owner callbacks must cooperate with abort; no callback is retried. */
const withDeadline = async <T>(ms: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new DispatchHold("OWNER_CALLBACK_TIMEOUT")) }, ms)
  })]) } finally { if (timer !== undefined) clearTimeout(timer); controller.abort() }
}
const evaluate = async (host: Host, snapshot: NativeProfileSnapshot, input: Input) => withDeadline(host.evaluatorTimeoutMs, async signal => {
  const inputDigest = contractDigest(input.request)
  const receipts = []
  for (const required of snapshot.manifest.requiredEvaluators) {
    requirePass(!signal.aborted, "OWNER_CALLBACK_TIMEOUT")
    const entry = host.evaluators.find(item => item.id === required.id && item.digest === required.digest)
    requirePass(entry, "REQUIRED_EVALUATOR_NOT_REGISTERED")
    const value = evaluationSchema.parse(contractSnapshot(await entry.evaluate(Object.freeze({ snapshot, invocationId: input.invocationId, inputDigest, request: input.request, signal }))))
    receipts.push(createNativeEvaluatorReceipt({ schema: "usl-native-evaluator-receipt/v1", evaluator: required, snapshotDigest: snapshot.digest, invocationId: input.invocationId, inputDigest, ...value }))
  }
  const result = checkNativeEvaluations(snapshot, input.invocationId, inputDigest, receipts)
  requirePass(result.status === "PASS", "REQUIRED_EVALUATOR_NOT_PASS")
  return result
})
const checkDelivery = (host: Host, snapshot: NativeProfileSnapshot, input: Input, delivery: PreparedNativeDelivery) => {
  const result = checkNativeDelivery(delivery, snapshot, input.invocationId, host.registration.targetId)
  requirePass(result.status === "PASS", "LIVE_REQUIRED_DELIVERY_MISSING")
  requirePass(delivery.report.loaderId === host.registration.loaderId, "DELIVERY_LOADER_MISMATCH")
  return result.deliveryDigest!
}
const checkPlan = (host: Host, snapshot: NativeProfileSnapshot, input: Input, plan: CliReadyPlan, observation: PreparedNativeProfileObservation) => {
  const registration = host.registration, capability = snapshot.manifest.capabilities.find(item => item.id === registration.actionId)
  requirePass(capability && capability.descriptorDigest === registration.cli.descriptorDigest && capability.scopeDigest === registration.cli.policyDigest, "PROFILE_CAPABILITY_MISMATCH")
  requirePass(contractDigest(snapshot.manifest.policy) === contractDigest(registration.profilePolicy), "PROFILE_POLICY_MISMATCH")
  requirePass(plan.hostDigest === registration.cli.hostDigest && plan.preflight.descriptorDigest === registration.cli.descriptorDigest && plan.policyDigest === registration.cli.policyDigest && plan.requestDigest === contractDigest(input.request), "CLI_REGISTRATION_MISMATCH")
  requirePass(plan.operation !== undefined, "DURABLE_OPERATION_STORE_REQUIRED")
  const selections = observation.compilation?.bindingReceipt.selections
  requirePass(selections && selections.some(item => item.kind === "workspace" && item.path === plan.command.cwd && item.resource === plan.command.cwdSelection.resource && item.representation === plan.command.cwdSelection.representation), "CLI_CWD_OUTSIDE_PROFILE")
  for (const source of plan.sources) {
    const selected = selections.find(item => item.resource === source.resource && item.representation === source.representation && item.kind === "workspace" && item.path === source.path)
    requirePass(selected, "CLI_SOURCE_OUTSIDE_PROFILE")
    const pin = selected.expectedDigest ?? snapshot.manifest.requiredSources.find(item => item.resource === source.resource && item.representation === source.representation)?.digest
    requirePass(pin === source.digest, "NATIVE_CLI_SOURCE_PIN_REQUIRED")
  }
}
const context = (host: Host) => withDeadline(host.evaluatorTimeoutMs, async () => {
  const value = await host.readContext()
  return contractSnapshot(value, 2 * 1024 * 1024)
})
const receiptRoot = async (host: Host) => {
  const root = host.registration.receiptRoot, info = await lstat(root)
  requirePass(info.isDirectory() && !info.isSymbolicLink() && await realpath(root) === root, "RECEIPT_ROOT_NOT_REAL")
}
const checkCurrent = async (saved: Saved, signal?: AbortSignal, checkEvaluators = true) => {
  requirePass(!signal?.aborted, "ABORTED")
  if (checkEvaluators) requirePass((await evaluate(saved.host, saved.snapshot, saved.input)).digest === saved.admission.evaluatorDigest, "EVALUATOR_EVIDENCE_CHANGED")
  const current = await context(saved.host)
  const compilation = await compileNativeProfileGraph(current.graph, saved.snapshot, current.environment)
  requirePass(compilation.digest === saved.observation.compilation?.digest, "CURRENT_HOST_MAPPING_CHANGED")
  requirePass((await recheckNativeProfileObservation(saved.observation)).status === "PASS", "NATIVE_OBSERVATION_CHANGED")
  requirePass(checkDelivery(saved.host, saved.snapshot, saved.input, saved.delivery) === saved.admission.deliveryDigest, "DELIVERY_CHANGED")
  const time = saved.host.clock().getTime()
  requirePass(Number.isFinite(time) && time >= Date.parse(saved.admission.issuedAt) && time < Date.parse(saved.admission.expiresAt), "ADMISSION_EXPIRED_OR_CLOCK_REGRESSED")
  requirePass(!signal?.aborted, "ABORTED")
}
const prepareReport = (status: "READY" | "HOLD", reasons: string[], admission: NativeAdmission | null = null, plan: string | null = null, binding: string | null = null): PreparedNativeDispatch => freezeContract({
  schema: "usl-prepared-native-dispatch/v1", report: seal({ status, reasons, admission, cliPlanDigest: plan, bindingDigest: binding, automaticRetry: false as const }),
})

/** No caller-supplied receipt array is accepted: delivery handles and evaluator callbacks are owner-registered. */
export const prepareNativeDispatch = async (hostInput: NativeDispatchHost, inputValue: unknown, delivery: PreparedNativeDelivery): Promise<PreparedNativeDispatch> => {
  try {
    const host = captureHost(hostInput), input = freezeContract(inputSchema.parse(contractSnapshot(inputValue)))
    const state = await host.store.read(), snapshot = state.active
    requirePass(snapshot && !state.executionGate, "ACTIVE_PROFILE_UNAVAILABLE")
    requirePass(!state.admissions.some(entry => entry.admission.invocationId === input.invocationId), "INVOCATION_ID_REUSED")
    await receiptRoot(host)
    const current = await context(host), observation = await prepareNativeProfileObservation(current.graph, snapshot, current.environment, host.maxResources)
    requirePass(observation.report.status === "PASS", "PROFILE_OBSERVATION_HELD")
    const plan = await planCliAction(host.registration.cli.configFile, host.registration.cli.actionId, input.request)
    requirePass(plan.status === "READY", "CLI_PREFLIGHT_HELD")
    checkPlan(host, snapshot, input, plan, observation)
    const deliveryDigest = checkDelivery(host, snapshot, input, delivery), evaluations = await evaluate(host, snapshot, input)
    const issuedAt = host.clock(), admission = createNativeAdmission({ id: input.admissionId, invocationId: input.invocationId,
      actionId: host.registration.actionId, scopeDigest: host.registration.cli.policyDigest, inputDigest: contractDigest(input.request),
      observationDigest: observation.report.digest, deliveryDigest, evaluatorDigest: evaluations.digest,
      issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + host.ttlMs).toISOString() }, snapshot)
    const binding = freezeContract({ snapshotDigest: snapshot.digest, admissionDigest: admission.digest, invocationId: input.invocationId,
      attemptId: input.attemptId, actionId: host.registration.actionId, targetId: host.registration.targetId, loaderId: host.registration.loaderId,
      profilePolicyDigest: contractDigest(host.registration.profilePolicy), cliPlanDigest: plan.planDigest })
    const saved: Saved = { host, input, snapshot, delivery, observation, plan, admission, binding, used: false }
    await checkCurrent(saved, undefined, false)
    requirePass((await host.store.read()).digest === state.digest, "PROFILE_STATE_CHANGED_DURING_PREPARE")
    const handle = prepareReport("READY", [], admission, plan.planDigest, contractDigest(binding))
    prepared.set(handle, saved)
    return handle
  } catch (error) { return prepareReport("HOLD", [reasonOf(error)]) }
}
const result = (status: NativeDispatchResult["report"]["status"], reasons: string[], effect: NativeEffectReceipt | null = null, cliReceipt?: CliReceipt): NativeDispatchResult => freezeContract({
  report: seal({ schema: "usl-native-dispatch-result/v1" as const, status, reasons, effectDigest: effect?.digest ?? null, cliReceiptDigest: cliReceipt?.receiptDigest ?? null, automaticRetry: false as const }),
  effect, ...(cliReceipt === undefined ? {} : { cliReceipt }),
})

/** Ordered durable intent -> operation reservation -> native gate -> one spawn; UNKNOWN never retries. */
export const executeNativeDispatch = async (handle: PreparedNativeDispatch, options: { readonly signal?: AbortSignal } = {}): Promise<NativeDispatchResult> => {
  const saved = handle !== null && typeof handle === "object" ? prepared.get(handle) : undefined
  if (!saved || saved.used) return result("HOLD", ["LIVE_UNUSED_DISPATCH_HANDLE_REQUIRED"])
  saved.used = true
  const signal = options.signal, { host, input, snapshot, admission } = saved
  let began = false, beginUnknown = false, cliReceipt: CliReceipt | undefined
  try {
    await checkCurrent(saved, signal, false)
    await receiptRoot(host)
    const state = await host.store.read()
    requirePass(state.active?.digest === snapshot.digest && !state.executionGate, "ACTIVE_PROFILE_CHANGED")
    const issued = await host.store.issue(state.digest, admission)
    if (issued.status !== "COMMITTED") return result(issued.status === "COMMIT_UNKNOWN" ? "UNKNOWN" : "HOLD", ["ADMISSION_ISSUE_" + issued.status])
    const operationKey = contractDigest({ ownerNamespace: snapshot.manifest.ownerNamespace, invocationId: input.invocationId })
    const directory = join(host.registration.receiptRoot, contractDigest({ invocationId: input.invocationId, attemptId: input.attemptId }).slice(7))
    cliReceipt = await executeCliAction(host.registration.cli.configFile, host.registration.cli.actionId, input.request, saved.plan.planDigest, directory, {
      ...(signal === undefined ? {} : { signal }), operationKey,
      authorization: {
        binding: saved.binding,
        beforeStart: async value => {
          try {
            requirePass(value.plan.planDigest === saved.plan.planDigest, "CLI_PLAN_CHANGED")
            checkPlan(host, snapshot, input, value.plan, saved.observation)
            await checkCurrent(saved, signal)
            const state = await host.store.read()
            requirePass(state.active?.digest === snapshot.digest, "ACTIVE_PROFILE_CHANGED")
            const started = await host.store.beginEffect(state.digest, admission, input.attemptId, value.intentDigest)
            beginUnknown = started.status === "COMMIT_UNKNOWN"
            requirePass(started.status === "COMMITTED", "EXECUTION_GATE_" + started.status)
            began = true
            checkDelivery(host, snapshot, input, saved.delivery)
            return seal({ status: "PASS" as const, reasons: [] as string[], admissionDigest: admission.digest, intentDigest: value.intentDigest })
          } catch (error) { return seal({ status: "HOLD" as const, reasons: [reasonOf(error)] }) }
        },
        verify: () => {
          try {
            const time = host.clock().getTime()
            return began && !signal?.aborted && Number.isFinite(time) && time >= Date.parse(admission.issuedAt) && time < Date.parse(admission.expiresAt)
              && checkDelivery(host, snapshot, input, saved.delivery) === admission.deliveryDigest
          } catch { return false }
        },
      },
    })
  } catch (error) {
    if (!began && !beginUnknown) return result("HOLD", [reasonOf(error)])
  }
  if (beginUnknown) return result("UNKNOWN", ["EXECUTION_GATE_COMMIT_UNKNOWN"], null, cliReceipt)
  if (!began) return result("HOLD", [cliReceipt?.reason ?? "NOT_DISPATCHED"], null, cliReceipt)
  let effect = cliReceipt === undefined
    ? createNativeEffectReceipt({ schema: "usl-native-effect-receipt/v1", attemptId: input.attemptId, admissionDigest: admission.digest,
      dispatch: "UNKNOWN", outcome: "UNKNOWN", sourceStatus: "OWNER_REPORTED", sourceReceiptDigest: contractDigest({ failure: "CLI_RESULT_UNAVAILABLE" }), reason: "CLI_RESULT_UNAVAILABLE", automaticRetry: false })
    : mapNativeCliEffect({ attemptId: input.attemptId, admissionDigest: admission.digest, sourceStatus: cliReceipt.status, sourceReceiptDigest: cliReceipt.receiptDigest, reason: cliReceipt.reason })
  if (effect.outcome === "SUCCEEDED") {
    try { await checkCurrent(saved, undefined, false) }
    catch { const { digest: _digest, ...body } = effect; effect = createNativeEffectReceipt({ ...body, sourceStatus: "OWNER_REPORTED", outcome: "UNKNOWN", reason: "POST_EXECUTION_CONTEXT_CHANGED" }) }
  }
  try {
    const state = await host.store.read()
    requirePass(state.active?.digest === snapshot.digest, "POST_EXECUTION_PROFILE_CHANGED")
    const finalized = await host.store.finalizeEffect(state.digest, input.attemptId, effect)
    if (finalized.status !== "COMMITTED") return result("UNKNOWN", ["EFFECT_FINALIZE_" + finalized.status], effect, cliReceipt)
  } catch { return result("UNKNOWN", ["EFFECT_FINALIZE_UNAVAILABLE"], effect, cliReceipt) }
  return result(effect.outcome === "SUCCEEDED" ? "SUCCEEDED" : effect.outcome === "UNKNOWN" ? "UNKNOWN" : "HOLD", effect.reason === null ? [] : [effect.reason], effect, cliReceipt)
}
