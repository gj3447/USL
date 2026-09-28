import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { contractDigest } from "../src/contract-core.js"
import { connectCliReconciler, inspectCliAttempt } from "../src/cli-recovery.js"
import { temporary } from "./fixtures.js"

const hash = (letter: string) => `sha256:${letter.repeat(64)}`
const intentFor = (attempt = "attempt-1") => {
  const planBody = { schema: "usl-cli-plan/v1", status: "READY", action: "registered.action", hostDigest: hash("b"), bindingsDigest: hash("c"), requestDigest: hash("d") }
  const plan = { ...planBody, planDigest: contractDigest(planBody) }
  const body = { schema: "usl-cli-intent/v1", attempt, startedAt: "2026-09-28T00:00:00.000Z", plan, status: "ATTEMPTING", recovery: "RECONCILE_WITH_OWNER; NEVER_AUTOMATICALLY_RETRY" }
  return { ...body, intentDigest: contractDigest(body) }
}
const resultFor = (intent: ReturnType<typeof intentFor>) => {
  const body = { schema: "usl-cli-execution/v1", status: "SUCCEEDED", attempt: intent.attempt, attempts: 1,
    startedAt: intent.startedAt, finishedAt: "2026-09-28T00:00:01.000Z", planDigest: intent.plan.planDigest, intentDigest: intent.intentDigest, automaticRetry: false,
    process: { started: true, exitCode: 0, reason: null }, reason: null, output: { ok: true } }
  return { ...body, receiptDigest: contractDigest(body) }
}
const setup = async (t: Parameters<typeof temporary>[0], result = false, attempt = "attempt-1") => {
  const base = await temporary(t), directory = join(base, "receipt"); await mkdir(directory)
  const intent = intentFor(attempt); await writeFile(join(directory, "intent.json"), JSON.stringify(intent))
  if (result) await writeFile(join(directory, "result.json"), JSON.stringify(resultFor(intent)))
  return { directory, intent }
}

test("intent-only receipt remains unknown and does not claim an external effect", async t => {
  const { directory, intent } = await setup(t)
  const inspected = await inspectCliAttempt(directory)
  assert.equal(inspected.status, "UNKNOWN"); assert.equal(inspected.executionStart, "UNKNOWN")
  assert.equal(inspected.externalEffect, "UNKNOWN"); assert.equal(inspected.automaticRetry, false)
  assert.equal(inspected.intent.intentDigest, intent.intentDigest); assert.ok(Object.isFrozen(inspected))
})

test("terminal result is linked to its intent, while corrupted and symlinked evidence fail closed", async t => {
  const valid = await setup(t, true), inspected = await inspectCliAttempt(valid.directory)
  assert.equal(inspected.status, "RECORDED"); assert.equal(inspected.recordedStatus, "SUCCEEDED")
  const corrupt = await setup(t); await writeFile(join(corrupt.directory, "result.json"), JSON.stringify({ ...resultFor(corrupt.intent), intentDigest: hash("e") }))
  await assert.rejects(inspectCliAttempt(corrupt.directory), /invalid receiptDigest|does not belong/)
  const linked = await setup(t); await symlink(join(linked.directory, "intent.json"), join(linked.directory, "result.json"))
  await assert.rejects(inspectCliAttempt(linked.directory))
})

test("a forged embedded plan or a result from another attempt fails closed", async t => {
  const forged = await setup(t)
  const badPlan = { ...forged.intent.plan, action: "different.action" }
  const { intentDigest: _ignoredIntentDigest, ...unsignedIntent } = forged.intent
  const body = { ...unsignedIntent, plan: badPlan }; const badIntent = { ...body, intentDigest: contractDigest(body) }
  await writeFile(join(forged.directory, "intent.json"), JSON.stringify(badIntent))
  await assert.rejects(inspectCliAttempt(forged.directory), /invalid planDigest/)
  const one = await setup(t), two = await setup(t, false, "attempt-2")
  await writeFile(join(one.directory, "result.json"), JSON.stringify(resultFor(two.intent)))
  await assert.rejects(inspectCliAttempt(one.directory), /does not belong/)
})

