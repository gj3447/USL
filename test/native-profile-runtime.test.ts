import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { createNativeAdmission, createNativeProfileSnapshot } from "../src/addons/native-profile.js"
import { openNativeProfileStore } from "../src/addons/native-profile-store.js"
import { compileNativeProfileGraph, nativeHostBindingDigest, switchNativeProfile } from "../src/addons/native-profile-runtime.js"
import { digestSource } from "../src/language/digest.js"

const bytesDigest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`
const owner = "urn:test:native-runtime:owner"
const fixture = async (t: TestContext) => {
  const base = await mkdtemp("/dev/shm/usl-native-profile-runtime-")
  t.after(() => rm(base, { recursive: true, force: true }))
  const roots = { a: join(base, "a"), b: join(base, "b"), bad: join(base, "bad") }
  const policy = '{"mode":"strict"}\n', plan = '{"plan":"portable"}\n'
  for (const root of Object.values(roots)) await mkdir(root, { recursive: true })
  for (const root of [roots.a, roots.b]) {
    await writeFile(join(root, "policy.json"), policy)
    await writeFile(join(root, "plan.json"), plan)
  }
  await writeFile(join(roots.bad, "policy.json"), '{"mode":"changed"}\n')
  await writeFile(join(roots.bad, "plan.json"), plan)
  const graph = JSON.stringify({
    schema: "usl-resource-graph/v1",
    resources: [
      { id: "urn:test:native-runtime:policy", types: ["urn:test:native-runtime:Policy"], locator: "file://portable/policy.json", metadata: { authorityClass: "USER_PRIMARY", pin: "policy" } },
      { id: "urn:test:native-runtime:plan", types: ["urn:test:native-runtime:Plan"], locator: "file://portable/plan.json", metadata: { authorityClass: "SECONDARY_AI", pin: "plan" } },
    ],
    meanings: [{ id: "supports", description: "policy supports plan" }],
    links: [{ id: "urn:test:native-runtime:link:policy-plan", meaning: "supports", participants: [
      { role: "policy", resource: "urn:test:native-runtime:policy" }, { role: "plan", resource: "urn:test:native-runtime:plan" },
    ], metadata: { status: "DECLARED" } }],
    provenance: { sources: ["urn:test:native-runtime:policy"], activity: "urn:test:native-runtime:plan" },
  })
  const bindings = {
    schema: "usl-resource-bindings/v1",
    resources: [
      { id: "urn:test:native-runtime:policy", representations: [{ id: "policy_file", relation: "documentation", kind: "workspace", workspace: "usl", path: "policy.json", digest: bytesDigest(policy) }] },
      { id: "urn:test:native-runtime:plan", representations: [{ id: "plan_file", relation: "documentation", kind: "workspace", workspace: "usl", path: "plan.json", digest: bytesDigest(plan) }] },
    ],
  }
  const manifest = {
    schema: "usl-native-profile/v1", id: "urn:test:native-runtime:profile", ownerNamespace: owner, workspaceAliases: ["usl"], bindings,
    selections: [{ resource: "urn:test:native-runtime:policy", representation: "policy_file" }, { resource: "urn:test:native-runtime:plan", representation: "plan_file" }],
    graphDigest: digestSource(graph), policy: { id: "urn:test:native-runtime:policy-contract", digest: bytesDigest("contract") }, requiredSources: [], requiredEvaluators: [],
    capabilities: [{ id: "urn:test:native-runtime:action", descriptorDigest: bytesDigest("descriptor"), scopeDigest: bytesDigest("scope") }],
  }
  const environment = (root: string) => ({ workspaces: { usl: root }, checkouts: {}, checkoutPolicies: [] })
  return { base, roots, graph, manifest, environment }
}

const snapshot = (manifest: object, environment: object, generation = 1) =>
  createNativeProfileSnapshot(manifest, generation, nativeHostBindingDigest(environment))

test("native profile compilation and root switch preserve portable graph identity while rebinding only locators", async t => {
  const value = await fixture(t), environmentA = value.environment(value.roots.a), environmentB = value.environment(value.roots.b)
  const firstSnapshot = snapshot(value.manifest, environmentA)
  const first = await compileNativeProfileGraph(value.graph, firstSnapshot, environmentA)
  const store = await openNativeProfileStore({ directory: join(value.base, "store"), ownerNamespace: owner, initialSnapshot: firstSnapshot,
    clock: () => new Date("2026-10-11T00:00:00.000Z") })
  const request: any = { expectedStateDigest: (await store.read()).digest, graph: value.graph, manifest: value.manifest,
    environment: { ...environmentB, workspaces: { ...environmentB.workspaces }, checkouts: {}, checkoutPolicies: [] } }
  const pending = switchNativeProfile(store, request)
  request.environment.workspaces.usl = value.roots.bad
  request.maxResources = 1
  const switched = await pending
  assert.equal(switched.status, "COMMITTED")
  if (switched.status !== "COMMITTED") return
  const second = switched.compilation
  assert.equal(second.hostBindingDigest, nativeHostBindingDigest(environmentB))
  assert.equal(first.snapshotDigest, firstSnapshot.digest)
  assert.equal(second.sourceGraphDigest, first.sourceGraphDigest)
  assert.equal(second.bindingReceipt.bindingsDigest, first.bindingReceipt.bindingsDigest)
  assert.notEqual(second.bindingReceipt.resultDigest, first.bindingReceipt.resultDigest)
  assert.deepEqual(second.graph.resources.map(item => item.id), first.graph.resources.map(item => item.id))
  assert.deepEqual(second.graph.resources.map(item => [item.id, item.types, item.metadata]), first.graph.resources.map(item => [item.id, item.types, item.metadata]))
  assert.deepEqual(second.graph.links, first.graph.links)
  assert.deepEqual(second.graph.meanings, first.graph.meanings)
  assert.deepEqual(second.graph.provenance, first.graph.provenance)
  assert.deepEqual(second.bindingReceipt.selections.map(item => [item.resource, item.representation, item.expectedDigest]), first.bindingReceipt.selections.map(item => [item.resource, item.representation, item.expectedDigest]))
  assert.notDeepEqual(second.graph.resources.map(item => item.locator), first.graph.resources.map(item => item.locator))
  assert.equal((await store.read()).active?.generation, 2)
})

test("native profile runtime holds altered pins, missing paths, alias scope, and resource budgets", async t => {
  const value = await fixture(t), environmentA = value.environment(value.roots.a), environmentBad = value.environment(value.roots.bad)
  const firstSnapshot = snapshot(value.manifest, environmentA)
  await assert.rejects(compileNativeProfileGraph(`${value.graph} `, firstSnapshot, environmentA), error => error instanceof Error && error.name === "NativeProfileRuntimeError" && (error as any).code === "PIN_MISMATCH")
  await assert.rejects(compileNativeProfileGraph(value.graph, firstSnapshot, environmentBad), error => error instanceof Error && error.name === "NativeProfileRuntimeError" && (error as any).code === "PIN_MISMATCH")
  const absent = value.environment(join(value.base, "absent")); await mkdir(absent.workspaces.usl)
  const absentSnapshot = snapshot(value.manifest, absent)
  await assert.rejects(compileNativeProfileGraph(value.graph, absentSnapshot, absent), error => error instanceof Error && error.name === "NativeProfileRuntimeError" && (error as any).code === "UNAVAILABLE")
  const otherAlias = { workspaces: { other: value.roots.a }, checkouts: {}, checkoutPolicies: [] }
  const otherAliasSnapshot = snapshot(value.manifest, otherAlias)
  await assert.rejects(compileNativeProfileGraph(value.graph, otherAliasSnapshot, otherAlias), error => error instanceof Error && error.name === "NativeProfileRuntimeError" && (error as any).code === "RESOURCE_SCOPE")
  const store = await openNativeProfileStore({ directory: join(value.base, "store"), ownerNamespace: owner, initialSnapshot: firstSnapshot,
    clock: () => new Date("2026-10-11T00:00:00.000Z") })
  const current = await store.read()
  const mismatch = await switchNativeProfile(store, { expectedStateDigest: current.digest, graph: value.graph, manifest: value.manifest, environment: environmentBad })
  assert.deepEqual([mismatch.status, mismatch.status === "HOLD" ? mismatch.reason : null], ["HOLD", "NATIVE_OBSERVATION_HELD"])
  const limited = await switchNativeProfile(store, { expectedStateDigest: current.digest, graph: value.graph, manifest: value.manifest, environment: environmentA, maxResources: 1 })
  assert.deepEqual([limited.status, limited.status === "HOLD" ? limited.reason : null], ["HOLD", "OBSERVATION_RESOURCE_BUDGET"])
  await assert.rejects(switchNativeProfile(store, { expectedStateDigest: current.digest, graph: value.graph, manifest: value.manifest, environment: environmentA, maxResources: 129 }))
})

test("native profile switch uses public store CAS: stale and concurrent writers cannot activate twice", async t => {
  const value = await fixture(t), environment = value.environment(value.roots.a), firstSnapshot = snapshot(value.manifest, environment)
  const store = await openNativeProfileStore({ directory: join(value.base, "store"), ownerNamespace: owner, initialSnapshot: firstSnapshot,
    clock: () => new Date("2026-10-11T00:00:00.000Z") })
  const state = await store.read(), input = { expectedStateDigest: state.digest, graph: value.graph, manifest: value.manifest, environment }
  const [one, two] = await Promise.all([switchNativeProfile(store, input), switchNativeProfile(store, input)])
  assert.equal([one, two].filter(result => result.status === "COMMITTED").length, 1)
  assert.equal((await store.read()).generation, 2)
  const stale = await switchNativeProfile(store, input)
  assert.deepEqual([stale.status, stale.status === "CONFLICT" ? stale.reason : null], ["CONFLICT", "STALE_STATE"])
  const oldAdmission = createNativeAdmission({ id: "urn:test:native-runtime:admission", invocationId: "urn:test:native-runtime:invocation", actionId: "urn:test:native-runtime:action", scopeDigest: bytesDigest("scope"), inputDigest: bytesDigest("input"), observationDigest: bytesDigest("observation"), deliveryDigest: bytesDigest("delivery"), evaluatorDigest: bytesDigest("evaluation"), issuedAt: "2026-10-11T00:00:00.000Z", expiresAt: "2026-10-11T00:01:00.000Z" }, firstSnapshot)
  const rejected = await store.issue((await store.read()).digest, oldAdmission)
  assert.equal(rejected.status, "HOLD")
})
