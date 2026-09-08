import { Data, Either } from "effect"
import { digestJson } from "./digest.js"
import { agentContext, type AgentContext, type NavigationError, type NavigationQuery } from "./navigation.js"
import type { SemanticPlan } from "./model.js"

/** A transport failure. It never returns a partially serialized semantic context. */
export class ContextDeliveryError extends Data.TaggedError("ContextDeliveryError")<{
  readonly reason: "INVALID_OPTIONS" | "BUDGET_EXCEEDED"
  readonly detail: string
  readonly measured?: number
  readonly limit?: number
}> { get message() { return `${this.reason}: ${this.detail}` } }

export interface TokenCounter {
  /** Identifies the tokenizer and its version; this is an estimate, not billed usage. */
  readonly id: string
  readonly count: (text: string) => number
}

export interface CompactContextOptions {
  /** UTF-8 bytes of the final JSON text, including its trailing newline. Default: 8192. */
  readonly maxBytes?: number
  /** Exact digest of a previously received FULL compact context. */
  readonly knownContextDigest?: string
  /** Optional tokenizer-specific delivery budget. Requires tokenCounter. */
  readonly maxTokens?: number
  readonly tokenCounter?: TokenCounter
}

type CompactPath = {
  readonly resource: string
  readonly steps: ReadonlyArray<readonly [link: string, enteredRole: string, exitedRole: string]>
}

export interface FullCompactContext {
  readonly schema: "usl-agent-context-compact/v1"
  readonly mode: "FULL"
  readonly namespace: string
  readonly planDigest: string
  readonly focus: string
  readonly routes: AgentContext["routes"]
  readonly resources: AgentContext["resources"]
  readonly meanings: AgentContext["meanings"]
  readonly links: AgentContext["links"]
  /** Names the tuple fields once; all path steps use this exact order. */
  readonly pathStepFields: readonly ["link", "enteredRole", "exitedRole"]
  readonly paths: ReadonlyArray<CompactPath>
  /** For FOUND, the witness is the path whose resource equals target.resource. */
  readonly target: { readonly resource: string; readonly status: NonNullable<AgentContext["target"]>["status"] } | null
  readonly coverage: AgentContext["coverage"]
  readonly interpretation: AgentContext["interpretation"]
  readonly contextDigest: string
}

export interface UnchangedCompactContext {
  readonly schema: "usl-agent-context-compact/v1"
  readonly mode: "UNCHANGED"
  readonly planDigest: string
  readonly contextDigest: string
}

export interface CompactContextResult {
  readonly text: string
  readonly contextDigest: string
  readonly mode: "FULL" | "UNCHANGED"
  readonly stats: {
    readonly baselineBytes: number
    readonly deliveredBytes: number
    readonly bytesSaved: number
    readonly tokens: { readonly counterId: string; readonly baseline: number; readonly delivered: number; readonly saved: number } | null
  }
}

const digestPattern = /^sha256:[a-f0-9]{64}$/
const byteLength = (text: string): number => Buffer.byteLength(text, "utf8")
const textOf = (value: unknown): string => `${JSON.stringify(value)}\n`

const invalid = (detail: string): Either.Either<never, ContextDeliveryError> =>
  Either.left(new ContextDeliveryError({ reason: "INVALID_OPTIONS", detail }))

/**
 * Lossless transport form of agentContext. The original complete resource, meaning and
 * n-ary link declarations remain present; repeated path fields are reconstructed from them.
 */