test("only the registered owner callback can append one reconciliation receipt", async t => {
  const { directory } = await setup(t), first = await inspectCliAttempt(directory)
  let calls = 0
  const reconciler = connectCliReconciler({ id: "test-owner", action: "registered.action", hostDigest: hash("b"), bindingsDigest: hash("c"),
    timeoutMs: 1_000, maxEvidenceBytes: 4_096,
    query: async context => { calls += 1; assert.equal(context.attempt, "attempt-1"); return { outcome: "APPLIED", evidence: [{ locator: "owner://record/1", digest: hash("f") }], observedAt: "2026-09-28T00:00:02.000Z" } },
  })
  const recorded: any = await reconciler.reconcile(directory, { expectedInspectionDigest: first.inspectionDigest })
  assert.equal(recorded.status, "RECORDED"); assert.equal(recorded.receipt.externalOutcome, "APPLIED"); assert.equal(calls, 1)
  const after = await inspectCliAttempt(directory)
  assert.equal(after.reconciliation?.origin, "REGISTERED_OWNER_CALLBACK")
  assert.equal(after.recoveryLock, true)
  await assert.rejects(reconciler.reconcile(directory, { expectedInspectionDigest: after.inspectionDigest }))
  assert.equal(calls, 1)
  assert.equal(JSON.parse(await readFile(join(directory, "reconciliation.json"), "utf8")).intentDigest, after.intent.intentDigest)
})

test("an indeterminate recorded attempt may be reconciled, but a successful one may not", async t => {
  const indeterminate = await setup(t), { receiptDigest: _ignored, output: _output, ...normal } = resultFor(indeterminate.intent)
  const resultBody = { ...normal, status: "INDETERMINATE", reason: "OUTPUT_SCHEMA", process: { started: true, exitCode: 0, reason: null } }
  const result = { ...resultBody, receiptDigest: contractDigest(resultBody) }
  await writeFile(join(indeterminate.directory, "result.json"), JSON.stringify(result))
  const inspection = await inspectCliAttempt(indeterminate.directory)
  const reconciler = connectCliReconciler({ id: "indeterminate-owner", action: "registered.action", hostDigest: hash("b"), bindingsDigest: hash("c"), timeoutMs: 1000, maxEvidenceBytes: 4096,
    query: async () => ({ outcome: "UNKNOWN", evidence: [], observedAt: "2026-09-28T00:00:03.000Z" }) })
  assert.equal((await reconciler.reconcile(indeterminate.directory, { expectedInspectionDigest: inspection.inspectionDigest }) as any).status, "RECORDED")
  const success = await setup(t, true), successInspection = await inspectCliAttempt(success.directory)
  await assert.rejects(reconciler.reconcile(success.directory, { expectedInspectionDigest: successInspection.inspectionDigest }))
})

test("owner-query failure is unknown and the permanent lock prevents an automatic retry", async t => {
  const { directory } = await setup(t), inspection = await inspectCliAttempt(directory)
  const reconciler = connectCliReconciler({ id: "fail-owner", action: "registered.action", hostDigest: hash("b"), bindingsDigest: hash("c"), timeoutMs: 100, maxEvidenceBytes: 100,
    query: async () => { throw new Error("owner unavailable") },
  })
  const outcome: any = await reconciler.reconcile(directory, { expectedInspectionDigest: inspection.inspectionDigest })
  assert.equal(outcome.status, "UNKNOWN"); await assert.rejects(readFile(join(directory, "reconciliation.json")))
  await assert.rejects(reconciler.reconcile(directory, { expectedInspectionDigest: inspection.inspectionDigest }))
})

