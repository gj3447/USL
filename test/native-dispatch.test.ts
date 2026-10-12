import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { revokeNativeDelivery } from "../src/addons/native-delivery.js"
import { executeNativeDispatch, prepareNativeDispatch } from "../src/addons/native-dispatch.js"
import { createNativeProfileSnapshot } from "../src/addons/native-profile.js"
import { nativeDispatchFixture as fixture } from "./native-dispatch-fixture.js"

test("ND09 dispatches the pinned CLI once and durably clears its execution gate", async t => {
  const f = await fixture(t), input = f.input("one"), delivered = await f.delivery(input.invocationId)
  const prepared = await prepareNativeDispatch(f.host, input, delivered)
  assert.equal(prepared.report.status, "READY")
  const executed = await executeNativeDispatch(prepared)
  assert.equal(executed.report.status, "SUCCEEDED", JSON.stringify(executed.report))
  assert.equal(await readFile(f.marker, "utf8"), "ran\n")
  const state = await f.store.read()
  assert.equal(state.executionGate, undefined)
  assert.equal(state.admissions[0]?.state, "CONSUMED")
  assert.equal(state.admissions[0]?.effect?.outcome, "SUCCEEDED")
  assert.equal((await executeNativeDispatch(prepared)).report.status, "HOLD")
  assert.equal(await readFile(f.marker, "utf8"), "ran\n", "a consumed opaque handle cannot rerun the CLI")
})

test("ND09 refuses cloned, revoked, and duplicate-invocation dispatches before any effect", async t => {
  const f = await fixture(t), first = f.input("replay"), delivery = await f.delivery(first.invocationId)
  const prepared = await prepareNativeDispatch(f.host, first, delivery)
  assert.equal((await executeNativeDispatch(structuredClone(prepared))).report.status, "HOLD")
  revokeNativeDelivery(delivery)
  assert.equal((await executeNativeDispatch(prepared)).report.status, "HOLD")
  const fresh = f.input("other-admission"); const duplicate = { ...fresh, invocationId: first.invocationId }
  const duplicateDelivery = await f.delivery(duplicate.invocationId)
  assert.equal((await prepareNativeDispatch(f.host, duplicate, duplicateDelivery)).report.status, "READY")
  const ready = await prepareNativeDispatch(f.host, first, await f.delivery(first.invocationId))
  assert.equal(ready.report.status, "READY")
  await executeNativeDispatch(ready)
  assert.equal((await prepareNativeDispatch(f.host, duplicate, duplicateDelivery)).report.status, "HOLD")
  assert.equal(await readFile(f.marker, "utf8"), "ran\n")
})

test("ND09 holds missing delivery and failing, unknown, or timed-out evaluators", async t => {
  for (const evaluator of ["FAIL", "UNKNOWN", "SLOW"] as const) {
    const f = await fixture(t, { evaluator }), input = f.input(evaluator), delivery = await f.delivery(input.invocationId)
    const prepared = await prepareNativeDispatch(f.host, input, delivery)
    assert.equal(prepared.report.status, "HOLD", evaluator)
    await assert.rejects(readFile(f.marker), /ENOENT/u)
  }
  const f = await fixture(t), input = f.input("delivery"), good = await f.delivery(input.invocationId)
  assert.equal((await prepareNativeDispatch(f.host, input, structuredClone(good))).report.status, "HOLD")
})

test("ND09 preserves an execution gate for an indeterminate CLI timeout and never retries it", async t => {
  const f = await fixture(t, { delayRunner: true }), input = f.input("timeout"), delivered = await f.delivery(input.invocationId)
  const prepared = await prepareNativeDispatch(f.host, input, delivered)
  assert.equal(prepared.report.status, "READY")
  const executed = await executeNativeDispatch(prepared)
  assert.equal(executed.report.status, "UNKNOWN")
  const state = await f.store.read()
  assert.equal(state.executionGate?.attemptId, input.attemptId)
  assert.equal(state.admissions[0]?.effect?.outcome, "UNKNOWN")
  assert.equal((await executeNativeDispatch(prepared)).report.status, "HOLD")
  await assert.rejects(readFile(f.marker), /ENOENT/u)
})

