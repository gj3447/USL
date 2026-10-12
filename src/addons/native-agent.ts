/** One owner-controlled, stateless-per-turn agent harness. Model proposals never grant tool access. */
import { z } from "zod"
import { contractDigest, contractHash, contractIri, contractSnapshot, freezeContract, uniqueContractIds } from "../contract-core.js"
import { parseCapability, type CapabilityDescriptor } from "../capabilities.js"
import { deliverNativeRequiredSources, revokeNativeDelivery, type NativeDeliveryHost, type PreparedNativeDelivery } from "./native-delivery.js"
import { executeNativeDispatch, prepareNativeDispatch, type NativeDispatchHost, type NativeDispatchResult } from "./native-dispatch.js"
import { compileNativeProfileGraph } from "./native-profile-runtime.js"
import type { NativeProfileSnapshot } from "./native-profile.js"
type JSONType = z.infer<ReturnType<typeof z.json>>

export interface NativeAgentCompletionRequest {
  readonly messages: readonly { readonly role: "system" | "user"; readonly content: string }[]
  readonly tool: { readonly name: "usl_action"; readonly description: string; readonly parameters: JSONType }
  readonly signal: AbortSignal
}
export type NativeAgentCompletion =
  | { readonly kind: "final"; readonly content: string }
  | { readonly kind: "tool"; readonly name: string; readonly arguments: JSONType }
export interface NativeAgentModel {
  readonly id: string
  readonly registrationDigest?: string
  readonly complete: (request: NativeAgentCompletionRequest) => Promise<NativeAgentCompletion>
}

export interface NativeAgentHost {
  readonly harnessId: string
  readonly dispatch: NativeDispatchHost
  readonly tool: CapabilityDescriptor
  readonly model: NativeAgentModel
  readonly read: NativeDeliveryHost["read"]
  /** Exact application/read order, equal to the pinned manifest's requiredSources order. */
  readonly instructionOrder: readonly string[]
  readonly maxContextBytes?: number
  readonly modelTimeoutMs?: number
  readonly deliveryTimeoutMs?: number
}
export interface NativeAgentSession {
  readonly schema: "usl-native-agent-session/v1"
  readonly sessionId: string
  readonly parentSessionId: string | null
  readonly harnessId: string
  readonly targetId: string
  readonly modelId: string
  readonly digest: string
}
type Invalidation = "COMPACTION" | "HANDOFF" | "TARGET_LOST" | "CLOSED"
interface Instruction { readonly ordinal: number; readonly sourceId: string; readonly revision: string; readonly digest: string; readonly bytes: number }
interface Trace {
  readonly snapshotDigest: string | null; readonly hostBindingDigest: string | null; readonly graphDigest: string | null
  readonly instructionChainDigest: string | null; readonly instructions: readonly Instruction[]
  readonly deliveryDigest: string | null; readonly modelRequestDigest: string | null; readonly modelResponseDigest: string | null
  readonly admissionDigest: string | null
  readonly modelRegistrationDigest: string | null
}
export interface NativeAgentTurnResult {
  readonly report: Trace & {
    readonly schema: "usl-native-agent-turn/v1"; readonly status: "COMPLETED" | "HOLD" | "UNKNOWN"
    readonly sessionId: string | null; readonly parentSessionId: string | null; readonly harnessId: string | null
    readonly targetId: string | null; readonly modelId: string | null; readonly contextEpoch: number | null
    readonly invocationId: string | null; readonly reasons: readonly string[]; readonly effectDigest: string | null
    readonly cliReceiptDigest: string | null; readonly scope: "OWNER_HARNESS_ONLY"; readonly bypassPaths: readonly string[]
    readonly deliveryMeaning: "HARNESS_CONTEXT_ACK_NOT_MODEL_COMPREHENSION"; readonly automaticRetry: false; readonly digest: string
  }
  readonly answer: string | null
  readonly dispatch: NativeDispatchResult | null
}
const turnSchema = z.strictObject({ invocationId: contractIri, admissionId: contractIri, attemptId: contractIri, prompt: z.string().min(1).max(65536) })
const completionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("final"), content: z.string().max(1024 * 1024) }),
  z.strictObject({ kind: z.literal("tool"), name: z.string().min(1).max(256), arguments: z.json() }),
])
const invalidationSchema = z.enum(["COMPACTION", "HANDOFF", "TARGET_LOST", "CLOSED"])
const seal = <T extends object>(body: T) => freezeContract({ ...body, digest: contractDigest(body) })
const limit = (value: number | undefined, fallback: number, max: number) => z.number().int().min(1).max(max).parse(value ?? fallback)
class AgentHeld extends Error { constructor(readonly code: string, readonly unknown = false) { super(code) } }
const check: (condition: unknown, code: string) => asserts condition = (condition, code) => { if (!condition) throw new AgentHeld(code) }

