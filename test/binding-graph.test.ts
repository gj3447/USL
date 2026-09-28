import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { bindResourceGraph } from "../src/integrations/resource-bindings.js"
import { parseResourceBindings } from "../src/resource-bindings.js"
import { temporary } from "./fixtures.js"

const commit = "0123456789abcdef0123456789abcdef01234567"
const graph = JSON.stringify({ schema: "usl-resource-graph/v1", resources: [
  { id: "engine", types: ["urn:example:Code"], locator: "https://old.example/engine", metadata: { owner: "core" } },
  { id: "remote", types: ["urn:example:Repository"], locator: "https://old.example/remote", metadata: { branch: "main" } },
], meanings: [{ id: "depends", description: "dependency" }], links: [{ id: "edge", meaning: "depends", participants: [
  { role: "from", resource: "engine" }, { role: "to", resource: "remote" },
] }] })

const bindings = () => parseResourceBindings({ schema: "usl-resource-bindings/v1", resources: [
  { id: "engine", representations: [
    { id: "engine-local", relation: "working-copy", kind: "workspace", workspace: "checkout", path: "src/engine.ts" },
    { id: "engine-git", relation: "snapshot", kind: "locator", locator: `git://github.com/example/engine@${commit}:src/engine.ts` },
  ] },
  { id: "remote", representations: [{ id: "remote-git", relation: "snapshot", kind: "locator", locator: `git://github.com/example/remote@${commit}:README.md` }] },
  { id: "orphan", representations: [{ id: "orphan-git", relation: "snapshot", kind: "locator", locator: `git://github.com/example/orphan@${commit}:README.md` }] },
] })

const workspace = async (t: TestContext) => {
  const root = await temporary(t)
  await mkdir(join(root, "src"))
  await writeFile(join(root, "src", "engine.ts"), "export {}\n")
  return root
}

test("selected local and Git representations preserve graph identities while relocated addresses change", async (t) => {
  const first = await workspace(t), second = await workspace(t), document = bindings()
  const selections = [{ resource: "engine", representation: "engine-local" }, { resource: "remote", representation: "remote-git" }] as const
  const one = await bindResourceGraph(graph, document, selections, { workspaces: { checkout: first }, hostname: "binding-host" })
  const two = await bindResourceGraph(graph, document, selections, { workspaces: { checkout: second }, hostname: "binding-host" })
  assert.deepEqual(one.graph.resources.map(resource => resource.id), ["engine", "remote"])
  assert.deepEqual(one.graph.meanings, JSON.parse(graph).meanings)
  assert.deepEqual(one.graph.links, JSON.parse(graph).links)
  assert.equal(one.graph.resources[0]!.locator, `file://binding-host${join(first, "src", "engine.ts")}`)
  assert.equal(one.graph.resources[1]!.locator, `git://github.com/example/remote@${commit}:README.md`)
  assert.equal(one.bindingReceipt.sourceDigest, two.bindingReceipt.sourceDigest)
  assert.notEqual(one.bindingReceipt.resultDigest, two.bindingReceipt.resultDigest)
  assert.notEqual(one.bindingReceipt.digest, two.bindingReceipt.digest)
})

test("binding requires explicit, known, unique graph resource selections", async (t) => {
  const root = await workspace(t), document = bindings(), options = { workspaces: { checkout: root }, hostname: "binding-host" }
  await assert.rejects(bindResourceGraph(graph, document, [{ resource: "engine" }], options), /ambiguous/)
  await assert.rejects(bindResourceGraph(graph, document, [{ resource: "orphan", representation: "orphan-git" }], options), /absent from graph/)
  await assert.rejects(bindResourceGraph(graph, document, [
    { resource: "engine", representation: "engine-local" }, { resource: "engine", representation: "engine-git" },
  ], options), /duplicate selected resource/)
  await assert.rejects(bindResourceGraph(graph, document, {} as never, options), /resource selections/)
  const getter = { get 0() { throw new Error("selection getter must not run") }, length: 1 }
  await assert.rejects(bindResourceGraph(graph, document, getter as never, options), /enumerable JSON values/)
  await assert.rejects(bindResourceGraph({} as never, document, [], options), /source must be a string/)
})

test("binding snapshots mutable callers before workspace resolution", async (t) => {
  const root = await workspace(t)
  const mutableBindings = structuredClone(bindings()) as unknown as { resources: Array<{ representations: Array<{ locator?: string }> }> }
  const mutableSelections = [{ resource: "engine", representation: "engine-local" }]
  const pending = bindResourceGraph(graph, mutableBindings as never, mutableSelections, { workspaces: { checkout: root }, hostname: "binding-host" })
  mutableBindings.resources[0]!.representations[0]!.locator = "https://attacker.example/changed"
  mutableSelections[0]!.resource = "remote"
  const result = await pending
  assert.equal(result.graph.resources[0]!.locator, `file://binding-host${join(root, "src", "engine.ts")}`)
  assert.equal(result.graph.resources[1]!.locator, "https://old.example/remote")
})
