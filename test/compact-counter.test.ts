import assert from "node:assert/strict"
import { test } from "node:test"
import { Either } from "effect"
import { compileSource } from "../src/language/compiler.js"
import { compactAgentContext, ContextDeliveryError, type CompactContextOptions } from "../src/language/compact.js"

const plan = () => Either.getOrThrow(compileSource(`usl "0.1"; namespace "compact.counter";
  resource a = "https://a.test"; resource b = "https://b.test";
  meaning relates(from: url, to: url) = "a relates to b";
  link relation = relates(from: a, to: b);`))
const query = { focus: "a", target: "b" }
const failure = (options: CompactContextOptions | null): ContextDeliveryError => {
  const result = compactAgentContext(plan(), query, options as CompactContextOptions)
  assert.ok(Either.isLeft(result))
  assert.ok(result.left instanceof ContextDeliveryError)
  return result.left
}

test("token budget is captured before a counter can mutate caller options", () => {
  const options: CompactContextOptions = {
    maxBytes: 100_000,
    maxTokens: 1,
    tokenCounter: {
      id: "test/v1",
      count: () => {
        ;(options as { maxTokens: number }).maxTokens = 1_000_000
        return 2
      },
    },
  }
  const error = failure(options)
  assert.equal(error.reason, "BUDGET_EXCEEDED")
  assert.equal(error.limit, 1)
  assert.equal(error.measured, 2)
})

test("null delivery options or counter return a typed invalid-options error", () => {
  assert.equal(failure(null).reason, "INVALID_OPTIONS")
  assert.equal(failure({ maxTokens: 1, tokenCounter: null as unknown as NonNullable<CompactContextOptions["tokenCounter"]> }).reason, "INVALID_OPTIONS")
  assert.equal(failure({ maxBytes: null as unknown as number }).reason, "INVALID_OPTIONS")
})

test("counter exceptions and invalid numeric results are rejected", () => {
  assert.equal(failure({ tokenCounter: { id: "throws", count: () => { throw new Error("no counter") } } }).reason, "INVALID_OPTIONS")
  assert.equal(failure({ tokenCounter: { id: "negative", count: () => -1 } }).reason, "INVALID_OPTIONS")
  assert.equal(failure({ tokenCounter: { id: "nan", count: () => Number.NaN } }).reason, "INVALID_OPTIONS")
})