/** Capture registrations, not caller-owned mutable containers. No network or tool invocation here. */
const captureHost = (host: NativeAgentHost) => {
  const harnessId = contractIri.parse(host.harnessId), modelId = contractIri.parse(host.model.id), tool = parseCapability(host.tool)
  check(typeof host.model.complete === "function" && typeof host.read === "function", "OWNER_CALLBACK_REQUIRED")
  const d = host.dispatch, registration = freezeContract(contractSnapshot(d.registration))
  contractIri.parse(registration.targetId); contractIri.parse(registration.loaderId)
  check(contractDigest(tool) === registration.cli.descriptorDigest, "TOOL_DESCRIPTOR_MISMATCH")
  check(tool.input.schema !== false, "TOOL_SCHEMA_HAS_NO_VALID_INPUT")
  const instructionOrder = freezeContract(z.array(contractIri).max(256).parse(contractSnapshot(host.instructionOrder)))
  uniqueContractIds(instructionOrder, "instruction source")
  const dispatch: NativeDispatchHost = Object.freeze({ ...d, registration,
    store: Object.freeze({ read: d.store.read.bind(d.store), activate: d.store.activate.bind(d.store), issue: d.store.issue.bind(d.store), consume: d.store.consume.bind(d.store), withdraw: d.store.withdraw.bind(d.store), beginEffect: d.store.beginEffect.bind(d.store), finalizeEffect: d.store.finalizeEffect.bind(d.store), reconcileEffect: d.store.reconcileEffect.bind(d.store) }),
    readContext: d.readContext.bind(d), evaluators: Object.freeze(d.evaluators.map(e => Object.freeze({ id: e.id, digest: e.digest, evaluate: e.evaluate.bind(e) }))),
    ...(d.clock === undefined ? {} : { clock: d.clock.bind(d) }),
  })
  return Object.freeze({ harnessId, modelId, modelRegistrationDigest: host.model.registrationDigest === undefined ? null : contractHash.parse(host.model.registrationDigest), tool, dispatch, instructionOrder, complete: host.model.complete.bind(host.model), read: host.read.bind(host),
    maxContextBytes: limit(host.maxContextBytes, 1024 * 1024, 4 * 1024 * 1024), modelTimeoutMs: limit(host.modelTimeoutMs, 30_000, 60_000), deliveryTimeoutMs: limit(host.deliveryTimeoutMs, 15_000, 60_000) })
}
type Host = ReturnType<typeof captureHost>
type Turn = z.infer<typeof turnSchema>
interface State {
  readonly session: NativeAgentSession; readonly host: Host; readonly usedInvocations: Set<string>
  epoch: number; closed: boolean; busy: boolean; reason: Invalidation | null
  active: { readonly controller: AbortController; delivery?: PreparedNativeDelivery } | null
}
const sessions = new WeakMap<object, State>()
const stateOf = (session: NativeAgentSession): State => {
  const state = session !== null && typeof session === "object" ? sessions.get(session) : undefined
  check(state, "LIVE_AGENT_SESSION_REQUIRED"); return state
}
const createSession = (hostInput: NativeAgentHost, input: { readonly sessionId: string }, parentSessionId: string | null): NativeAgentSession => {
  const host = captureHost(hostInput), sessionId = contractIri.parse(input.sessionId)
  const session = seal({ schema: "usl-native-agent-session/v1" as const, sessionId, parentSessionId, harnessId: host.harnessId, targetId: host.dispatch.registration.targetId, modelId: host.modelId })
  sessions.set(session, { session, host, usedInvocations: new Set(), epoch: 1, closed: false, busy: false, reason: null, active: null })
  return session
}
export const createNativeAgentSession = (host: NativeAgentHost, input: { readonly sessionId: string }): NativeAgentSession => createSession(host, input, null)

