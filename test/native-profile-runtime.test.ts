import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createServer } from "node:http"
import { test, type TestContext } from "node:test"
import { createNativeAdmission, createNativeProfileSnapshot } from "../src/addons/native-profile.js"
import { openNativeProfileStore } from "../src/addons/native-profile-store.js"
import { compileNativeProfileGraph, nativeHostBindingDigest, prepareNativeProfileObservation, recheckNativeProfileObservation, switchNativeProfile } from "../src/addons/native-profile-runtime.js"
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

test("native profile switch requires pinned HTTP registration and fresh matching bytes, including a conditional 304", async t => {
  const value = await fixture(t), body = "owner selected HTTP source", etag = '"v1"'
  let requests = 0
  const server = createServer((request, response) => {
    requests++
    response.setHeader("ETag", etag)
    if (request.headers["if-none-match"] === etag) { response.writeHead(304); response.end() }
    else { response.end(body) }
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() }))
  const address = server.address(); assert.ok(address && typeof address === "object")
  const url = `http://127.0.0.1:${address.port}/source`, resource = "urn:test:native-runtime:http"
  const graph = JSON.stringify({ schema: "usl-resource-graph/v1", resources: [{ id: resource, types: ["urn:test:native-runtime:Source"], locator: url }], meanings: [], links: [] })
  const manifest = { ...value.manifest, workspaceAliases: [], graphDigest: digestSource(graph),
    bindings: { schema: "usl-resource-bindings/v1", resources: [{ id: resource, representations: [{ id: "remote", relation: "documentation", kind: "locator", locator: url, digest: bytesDigest(body) }] }] },
    selections: [{ resource, representation: "remote" }] }
  const registered = { workspaces: {}, checkouts: {}, checkoutPolicies: [], httpPolicies: [{ resource, representation: "remote", url, scopeDigest: bytesDigest("http-scope"), allowedUrls: [url] }] }
  const first = snapshot(manifest, registered)
  const prepared = await prepareNativeProfileObservation(graph, first, registered)
  assert.equal(prepared.report.status, "PASS")
  assert.ok(prepared.compilation)
  assert.equal((await recheckNativeProfileObservation(prepared)).status, "PASS")
  const store = await openNativeProfileStore({ directory: join(value.base, "http-store"), ownerNamespace: owner, initialSnapshot: first })
  const state = await store.read()
  const missing = await switchNativeProfile(store, { expectedStateDigest: state.digest, graph, manifest, environment: { workspaces: {}, checkouts: {}, checkoutPolicies: [] } })
  assert.equal(missing.status, "HOLD"); assert.equal(requests, 2)
  const changed = { ...manifest, bindings: { ...manifest.bindings, resources: [{ id: resource, representations: [{ ...manifest.bindings.resources[0]!.representations[0]!, digest: bytesDigest("wrong pin") }] }] } }
  assert.equal((await switchNativeProfile(store, { expectedStateDigest: state.digest, graph, manifest: changed, environment: registered })).status, "HOLD")
  assert.equal((await store.read()).digest, state.digest)
  const result = await switchNativeProfile(store, { expectedStateDigest: state.digest, graph, manifest, environment: registered })
  assert.equal(result.status, "COMMITTED")
  assert.equal(requests, 5)
  if (result.status === "COMMITTED") assert.equal(result.state.active?.manifestDigest, first.manifestDigest)
})

test("native profile observation handles are process-local and hold on source drift or an initial hold", async t => {
  const value = await fixture(t), environment = value.environment(value.roots.a), first = snapshot(value.manifest, environment)
  const prepared = await prepareNativeProfileObservation(value.graph, first, environment)
  assert.equal(prepared.report.status, "PASS")
  await assert.rejects(recheckNativeProfileObservation(structuredClone(prepared)), /not prepared by this process/)
  await writeFile(join(value.roots.a, "policy.json"), '{"mode":"drift"}\n')
  const stale = await recheckNativeProfileObservation(prepared)
  assert.deepEqual([stale.status, stale.reasons], ["HOLD", ["NATIVE_RECHECK_HELD"]])
  const held = await prepareNativeProfileObservation(value.graph, first, value.environment(value.roots.bad))
  assert.equal(held.report.status, "HOLD")
  assert.deepEqual(await recheckNativeProfileObservation(held), held.report)
})

test("native profile switch applies required-source byte pins even when local representations omit a digest", async t => {
  const value = await fixture(t), environmentA = value.environment(value.roots.a), environmentBad = value.environment(value.roots.bad)
  const policy = '{"mode":"strict"}\n', source = {
    id: "urn:test:native-runtime:required-policy", resource: "urn:test:native-runtime:policy", representation: "policy_file",
    selector: { kind: "whole" as const }, revision: "policy-v1", digest: bytesDigest(policy), bytes: Buffer.byteLength(policy),
  }
  const manifest = { ...value.manifest,
    bindings: { ...value.manifest.bindings, resources: value.manifest.bindings.resources.map(resource => resource.id === source.resource ? { ...resource, representations: resource.representations.map(representation => { const { digest: _digest, ...unpinned } = representation; return unpinned }) } : resource) },
    requiredSources: [source],
  }
  const first = snapshot(manifest, environmentA)
  const store = await openNativeProfileStore({ directory: join(value.base, "required-source-store"), ownerNamespace: owner, initialSnapshot: first,
    clock: () => new Date("2026-10-11T00:00:00.000Z") })
  const current = await store.read()
  const bad = await switchNativeProfile(store, { expectedStateDigest: current.digest, graph: value.graph, manifest, environment: environmentBad })
  assert.equal(bad.status, "HOLD")
  assert.equal((await store.read()).digest, current.digest)
  const good = await switchNativeProfile(store, { expectedStateDigest: current.digest, graph: value.graph, manifest, environment: environmentA })
  assert.equal(good.status, "COMMITTED")
  const wrongBytes = { ...manifest, requiredSources: [{ ...source, bytes: source.bytes + 1 }] }
  const after = await store.read()
  assert.equal((await switchNativeProfile(store, { expectedStateDigest: after.digest, graph: value.graph, manifest: wrongBytes, environment: environmentA })).status, "HOLD")
})