export const compactAgentContext = (
  plan: SemanticPlan,
  query: NavigationQuery,
  options: CompactContextOptions = {},
): Either.Either<CompactContextResult, NavigationError | ContextDeliveryError> => {
  if (!options || typeof options !== "object" || Array.isArray(options)) return invalid("options must be an object")
  // Snapshot caller-controlled values before navigation or a counter callback can run.
  const maxBytesOption = options.maxBytes
  const knownContextDigest = options.knownContextDigest
  const maxTokens = options.maxTokens
  const rawCounter = options.tokenCounter
  const maxBytes = maxBytesOption === undefined ? 8192 : maxBytesOption
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return invalid("maxBytes must be a nonnegative safe integer")
  if (knownContextDigest !== undefined && (typeof knownContextDigest !== "string" || !digestPattern.test(knownContextDigest))) return invalid("knownContextDigest must be a sha256 digest")
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 0)) return invalid("maxTokens must be a nonnegative safe integer")
  if (maxTokens !== undefined && rawCounter === undefined) return invalid("maxTokens requires tokenCounter")
  if (rawCounter !== undefined && (!rawCounter || typeof rawCounter !== "object" || Array.isArray(rawCounter))) return invalid("tokenCounter must be an object")
  const counterId = rawCounter === undefined ? undefined : rawCounter.id
  const counterCount = rawCounter === undefined ? undefined : rawCounter.count
  if (rawCounter !== undefined && (typeof counterId !== "string" || !counterId.trim() || typeof counterCount !== "function")) return invalid("tokenCounter requires a nonempty id and count function")

  const context = agentContext(plan, query)
  if (Either.isLeft(context)) return Either.left(context.left)
  const baselineText = textOf(context.right)
  const fullWithoutDigest = {
    schema: "usl-agent-context-compact/v1" as const,
    mode: "FULL" as const,
    namespace: context.right.namespace,
    planDigest: context.right.planDigest,
    focus: context.right.focus,
    routes: context.right.routes,
    resources: context.right.resources,
    meanings: context.right.meanings,
    links: context.right.links,
    pathStepFields: ["link", "enteredRole", "exitedRole"] as const,
    paths: context.right.paths.map((path): CompactPath => ({ resource: path.resource, steps: path.steps.map((step) => [step.link, step.enteredRole, step.exitedRole] as const) })),
    target: context.right.target === null ? null : { resource: context.right.target.resource, status: context.right.target.status },
    coverage: context.right.coverage,
    interpretation: context.right.interpretation,
  }
  const contextDigest = digestJson(fullWithoutDigest)
  const packet: FullCompactContext | UnchangedCompactContext = knownContextDigest === contextDigest
    ? { schema: "usl-agent-context-compact/v1", mode: "UNCHANGED", planDigest: context.right.planDigest, contextDigest }
    : { ...fullWithoutDigest, contextDigest }
  const text = textOf(packet)
  const deliveredBytes = byteLength(text)

  let tokens: CompactContextResult["stats"]["tokens"] = null
  if (counterCount !== undefined && counterId !== undefined) {
    let baseline: number, delivered: number
    try { baseline = counterCount(baselineText); delivered = counterCount(text) } catch (error) {
      return invalid(`tokenCounter threw: ${String(error)}`)
    }
    if (!Number.isSafeInteger(baseline) || baseline < 0 || !Number.isSafeInteger(delivered) || delivered < 0) return invalid("tokenCounter must return nonnegative safe integers")
    if (maxTokens !== undefined && delivered > maxTokens) return Either.left(new ContextDeliveryError({ reason: "BUDGET_EXCEEDED", detail: `compact context requires ${delivered} tokens by ${counterId}, exceeding maxTokens=${maxTokens}`, measured: delivered, limit: maxTokens }))
    tokens = { counterId, baseline, delivered, saved: baseline - delivered }
  }
  if (deliveredBytes > maxBytes) return Either.left(new ContextDeliveryError({ reason: "BUDGET_EXCEEDED", detail: `compact context requires ${deliveredBytes} bytes, exceeding maxBytes=${maxBytes}`, measured: deliveredBytes, limit: maxBytes }))
  return Either.right({ text, contextDigest, mode: packet.mode, stats: { baselineBytes: byteLength(baselineText), deliveredBytes, bytesSaved: byteLength(baselineText) - deliveredBytes, tokens } })
}
