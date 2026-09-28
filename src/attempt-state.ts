/** Pure lifecycle contract for one host-owned execution attempt. */
import { contractSnapshot, freezeContract } from "./contract-core.js"

export type AttemptPhase = "PLANNED" | "INTENT_DURABLE" | "AUTHORIZED" | "SUCCEEDED" | "INDETERMINATE" | "REJECTED"
export interface AttemptState { readonly phase: AttemptPhase }
export type AttemptEvent =
  | { readonly type: "INTENT_SAVED" }
  | { readonly type: "AUTHORIZE_START"; readonly pinsMatch: boolean }
  | { readonly type: "REJECT_BEFORE_START" }
  | { readonly type: "FINISH"; readonly started: boolean; readonly succeeded: boolean }

const phases = new Set<AttemptPhase>(["PLANNED", "INTENT_DURABLE", "AUTHORIZED", "SUCCEEDED", "INDETERMINATE", "REJECTED"])
const state = (phase: AttemptPhase): AttemptState => Object.freeze({ phase })
const invalid = (message: string): never => { throw new Error(`invalid attempt transition: ${message}`) }
const object = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid(`${label} must be an object`)
  return value as Record<string, unknown>
}
const exactKeys = (value: Record<string, unknown>, keys: readonly string[], label: string) => {
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid(`unknown ${label} field: ${key}`)
}
/* Take JSON snapshots before looking at discriminants.  Public TypeScript types
 * are erasable, so this also rejects getters, prototypes, coercible booleans,
 * and later mutation from untyped callers. */
const captureState = (input: unknown): AttemptState => {
  const value = object(contractSnapshot(input), "attempt state")
  exactKeys(value, ["phase"], "attempt state")
  if (typeof value.phase !== "string" || !phases.has(value.phase as AttemptPhase)) return invalid("unknown state")
  return state(value.phase as AttemptPhase)
}
const captureEvent = (input: unknown): AttemptEvent => {
  const value = object(contractSnapshot(input), "attempt event")
  if (value.type === "INTENT_SAVED" || value.type === "REJECT_BEFORE_START") {
    exactKeys(value, ["type"], "attempt event")
    return freezeContract({ type: value.type })
  }
  if (value.type === "AUTHORIZE_START") {
    exactKeys(value, ["type", "pinsMatch"], "attempt event")
    if (typeof value.pinsMatch !== "boolean") return invalid("AUTHORIZE_START pinsMatch must be boolean")
    return freezeContract({ type: "AUTHORIZE_START" as const, pinsMatch: value.pinsMatch })
  }
  if (value.type === "FINISH") {
    exactKeys(value, ["type", "started", "succeeded"], "attempt event")
    if (typeof value.started !== "boolean" || typeof value.succeeded !== "boolean") return invalid("FINISH started and succeeded must be boolean")
    return freezeContract({ type: "FINISH" as const, started: value.started, succeeded: value.succeeded })
  }
  return invalid("unknown attempt event")
}

export const initialAttemptState = (): AttemptState => state("PLANNED")

/**
 * `AUTHORIZED` permits dispatch after durable intent and matching pins; it is
 * not evidence that an operating-system process has started.
 */
export const transitionAttempt = (current: AttemptState, event: AttemptEvent): AttemptState => {
  const capturedState = captureState(current), capturedEvent = captureEvent(event)
  switch (capturedState.phase) {
    case "PLANNED":
      if (capturedEvent.type === "INTENT_SAVED") return state("INTENT_DURABLE")
      break
    case "INTENT_DURABLE":
      if (capturedEvent.type === "AUTHORIZE_START") {
        if (!capturedEvent.pinsMatch) return invalid("pins do not match")
        return state("AUTHORIZED")
      }
      if (capturedEvent.type === "REJECT_BEFORE_START") return state("REJECTED")
      break
    case "AUTHORIZED":
      if (capturedEvent.type === "FINISH") {
        if (!capturedEvent.started) return state("REJECTED")
        return state(capturedEvent.succeeded ? "SUCCEEDED" : "INDETERMINATE")
      }
      break
  }
  return invalid(`${capturedState.phase} cannot accept ${capturedEvent.type}`)
}