test("ND09 rechecks selected bytes, host bindings, policy pins, and source pins before spawning", async t => {
  const changed = await fixture(t), changedInput = changed.input("changed"), changedDelivery = await changed.delivery(changedInput.invocationId)
  const changedPrepared = await prepareNativeDispatch(changed.host, changedInput, changedDelivery)
  assert.equal(changedPrepared.report.status, "READY")
  await writeFile(join(changed.workspace, "runner.mjs"), "throw new Error('changed after prepare')")
  assert.equal((await executeNativeDispatch(changedPrepared)).report.status, "HOLD")
  await assert.rejects(readFile(changed.marker), /ENOENT/u)

  const relocated = await fixture(t), relocatedInput = relocated.input("relocated"), relocatedPrepared = await prepareNativeDispatch(relocated.host, relocatedInput, await relocated.delivery(relocatedInput.invocationId))
  assert.equal(relocatedPrepared.report.status, "READY")
  relocated.context.environment = { workspaces: { project: join(relocated.base, "other") }, checkouts: {}, checkoutPolicies: [], httpPolicies: [] }
  assert.equal((await executeNativeDispatch(relocatedPrepared)).report.status, "HOLD")
  await assert.rejects(readFile(relocated.marker), /ENOENT/u)

  const wrongPolicy = await fixture(t), policyInput = wrongPolicy.input("policy"), policyDelivery = await wrongPolicy.delivery(policyInput.invocationId)
  const mismatchedHost = { ...wrongPolicy.host, registration: { ...wrongPolicy.host.registration, cli: { ...wrongPolicy.host.registration.cli, policyDigest: wrongPolicy.snapshot.digest } } }
  assert.equal((await prepareNativeDispatch(mismatchedHost, policyInput, policyDelivery)).report.status, "HOLD")

  const unpinned = await fixture(t, { unpinnedRunner: true }), unpinnedInput = unpinned.input("unpinned")
  assert.equal((await prepareNativeDispatch(unpinned.host, unpinnedInput, await unpinned.delivery(unpinnedInput.invocationId))).report.status, "HOLD")
})

test("ND09 holds when evaluator evidence or live delivery changes during the pre-spawn gate", async t => {
  const revoked = await fixture(t), revokedInput = revoked.input("revoke"), revokedDelivery = await revoked.delivery(revokedInput.invocationId)
  const revokedEvaluator = revoked.host.evaluators[0]!
  let revokedCalls = 0
  ;(revokedEvaluator as { evaluate: typeof revokedEvaluator.evaluate }).evaluate = async context => {
    revokedCalls++
    if (revokedCalls === 2) revokeNativeDelivery(revokedDelivery)
    return { status: "PASS", evidenceDigest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }
  }
  const revokedPrepared = await prepareNativeDispatch(revoked.host, revokedInput, revokedDelivery)
  assert.equal(revokedPrepared.report.status, "READY")
  assert.equal((await executeNativeDispatch(revokedPrepared)).report.status, "HOLD")
  await assert.rejects(readFile(revoked.marker), /ENOENT/u)

  const drifted = await fixture(t), driftedInput = drifted.input("drift"), driftedDelivery = await drifted.delivery(driftedInput.invocationId)
  const driftedEvaluator = drifted.host.evaluators[0]!
  let driftedCalls = 0
  ;(driftedEvaluator as { evaluate: typeof driftedEvaluator.evaluate }).evaluate = async () => ({ status: "PASS", evidenceDigest: driftedCalls++ === 0 ? "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" : "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" })
  const driftedPrepared = await prepareNativeDispatch(drifted.host, driftedInput, driftedDelivery)
  assert.equal(driftedPrepared.report.status, "READY")
  assert.equal((await executeNativeDispatch(driftedPrepared)).report.status, "HOLD")
  await assert.rejects(readFile(drifted.marker), /ENOENT/u)
})

test("ND09 rejects a same-path CWD under an unselected resource identity", async t => {
  const f = await fixture(t), input = f.input("wrong-cwd"), bindingsPath = join(f.base, "bindings.json")
  const bindings = JSON.parse(await readFile(bindingsPath, "utf8"))
  bindings.resources.push({ id: "urn:test:native-dispatch:cwd-alias", representations: [{ id: "alias-local", relation: "working-copy", kind: "workspace", workspace: "project", path: "." }] })
  await writeFile(bindingsPath, JSON.stringify(bindings))
  const configFile = f.host.registration.cli.configFile, config = JSON.parse(await readFile(configFile, "utf8"))
  config.actions[0].cwd = { resource: "urn:test:native-dispatch:cwd-alias", representation: "alias-local" }
  await writeFile(configFile, JSON.stringify(config))
  ;(f.host.registration.cli as { hostDigest: string }).hostDigest = `sha256:${createHash("sha256").update(await readFile(configFile)).digest("hex")}`
  const prepared = await prepareNativeDispatch(f.host, input, await f.delivery(input.invocationId))
  assert.deepEqual([prepared.report.status, prepared.report.reasons], ["HOLD", ["CLI_CWD_OUTSIDE_PROFILE"]])
  await assert.rejects(readFile(f.marker), /ENOENT/u)
})

test("ND09 blocks a profile switch performed by the second evaluator gate", async t => {
  const f = await fixture(t), input = f.input("switch"), delivery = await f.delivery(input.invocationId)
  const evaluator = f.host.evaluators[0]!
  let calls = 0
  ;(evaluator as { evaluate: typeof evaluator.evaluate }).evaluate = async () => {
    if (++calls === 2) {
      const state = await f.store.read()
      const next = createNativeProfileSnapshot(f.snapshot.manifest, 2, f.snapshot.hostBindingDigest)
      assert.equal((await f.store.activate(state.digest, next)).status, "COMMITTED")
    }
    return { status: "PASS", evidenceDigest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }
  }
  const prepared = await prepareNativeDispatch(f.host, input, delivery)
  assert.equal(prepared.report.status, "READY")
  assert.equal((await executeNativeDispatch(prepared)).report.status, "HOLD")
  await assert.rejects(readFile(f.marker), /ENOENT/u)
})
