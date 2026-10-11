import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { test } from "node:test"
import { createNativeAdmission, createNativeProfileSnapshot } from "../src/addons/native-profile.js"
import { openNativeProfileStore } from "../src/addons/native-profile-store.js"
import { contractDigest } from "../src/contract-core.js"

const hash = (char: string) => `sha256:${char.repeat(64)}`
const owner = "urn:example:owner"
const profile = (id = "urn:example:profile", generation = 1) => createNativeProfileSnapshot({
  schema: "usl-native-profile/v1", id, ownerNamespace: owner, workspaceAliases: ["root"],
  bindings: { schema: "usl-resource-bindings/v1", resources: [{ id: "native:one", representations: [{ id: "local", relation: "working-copy", kind: "workspace", workspace: "root", path: "one.txt", digest: hash("a") }] }] },
  selections: [{ resource: "native:one", representation: "local" }], graphDigest: hash("f"), policy: { id: "urn:example:policy", digest: hash("b") }, requiredSources: [], requiredEvaluators: [], capabilities: [{ id: "urn:example:action", descriptorDigest: hash("c"), scopeDigest: hash("d") }],
}, generation, hash("e"))
const admission = (snapshot: ReturnType<typeof profile>, id = "urn:example:admission") => createNativeAdmission({ id, invocationId: "urn:example:invoke", actionId: "urn:example:action", scopeDigest: hash("d"), inputDigest: hash("1"), observationDigest: hash("2"), deliveryDigest: hash("3"), evaluatorDigest: hash("4"), issuedAt: "2026-10-11T00:01:00.000Z", expiresAt: "2026-10-11T00:11:00.000Z" }, snapshot)
async function fixture(t: { after(callback: () => unknown): void }) { const root = await mkdtemp(join("/dev/shm", "usl-native-store-")); t.after(() => rm(root, { recursive: true, force: true })); return root }
const clock = () => new Date("2026-10-11T00:01:00.000Z")

test("P02 persists a profile, consumes an admission before an effect, and rejects replay", async t => {
  const directory = await fixture(t), first = profile(), store = await openNativeProfileStore({ directory, ownerNamespace: owner, initialSnapshot: first, clock })
  const opened = await store.read(); assert.equal(opened.active?.digest, first.digest); assert.equal(opened.generation, 1)
  const issued = await store.issue(opened.digest, admission(first)); assert.equal(issued.status, "COMMITTED")
  if (issued.status !== "COMMITTED") return
  const consumed = await store.consume(issued.state.digest, issued.value, "urn:example:attempt"); assert.equal(consumed.status, "COMMITTED")
  if (consumed.status !== "COMMITTED") return
  const replay = await store.consume(consumed.state.digest, issued.value, "urn:example:attempt:two"); assert.equal(replay.status, "HOLD")
  const reopened = await openNativeProfileStore({ directory, ownerNamespace: owner, clock }); assert.equal((await reopened.read()).admissions[0]?.state, "CONSUMED")
})

test("P02 CAS rejects stale handles and monotonic generation prevents ABA", async t => {
  const directory = await fixture(t), one = profile(), store = await openNativeProfileStore({ directory, ownerNamespace: owner, initialSnapshot: one, clock }), stale = await store.read()
  const two = profile("urn:example:profile", 2), activated = await store.activate(stale.digest, two); assert.equal(activated.status, "COMMITTED")
  const rejected = await store.activate(stale.digest, profile("urn:example:profile", 3)); assert.equal(rejected.status, "CONFLICT")
  if (activated.status !== "COMMITTED") return
  const withdrawn = await store.withdraw(activated.state.digest); assert.equal(withdrawn.status, "COMMITTED")
  if (withdrawn.status !== "COMMITTED") return
  assert.equal((await store.read()).active, null)
  const reused = await store.activate(withdrawn.state.digest, profile("urn:example:profile", 2)); assert.equal(reused.status, "HOLD")
  const next = await store.activate(withdrawn.state.digest, profile("urn:example:profile", 3)); assert.equal(next.status, "COMMITTED")
})

