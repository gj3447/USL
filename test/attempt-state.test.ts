import assert from "node:assert/strict"
import { test } from "node:test"
import { initialAttemptState, transitionAttempt } from "../src/attempt-state.js"

const intent = () => transitionAttempt(initialAttemptState(), { type: "INTENT_SAVED" })
const authorized = () => transitionAttempt(intent(), { type: "AUTHORIZE_START", pinsMatch: true })

test("attempt lifecycle requires durable intent and matching pins before authorization", () => {
  assert.equal(Object.isFrozen(initialAttemptState()), true)
  assert.throws(() => transitionAttempt(initialAttemptState(), { type: "AUTHORIZE_START", pinsMatch: true }), /PLANNED/)
  assert.throws(() => transitionAttempt(intent(), { type: "AUTHORIZE_START", pinsMatch: false }), /pins do not match/)
  assert.equal(authorized().phase, "AUTHORIZED")
})

test("attempt finish distinguishes no-start, success and indeterminate outcomes", () => {
  assert.equal(transitionAttempt(authorized(), { type: "FINISH", started: false, succeeded: true }).phase, "REJECTED")
  assert.equal(transitionAttempt(authorized(), { type: "FINISH", started: true, succeeded: true }).phase, "SUCCEEDED")
  assert.equal(transitionAttempt(authorized(), { type: "FINISH", started: true, succeeded: false }).phase, "INDETERMINATE")
  assert.equal(transitionAttempt(intent(), { type: "REJECT_BEFORE_START" }).phase, "REJECTED")
})

test("terminal states are immutable and authorization cannot be repeated", () => {
  for (const terminal of [transitionAttempt(intent(), { type: "REJECT_BEFORE_START" }), transitionAttempt(authorized(), { type: "FINISH", started: true, succeeded: true })]) {
    assert.throws(() => transitionAttempt(terminal, { type: "INTENT_SAVED" }), /cannot accept/)
  }
  assert.throws(() => transitionAttempt(authorized(), { type: "AUTHORIZE_START", pinsMatch: true }), /AUTHORIZED/)
})

test("attempt inputs are strict JSON snapshots before the state machine reads them", () => {
  assert.throws(() => transitionAttempt({ phase: "PLANNED", extra: true } as unknown as ReturnType<typeof initialAttemptState>, { type: "INTENT_SAVED" }), /unknown attempt state field/)
  assert.throws(() => transitionAttempt(initialAttemptState(), { type: "AUTHORIZE_START", pinsMatch: 1 } as unknown as Parameters<typeof transitionAttempt>[1]), /must be boolean/)
  const getter = Object.create(null, { type: { enumerable: true, get: () => "INTENT_SAVED" } })
  assert.throws(() => transitionAttempt(initialAttemptState(), getter as Parameters<typeof transitionAttempt>[1]), /accessors/)
  assert.throws(() => transitionAttempt(initialAttemptState(), { type: "UNKNOWN" } as unknown as Parameters<typeof transitionAttempt>[1]), /unknown attempt event/)
})