/** The owner harness must call this when external context continuity is lost. */
export const invalidateNativeAgentSession = (session: NativeAgentSession, reason: Invalidation) => {
  const state = stateOf(session), captured = invalidationSchema.parse(reason)
  check(state.epoch < Number.MAX_SAFE_INTEGER, "CONTEXT_EPOCH_EXHAUSTED")
  state.epoch++; state.reason = captured
  state.closed = state.closed || captured !== "COMPACTION"
  if (state.active?.delivery) revokeNativeDelivery(state.active.delivery)
  state.active?.controller.abort()
  return seal({ schema: "usl-native-agent-invalidation/v1", sessionId: session.sessionId, contextEpoch: state.epoch, reason: captured, closed: state.closed, authority: "NOT_GRANTED" })
}
/** A sub-agent gets a fresh target and delivery; no admission or context handle is inherited. */
export const handoffNativeAgentSession = (parent: NativeAgentSession, childHost: NativeAgentHost, input: { readonly sessionId: string }): NativeAgentSession => {
  const state = stateOf(parent)
  check(!state.closed, "AGENT_SESSION_CLOSED")
  check(childHost.dispatch.registration.targetId !== parent.targetId && input.sessionId !== parent.sessionId, "HANDOFF_REQUIRES_NEW_TARGET_AND_SESSION")
  const child = createSession(childHost, input, parent.sessionId)
  invalidateNativeAgentSession(parent, "HANDOFF")
  return child
}
export const inspectNativeAgentSession = (session: NativeAgentSession) => {
  const state = stateOf(session)
  return seal({ schema: "usl-native-agent-state/v1", sessionId: session.sessionId, contextEpoch: state.epoch, closed: state.closed, busy: state.busy, invalidation: state.reason, usedInvocations: state.usedInvocations.size })
}

const emptyTrace = (): Trace => ({ snapshotDigest: null, hostBindingDigest: null, graphDigest: null, instructionChainDigest: null, instructions: [], deliveryDigest: null, modelRequestDigest: null, modelResponseDigest: null, admissionDigest: null, modelRegistrationDigest: null })
const result = (state: State | undefined, turn: Turn | null, epoch: number | null, trace: Trace, status: NativeAgentTurnResult["report"]["status"], reasons: readonly string[], answer: string | null = null, dispatch: NativeDispatchResult | null = null): NativeAgentTurnResult => freezeContract({
  report: seal({ schema: "usl-native-agent-turn/v1" as const, status, sessionId: state?.session.sessionId ?? null, parentSessionId: state?.session.parentSessionId ?? null,
    harnessId: state?.host.harnessId ?? null, targetId: state?.session.targetId ?? null, modelId: state?.host.modelId ?? null, contextEpoch: epoch,
    invocationId: turn?.invocationId ?? null, ...trace, reasons, effectDigest: dispatch?.effect?.digest ?? null, cliReceiptDigest: dispatch?.cliReceipt?.receiptDigest ?? null,
    scope: "OWNER_HARNESS_ONLY" as const, bypassPaths: ["DIRECT_SHELL", "EXTERNAL_TOOLS", "UNINSTRUMENTED_SUBAGENTS"], deliveryMeaning: "HARNESS_CONTEXT_ACK_NOT_MODEL_COMPREHENSION" as const, automaticRetry: false as const }), answer, dispatch,
})
const bounded = async <T>(signal: AbortSignal, ms: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  check(!signal.aborted, "CONTEXT_REVOKED_OR_ABORTED")
  const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal])
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined
  try {
    return await Promise.race([Promise.resolve().then(() => { check(!combined.aborted, "CONTEXT_REVOKED_OR_ABORTED"); return operation(combined) }), new Promise<never>((_, reject) => {
      abort = () => reject(new AgentHeld("CONTEXT_REVOKED_OR_ABORTED")); signal.addEventListener("abort", abort, { once: true })
      timer = setTimeout(() => { reject(new AgentHeld("AGENT_CALLBACK_TIMEOUT", true)); controller.abort() }, ms)
    })])
  } finally { if (timer !== undefined) clearTimeout(timer); if (abort) signal.removeEventListener("abort", abort); controller.abort() }
}

