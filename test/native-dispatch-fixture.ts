import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { TestContext } from "node:test"
import { contractDigest } from "../src/contract-core.js"
import { digestSource } from "../src/language/digest.js"
import { deliverNativeRequiredSources } from "../src/addons/native-delivery.js"
import type { NativeDispatchHost } from "../src/addons/native-dispatch.js"
import { createNativeProfileSnapshot } from "../src/addons/native-profile.js"
import { openNativeProfileStore } from "../src/addons/native-profile-store.js"
import { nativeHostBindingDigest } from "../src/addons/native-profile-runtime.js"
import type { CliHostConfig } from "../src/cli-host.js"

const bytesHash = (value: Uint8Array | string) => `sha256:${createHash("sha256").update(value).digest("hex")}`
const owner = "urn:test:native-dispatch:owner"
const actionId = "urn:test:native-dispatch:action"
const loaderId = "urn:test:native-dispatch:loader"
const targetId = "urn:test:native-dispatch:target"
const evaluatorId = "urn:test:native-dispatch:evaluator"
const profilePolicy = { id: "urn:test:native-dispatch:policy", digest: bytesHash("profile-policy") }

export const nativeDispatchFixture = async (t: TestContext, options: { readonly evaluator?: "PASS" | "FAIL" | "UNKNOWN" | "SLOW"; readonly delayRunner?: boolean; readonly unpinnedRunner?: boolean } = {}) => {
  const base = await mkdtemp(join(tmpdir(), "usl-native-dispatch-"))
  t.after(() => rm(base, { recursive: true, force: true }))
  const workspace = join(base, "workspace"), receipts = join(base, "receipts"), marker = join(base, "marker")
  await Promise.all([mkdir(workspace), mkdir(receipts)])
  const graphSpec = await readFile("examples/fixtures/cli/graphspec.json", "utf8")
  const rule = '{"rule":"required selected source"}\n'
  const runner = options.delayRunner
    ? `import { appendFileSync } from "node:fs"; setTimeout(() => { appendFileSync(${JSON.stringify(marker)}, "ran\\n") }, 80); setTimeout(() => process.exit(0), 100)`
    : `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(marker)}, "ran\\n"); console.log(JSON.stringify({ok:true}))`
  await Promise.all([writeFile(join(workspace, "graphspec.json"), graphSpec), writeFile(join(workspace, "runner.mjs"), runner), writeFile(join(workspace, "rule.json"), rule)])
  const resourceIds = { graph: "urn:test:native-dispatch:graph", runner: "urn:test:native-dispatch:runner", cwd: "urn:test:native-dispatch:cwd", rule: "urn:test:native-dispatch:rule" }
  const profileGraph = JSON.stringify({ schema: "usl-resource-graph/v1", resources: Object.values(resourceIds).map((id, index) => ({ id, types: ["urn:test:native-dispatch:Resource"], locator: `file://portable/${index}` })), meanings: [], links: [], provenance: { sources: [resourceIds.graph], activity: resourceIds.runner } })
  const bindings = { schema: "usl-resource-bindings/v1", resources: [
    [resourceIds.graph, "graph", "graphspec.json", bytesHash(graphSpec)], [resourceIds.runner, "runner", "runner.mjs", options.unpinnedRunner ? undefined : bytesHash(runner)],
    [resourceIds.cwd, "cwd", ".", undefined], [resourceIds.rule, "rule", "rule.json", bytesHash(rule)],
  ].map(([id, representation, path, digest]) => ({ id, representations: [{ id: `${representation}-local`, relation: "working-copy", kind: "workspace", workspace: "project", path, ...(digest === undefined ? {} : { digest }) }] })) }
  const descriptor: CliHostConfig["actions"][number]["descriptor"] = { schema: "usl-capability/v1", id: "run", version: "1", connection: "fixture", nativeOperation: "run", sourceDigest: digestSource("native dispatch descriptor"), kind: "ACTION", effect: "WRITE", meanings: ["urn:test:native-dispatch:meaning"], requiredScopes: ["run"], input: { types: ["urn:test:native-dispatch:Input"], schema: true }, output: { types: ["urn:test:native-dispatch:Output"], schema: { type: "object", required: ["ok"], properties: { ok: { const: true } }, additionalProperties: false } }, mapping: { completeness: "COMPLETE", losses: [], unsupported: [] } }
  const policy: CliHostConfig["actions"][number]["policy"] = { connection: "fixture", capabilityId: "run", descriptorDigest: contractDigest(descriptor), sourceDigest: descriptor.sourceDigest, allowedEffects: ["WRITE"], allowedScopes: ["run"], allowLossy: false, maxInputBytes: 4096, maxOutputBytes: 4096, timeoutMs: options.delayRunner ? 10 : 3000 }
  await writeFile(join(base, "bindings.json"), JSON.stringify(bindings))
  const config: CliHostConfig = { schema: "usl-cli-host/v1", bindings: "bindings.json", workspaces: { project: workspace }, maxSourceBytes: 65536, operations: { namespace: "native-dispatch-operations", directory: "operations" }, actions: [{ id: "run", descriptor, policy, graph: { source: { resource: resourceIds.graph, representation: "graph-local" }, sourceDigest: digestSource(graphSpec), graphId: "usl.cli.example", graphspecDigest: JSON.parse(graphSpec).identity.graphspec_sha256, node: "usl_check", scope: "ENTRY_NODE_ONLY" }, cwd: { resource: resourceIds.cwd, representation: "cwd-local" }, command: { executable: "node", args: [{ resource: resourceIds.runner, representation: "runner-local" }], envAllowlist: [] }, pins: [{ source: { resource: resourceIds.runner, representation: "runner-local" }, digest: digestSource(runner) }] }] }
  const configFile = join(base, "host.json"); await writeFile(configFile, JSON.stringify(config))
  const environment = { workspaces: { project: workspace }, checkouts: {}, checkoutPolicies: [], httpPolicies: [] }
  const context: { graph: string; environment: unknown } = { graph: profileGraph, environment }
  const manifest = { schema: "usl-native-profile/v1", id: "urn:test:native-dispatch:profile", ownerNamespace: owner, workspaceAliases: ["project"], bindings, selections: [{ resource: resourceIds.graph, representation: "graph-local" }, { resource: resourceIds.runner, representation: "runner-local" }, { resource: resourceIds.cwd, representation: "cwd-local" }, { resource: resourceIds.rule, representation: "rule-local" }], graphDigest: digestSource(profileGraph), policy: profilePolicy, requiredSources: [{ id: "urn:test:native-dispatch:required-rule", resource: resourceIds.rule, representation: "rule-local", selector: { kind: "whole" as const }, revision: "r1", digest: bytesHash(rule), bytes: Buffer.byteLength(rule) }], requiredEvaluators: [{ id: evaluatorId, digest: bytesHash("evaluator") }], capabilities: [{ id: actionId, descriptorDigest: contractDigest(descriptor), scopeDigest: contractDigest(policy) }] }
  const snapshot = createNativeProfileSnapshot(manifest, 1, nativeHostBindingDigest(environment))
  const store = await openNativeProfileStore({ directory: join(base, "store"), ownerNamespace: owner, initialSnapshot: snapshot, clock: () => new Date("2026-10-12T00:00:00.000Z") })
  const registration = { actionId, targetId, loaderId, profilePolicy, cli: { configFile, actionId: "run", hostDigest: bytesHash(await readFile(configFile)), descriptorDigest: contractDigest(descriptor), policyDigest: contractDigest(policy) }, receiptRoot: receipts }
  const host: NativeDispatchHost = { store, registration, clock: () => new Date("2026-10-12T00:00:00.000Z"), readContext: async () => context, evaluators: [{ id: evaluatorId, digest: bytesHash("evaluator"), evaluate: async () => { if (options.evaluator === "SLOW") await new Promise(resolve => setTimeout(resolve, 30)); return { status: options.evaluator === "FAIL" ? "FAIL" : options.evaluator === "UNKNOWN" ? "UNKNOWN" : "PASS" as const, evidenceDigest: bytesHash("evidence") } } }], evaluatorTimeoutMs: options.evaluator === "SLOW" ? 10 : 5000 }
  const input = (suffix: string) => ({ invocationId: `urn:test:native-dispatch:invocation:${suffix}`, admissionId: `urn:test:native-dispatch:admission:${suffix}`, attemptId: `urn:test:native-dispatch:attempt:${suffix}`, request: { descriptorDigest: contractDigest(descriptor), sourceDigest: descriptor.sourceDigest, input: { types: ["urn:test:native-dispatch:Input"], value: { item: suffix } } } })
  const delivery = async (invocationId: string) => deliverNativeRequiredSources(snapshot, invocationId, { loaderId, targetId, read: async () => ({ bytes: await readFile(join(workspace, "rule.json")), revision: "r1" }), deliver: async request => ({ snapshotDigest: request.snapshotDigest, invocationId: request.invocationId, sourceId: request.source.id, loaderId, targetId, deliveredDigest: bytesHash(request.bytes), deliveredBytes: request.bytes.byteLength }) })
  return { base, workspace, marker, store, host, snapshot, context, input, delivery }
}
