import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { contractDigest } from "../src/contract-core.js"
import { revokeNativeDelivery } from "../src/addons/native-delivery.js"
import { executeNativeDispatch, prepareNativeDispatch } from "../src/addons/native-dispatch.js"
import { nativeDispatchFixture } from "./native-dispatch-fixture.js"

test("ND09 fault: an uncertain begin commit never starts the CLI and leaves reconciliation evidence", async t => {
  const fixture = await nativeDispatchFixture(t), real = fixture.store
  const store = {
    ...real,
    beginEffect: async (...args: Parameters<typeof real.beginEffect>) => {
      const committed = await real.beginEffect(...args)
      return committed.status === "COMMITTED" ? { status: "COMMIT_UNKNOWN" as const, reason: "FAULT_AFTER_DURABLE_BEGIN" } : committed
    },
  }
  const input = fixture.input("uncertain-begin"), delivery = await fixture.delivery(input.invocationId)
  const prepared = await prepareNativeDispatch({ ...fixture.host, store }, input, delivery)
  assert.equal(prepared.report.status, "READY")
  const result = await executeNativeDispatch(prepared)
  assert.equal(result.report.status, "UNKNOWN", JSON.stringify(result.report))
  assert.ok(result.report.reasons.includes("EXECUTION_GATE_COMMIT_UNKNOWN"))
  await assert.rejects(readFile(fixture.marker), /ENOENT/u)
  assert.ok((await real.read()).executionGate, "a potentially committed begin must remain reconcilable")
})

test("ND09 fault: an uncertain finalization retains the durable execution gate and forbids retry", async t => {
  const fixture = await nativeDispatchFixture(t), real = fixture.store
  const store = { ...real, finalizeEffect: async () => ({ status: "COMMIT_UNKNOWN" as const, reason: "FAULT_AFTER_EFFECT" }) }
  const input = fixture.input("uncertain-finalize"), delivery = await fixture.delivery(input.invocationId)
  const prepared = await prepareNativeDispatch({ ...fixture.host, store }, input, delivery)
  const result = await executeNativeDispatch(prepared)
  assert.equal(result.report.status, "UNKNOWN", JSON.stringify(result.report))
  assert.ok(result.report.reasons.includes("EFFECT_FINALIZE_COMMIT_UNKNOWN"))
  assert.equal(await readFile(fixture.marker, "utf8"), "ran\n")
  assert.ok((await real.read()).executionGate, "effect may have occurred; do not clear the gate on an unknown write")
  assert.equal((await executeNativeDispatch(prepared)).report.status, "HOLD")
})

test("ND09 fault: profile context drift after begin downgrades an otherwise successful CLI effect", async t => {
  const fixture = await nativeDispatchFixture(t), real = fixture.store, readContext = fixture.host.readContext
  let drift = false
  const store = {
    ...real,
    beginEffect: async (...args: Parameters<typeof real.beginEffect>) => {
      const result = await real.beginEffect(...args)
      if (result.status === "COMMITTED") drift = true
      return result
    },
  }
  const host = {
    ...fixture.host, store,
    readContext: async () => {
      const current = await readContext() as { readonly graph: string; readonly environment: { readonly workspaces: Readonly<Record<string, string>>; readonly checkouts: unknown; readonly checkoutPolicies: unknown; readonly httpPolicies?: unknown } }
      if (!drift) return current
      return { ...current, environment: { ...current.environment, workspaces: { ...current.environment.workspaces, project: fixture.base } } }
    },
  }
  const input = fixture.input("post-effect-drift"), delivery = await fixture.delivery(input.invocationId)
  const prepared = await prepareNativeDispatch(host, input, delivery)
  const result = await executeNativeDispatch(prepared)
  assert.equal(result.report.status, "UNKNOWN", JSON.stringify(result.report))
  assert.equal(result.effect?.outcome, "UNKNOWN")
  assert.equal(result.effect?.reason, "POST_EXECUTION_CONTEXT_CHANGED")
  assert.equal(await readFile(fixture.marker, "utf8"), "ran\n")
  assert.ok((await real.read()).executionGate, "unknown outcome deliberately keeps the durable reconciliation gate")
})

test("ND09 fault: a post-begin CLI exception persists UNKNOWN rather than rejecting a possibly started attempt", async t => {
  const fixture = await nativeDispatchFixture(t), real = fixture.store
  const input = fixture.input("post-begin-exception"), delivery = await fixture.delivery(input.invocationId)
  const leaf = join(fixture.host.registration.receiptRoot, contractDigest({ invocationId: input.invocationId, attemptId: input.attemptId }).slice(7))
  const store = {
    ...real,
    beginEffect: async (...args: Parameters<typeof real.beginEffect>) => {
      const committed = await real.beginEffect(...args)
      if (committed.status === "COMMITTED") {
        // The intent directory already exists. Colliding with the rejected result
        // turns the authorization failure into an exception outside cli-host's receipt path.
        await writeFile(join(leaf, "result.json"), "fault collision\n", { flag: "wx" })
        revokeNativeDelivery(delivery)
      }
      return committed
    },
  }
  const prepared = await prepareNativeDispatch({ ...fixture.host, store }, input, delivery)
  assert.equal(prepared.report.status, "READY")
  const result = await executeNativeDispatch(prepared)
  assert.equal(result.report.status, "UNKNOWN", JSON.stringify(result.report))
  assert.equal(result.effect?.dispatch, "UNKNOWN")
  assert.equal(result.effect?.outcome, "UNKNOWN")
  assert.equal(result.effect?.reason, "CLI_RESULT_UNAVAILABLE")
  await assert.rejects(readFile(fixture.marker), /ENOENT/u)
  assert.ok((await real.read()).executionGate)
  assert.equal((await executeNativeDispatch(prepared)).report.status, "HOLD")
})