test("reconciliation captures its expected digest before an await and rejects exotic registrations", async t => {
  const { directory } = await setup(t), inspection = await inspectCliAttempt(directory)
  const registration = { id: "capture-owner", action: "registered.action", hostDigest: hash("b"), bindingsDigest: hash("c"), timeoutMs: 1000, maxEvidenceBytes: 4096,
    query: async () => ({ outcome: "UNKNOWN" as const, evidence: [], observedAt: "2026-09-28T00:00:04.000Z" }) }
  const reconciler = connectCliReconciler(registration)
  let reads = 0
  const options: Record<string, unknown> = {}
  Object.defineProperty(options, "expectedInspectionDigest", { enumerable: true, get: () => (++reads === 1 ? inspection.inspectionDigest : hash("9")) })
  const outcome: any = await reconciler.reconcile(directory, options as { expectedInspectionDigest: string })
  assert.equal(outcome.status, "RECORDED"); assert.equal(reads, 1)
  const inherited = Object.create({ inherited: true }); Object.assign(inherited, registration)
  assert.throws(() => connectCliReconciler(inherited))
  const symbolRegistration = { ...registration, [Symbol("extra")]: true }
  assert.throws(() => connectCliReconciler(symbolRegistration))
})

test("noncooperative owner calls time out or cancel without a reconciliation receipt", async t => {
  const timed = await setup(t), initial = await inspectCliAttempt(timed.directory)
  let timeoutSignal: AbortSignal | undefined
  const timeoutReconciler = connectCliReconciler({ id: "timeout-owner", action: "registered.action", hostDigest: hash("b"), bindingsDigest: hash("c"), timeoutMs: 20, maxEvidenceBytes: 4096,
    query: async (_context, signal) => { timeoutSignal = signal; return new Promise<never>(() => undefined) } })
  const timeout: any = await timeoutReconciler.reconcile(timed.directory, { expectedInspectionDigest: initial.inspectionDigest })
  assert.equal(timeout.status, "UNKNOWN"); assert.equal(timeout.reason, "TIMEOUT"); assert.equal(timeoutSignal?.aborted, true)
  const timedAfter = await inspectCliAttempt(timed.directory)
  assert.equal(timedAfter.recoveryLock, true); assert.equal(timedAfter.intent.intentDigest, initial.intent.intentDigest)
  await assert.rejects(readFile(join(timed.directory, "reconciliation.json")))

  const cancelled = await setup(t), beforeCancel = await inspectCliAttempt(cancelled.directory), controller = new AbortController()
  let entered: (() => void) | undefined, cancelledSignal: AbortSignal | undefined
  const enteredQuery = new Promise<void>(resolveEntered => { entered = resolveEntered })
  const cancelReconciler = connectCliReconciler({ id: "cancel-owner", action: "registered.action", hostDigest: hash("b"), bindingsDigest: hash("c"), timeoutMs: 1_000, maxEvidenceBytes: 4096,
    query: async (_context, signal) => { cancelledSignal = signal; entered?.(); return new Promise<never>(() => undefined) } })
  const pending = cancelReconciler.reconcile(cancelled.directory, { expectedInspectionDigest: beforeCancel.inspectionDigest, signal: controller.signal })
  await enteredQuery; controller.abort()
  const cancelledResult: any = await pending
  assert.equal(cancelledResult.status, "UNKNOWN"); assert.equal(cancelledResult.reason, "CANCELLED"); assert.equal(cancelledSignal?.aborted, true)
  const cancelledAfter = await inspectCliAttempt(cancelled.directory)
  assert.equal(cancelledAfter.recoveryLock, true); assert.equal(cancelledAfter.intent.intentDigest, beforeCancel.intent.intentDigest)
  await assert.rejects(readFile(join(cancelled.directory, "reconciliation.json")))

  const mismatch = await setup(t), mismatchInspection = await inspectCliAttempt(mismatch.directory)
  let calls = 0
  const wrongOwner = connectCliReconciler({ id: "wrong-owner", action: "registered.action", hostDigest: hash("9"), bindingsDigest: hash("c"), timeoutMs: 100, maxEvidenceBytes: 4096,
    query: async () => { calls += 1; return { outcome: "UNKNOWN", evidence: [], observedAt: "2026-09-28T00:00:05.000Z" } } })
  await assert.rejects(wrongOwner.reconcile(mismatch.directory, { expectedInspectionDigest: mismatchInspection.inspectionDigest }))
  assert.equal(calls, 0); assert.equal((await inspectCliAttempt(mismatch.directory)).recoveryLock, false)
})