test("P02 holds concurrent writer locks and refuses malformed or reinitialised state", async t => {
  const directory = await fixture(t), first = profile(), store = await openNativeProfileStore({ directory, ownerNamespace: owner, initialSnapshot: first, clock })
  await mkdir(join(directory, "writer.lock")); assert.equal((await store.withdraw((await store.read()).digest)).status, "HOLD"); await rm(join(directory, "writer.lock"), { recursive: true })
  assert.equal((await openNativeProfileStore({ directory, ownerNamespace: owner, initialSnapshot: profile("urn:example:other", 1), clock })).read instanceof Function, true)
  await writeFile(join(directory, "state.json"), "{}")
  await assert.rejects(store.read())
})

test("P02 retains admission tombstones across profile changes and holds clock or scope drift", async t => {
  const directory = await fixture(t), first = profile(), store = await openNativeProfileStore({ directory, ownerNamespace: owner, initialSnapshot: first, clock })
  const issued = await store.issue((await store.read()).digest, admission(first)); assert.equal(issued.status, "COMMITTED")
  if (issued.status !== "COMMITTED") return
  const activated = await store.activate(issued.state.digest, profile("urn:example:profile", 2)); assert.equal(activated.status, "COMMITTED")
  if (activated.status !== "COMMITTED") return
  assert.equal((await store.issue(activated.state.digest, admission(profile("urn:example:profile", 2)))).status, "HOLD")
  const backwards = await openNativeProfileStore({ directory, ownerNamespace: owner, clock: () => new Date("2026-10-10T00:00:00.000Z") })
  assert.equal((await backwards.withdraw((await backwards.read()).digest)).status, "HOLD")
  assert.throws(() => createNativeAdmission({ id: "urn:example:wrong-scope", invocationId: "urn:example:invoke", actionId: "urn:example:action", scopeDigest: hash("b"), inputDigest: hash("1"), observationDigest: hash("2"), deliveryDigest: hash("3"), evaluatorDigest: hash("4"), issuedAt: "2026-10-11T00:01:00.000Z", expiresAt: "2026-10-11T00:11:00.000Z" }, profile("urn:example:profile", 2)), /action\/scope/)
})

test("P02 rejects a self-consistent forged admission whose action scope is absent from active capabilities", async t => {
  const directory = await fixture(t), first = profile(), store = await openNativeProfileStore({ directory, ownerNamespace: owner, initialSnapshot: first, clock })
  const legitimate = admission(first, "urn:example:forged"), { digest: _digest, ...body } = legitimate
  const forgedBody = { ...body, scopeDigest: hash("b") }, forged = { ...forgedBody, digest: contractDigest(forgedBody) }
  const result = await store.issue((await store.read()).digest, forged)
  assert.equal(result.status, "HOLD")
})

test("P02 consumes an owner-wide attempt ID only once", async t => {
  const directory = await fixture(t), first = profile(), store = await openNativeProfileStore({ directory, ownerNamespace: owner, initialSnapshot: first, clock })
  const one = await store.issue((await store.read()).digest, admission(first, "urn:example:admission:one")); assert.equal(one.status, "COMMITTED")
  if (one.status !== "COMMITTED") return
  const two = await store.issue(one.state.digest, admission(first, "urn:example:admission:two")); assert.equal(two.status, "COMMITTED")
  if (two.status !== "COMMITTED") return
  const firstUse = await store.consume(two.state.digest, one.value, "urn:example:shared-attempt"); assert.equal(firstUse.status, "COMMITTED")
  if (firstUse.status !== "COMMITTED") return
  const repeated = await store.consume(firstUse.state.digest, two.value, "urn:example:shared-attempt"); assert.equal(repeated.status, "HOLD")
  if (repeated.status === "HOLD") assert.equal(repeated.reason, "ATTEMPT_ID_REUSED")
})

test("P02 rejects a self-consistent persisted state whose active profile owner differs", async t => {
  const directory = await fixture(t), first = profile(), store = await openNativeProfileStore({ directory, ownerNamespace: owner, initialSnapshot: first, clock })
  const state = await store.read(), other = createNativeProfileSnapshot({ ...first.manifest, ownerNamespace: "urn:example:other-owner" }, 1, first.hostBindingDigest)
  const { digest: _digest, ...body } = state
  const corruptedBody = { ...body, active: other }, corrupted = { ...corruptedBody, digest: contractDigest(corruptedBody) }
  await writeFile(join(directory, "state.json"), JSON.stringify(corrupted))
  await assert.rejects(store.read(), /active profile owner differs/)
})