/** Exactly one inference request and at most one registered P09 tool call. No automatic agent loop. */
export const runNativeAgentTurn = async (session: NativeAgentSession, input: unknown, options: { readonly signal?: AbortSignal } = {}): Promise<NativeAgentTurnResult> => {
  let state: State | undefined, turn: Turn | null = null, epoch: number | null = null, trace = emptyTrace()
  let owned = false, modelStarted = false, dispatch: NativeDispatchResult | null = null
  try {
    state = stateOf(session); turn = freezeContract(turnSchema.parse(contractSnapshot(input))); epoch = state.epoch
    check(!state.closed, "AGENT_SESSION_CLOSED"); check(!state.busy, "AGENT_TURN_BUSY")
    check(!state.usedInvocations.has(turn.invocationId), "AGENT_INVOCATION_REUSED")
    check(state.usedInvocations.size < 1024, "AGENT_SESSION_CAPACITY")
    const host = state.host, currentState = state, currentTurn = turn, currentEpoch = epoch
    trace = { ...trace, modelRegistrationDigest: host.modelRegistrationDigest }
    const controller = new AbortController(), signal = options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal])
    state.usedInvocations.add(turn.invocationId); state.busy = true; owned = true; state.active = { controller }
    const live = () => check(!signal.aborted && !currentState.closed && currentState.epoch === currentEpoch, "CONTEXT_REVOKED_OR_ABORTED")
    live()
    const registry = await host.dispatch.store.read(), snapshot: NativeProfileSnapshot | null = registry.active
    live(); check(snapshot && !registry.executionGate, "ACTIVE_PROFILE_UNAVAILABLE")
    trace = { ...trace, snapshotDigest: snapshot.digest, hostBindingDigest: snapshot.hostBindingDigest, graphDigest: snapshot.manifest.graphDigest }
    check(contractDigest(snapshot.manifest.requiredSources.map(source => source.id)) === contractDigest(host.instructionOrder), "INSTRUCTION_ORDER_OR_COVERAGE_MISMATCH")
    const context = await bounded(signal, host.modelTimeoutMs, () => host.dispatch.readContext())
    await compileNativeProfileGraph(context.graph, snapshot, context.environment); live()
    check(snapshot.manifest.requiredSources.reduce((sum, source) => sum + source.bytes, Buffer.byteLength(turn.prompt)) <= host.maxContextBytes, "AGENT_CONTEXT_BYTE_BUDGET")
    const messages: { role: "system" | "user"; content: string }[] = [{ role: "system", content: "Use only the offered usl_action tool. A tool call is a proposal; the owner host validates it before execution." }]
    const instructions: Instruction[] = []
    const delivered = await bounded(signal, host.deliveryTimeoutMs, () => deliverNativeRequiredSources(snapshot, currentTurn.invocationId, {
      loaderId: host.dispatch.registration.loaderId, targetId: host.dispatch.registration.targetId, maxBytes: host.maxContextBytes, timeoutMs: host.deliveryTimeoutMs,
      read: request => { live(); return host.read(Object.freeze({ ...request, signal: AbortSignal.any([signal, request.signal]) })) },
      deliver: async request => {
        live(); check(request.source.id === host.instructionOrder[instructions.length], "INSTRUCTION_ORDER_CHANGED")
        const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(request.bytes)
        check(Buffer.from(content, "utf8").equals(Buffer.from(request.bytes)), "INSTRUCTION_ENCODING_LOSS")
        messages.push({ role: "system", content }); instructions.push({ ordinal: instructions.length, sourceId: request.source.id, revision: request.source.revision, digest: request.source.digest, bytes: request.bytes.byteLength })
        return { snapshotDigest: snapshot.digest, invocationId: currentTurn.invocationId, sourceId: request.source.id, loaderId: request.loaderId, targetId: request.targetId, deliveredDigest: request.source.digest, deliveredBytes: request.bytes.byteLength }
      },
    }))
    check(currentState.active, "ACTIVE_AGENT_TURN_REQUIRED")
    currentState.active.delivery = delivered
    live(); check(delivered.report.status === "PASS", "REQUIRED_INSTRUCTION_DELIVERY_HELD")
    trace = { ...trace, instructions, deliveryDigest: delivered.report.digest, instructionChainDigest: contractDigest({ sessionId: session.sessionId, contextEpoch: epoch, snapshotDigest: snapshot.digest, instructions }) }
    messages.push({ role: "user", content: currentTurn.prompt })
    // Function-call arguments are JSON objects. Narrow an unconstrained input for the
    // offered tool; P09 still validates against the original pinned capability.
    const parameters = host.tool.input.schema === true ? { type: "object" } : host.tool.input.schema
    const request = freezeContract({ messages, tool: { name: "usl_action" as const, description: `Owner-registered action ${host.dispatch.registration.actionId}`, parameters } })
    check(Buffer.byteLength(JSON.stringify(request)) <= host.maxContextBytes, "AGENT_CONTEXT_BYTE_BUDGET")
    trace = { ...trace, modelRequestDigest: contractDigest(request) }
    check((await host.dispatch.store.read()).active?.digest === snapshot.digest, "PROFILE_CHANGED_BEFORE_MODEL")
    live(); modelStarted = true
    const completion = await bounded(signal, host.modelTimeoutMs, callbackSignal => host.complete(Object.freeze({ ...request, signal: callbackSignal })))
    live()
    const decoded = completionSchema.safeParse(contractSnapshot(completion))
    check(decoded.success, "MODEL_RESPONSE_INVALID")
    const proposal = freezeContract(decoded.data)
    trace = { ...trace, modelResponseDigest: contractDigest(proposal) }
    check((await host.dispatch.store.read()).active?.digest === snapshot.digest, "PROFILE_CHANGED_AFTER_MODEL")
    live()
    if (proposal.kind === "final") return result(state, turn, epoch, trace, "COMPLETED", [], proposal.content)
    check(proposal.name === "usl_action", "UNREGISTERED_AGENT_TOOL")
    const prepared = await prepareNativeDispatch(host.dispatch, { invocationId: turn.invocationId, admissionId: turn.admissionId, attemptId: turn.attemptId,
      request: { descriptorDigest: contractDigest(host.tool), sourceDigest: host.tool.sourceDigest,
        input: { types: host.tool.input.types, value: proposal.arguments, ...(host.tool.input.unit === undefined ? {} : { unit: host.tool.input.unit }) } } }, delivered)
    live(); check(prepared.report.status === "READY", "DISPATCH_PREPARATION_HELD")
    trace = { ...trace, admissionDigest: prepared.report.admission?.digest ?? null }
    dispatch = await executeNativeDispatch(prepared, { signal })
    if (dispatch.report.status !== "SUCCEEDED") return result(state, turn, epoch, trace, dispatch.report.status, dispatch.report.reasons, null, dispatch)
    // A context loss concurrent with the final durable write must not become a fresh valid turn.
    if (signal.aborted || currentState.epoch !== currentEpoch) return result(state, turn, epoch, trace, "UNKNOWN", ["CONTEXT_LOST_AT_COMPLETION"], null, dispatch)
    return result(state, turn, epoch, trace, "COMPLETED", [], null, dispatch)
  } catch (error) {
    const reason = error instanceof AgentHeld ? error.code : modelStarted ? "AGENT_MODEL_OR_HOST_UNAVAILABLE" : "AGENT_INPUT_OR_HOST_UNAVAILABLE"
    const unknown = error instanceof AgentHeld ? error.unknown : modelStarted
    return result(state, turn, epoch, trace, unknown ? "UNKNOWN" : "HOLD", [reason], null, dispatch)
  } finally {
    if (owned && state) { if (state.active?.delivery) revokeNativeDelivery(state.active.delivery); state.active?.controller.abort(); state.active = null; state.busy = false }
  }
}
