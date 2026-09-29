import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import type { ResourceGraph } from "../src/integrations/resource-graph.js"
import type { ResourceGraphBindingReceipt } from "../src/integrations/resource-bindings.js"
import type { AdapterResult } from "../src/adapters.js"
import type { FullCompactContext } from "../src/language/compact.js"
import { temporary } from "./fixtures.js"

const root = fileURLToPath(new URL("..", import.meta.url))
const graphFile = join(root, "examples/fixtures/addon-binding.json")
const profileFile = join(root, "examples/fixtures/addon-binding.profile.json")
const cli = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
  execFile(process.execPath, ["--import", "tsx", "src/cli.ts", ...args],
    { cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: typeof error?.code === "number" ? error.code : error ? 1 : 0, stdout, stderr })
    })
})
const json = async <T>(args: string[]): Promise<T> => {
  const result = await cli(args)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stderr, "")
  return JSON.parse(result.stdout) as T
}
const adapt = (file: string) => ["adapt", "--format", "resource-graph", "--graph", file, "--namespace", "addon.cli"]
const fixture = async () => JSON.parse(await readFile(graphFile, "utf8")) as ResourceGraph

test("addon fixture is optional and compact CLI preserves its named roles, metadata and provenance", async () => {
  const base = await json<AdapterResult<{ valid: boolean }>>([...adapt(graphFile), "--operation", "check"])
  const selected = await json<AdapterResult<{ valid: boolean }>>([...adapt(graphFile), "--profile", profileFile, "--operation", "check"])
  assert.equal(base.result.valid, true)
  assert.equal(selected.result.valid, true)
  assert.deepEqual(selected.identities, base.identities)
  assert.deepEqual(selected.source, base.source)
  // The profile's version/digest is part of interpretation, while native IDs stay stable.
  assert.notEqual(selected.receipt.planDigest, base.receipt.planDigest)

  const delivered = await json<AdapterResult<{ context: FullCompactContext }>>([
    ...adapt(graphFile), "--profile", profileFile, "--operation", "context",
    "--focus", "addon:target", "--target", "addon:rule", "--compact",
  ])
  const { context } = delivered.result
  assert.equal(context.mode, "FULL")
  assert.equal(context.target?.status, "FOUND")
  const graph = await fixture()
  const binding = context.links.find(link => link.name === delivered.identities.links["addon:binding_link"])!
  assert.deepEqual(binding.participants, graph.links[0]!.participants
    .map(p => ({ role: p.role, resource: delivered.identities.resources[p.resource] }))
    .sort((a, b) => a.role.localeCompare(b.role)))
  const description = JSON.parse(context.meanings.find(meaning => meaning.name === binding.meaning)!.description)
  assert.deepEqual(description.provenance, graph.provenance)
  assert.equal(description.domainProfile.id, "urn:usl:addon:binding-profile")
  assert.equal(description.domainProfile.checked, true)
  assert.deepEqual(description.resources.find((r: { id: string }) => r.id === "addon:configuration").metadata,
    graph.resources.find(r => r.id === "addon:configuration")!.metadata)
  assert.deepEqual(description.resources.find((r: { id: string }) => r.id === "addon:rule").metadata,
    { ruleId: "example-score-hint", ruleVersion: "1" })
  assert.equal(context.interpretation.execution, "NOT_PLANNED")
  assert.equal(context.interpretation.semanticTruth, "NOT_EVALUATED")
  assert.equal(context.interpretation.reachability, "NOT_OBSERVED")
})

test("addon version metadata and role types are enforced only by an explicitly selected profile", async t => {
  const dir = await temporary(t), file = join(dir, "graph.json")
  for (const defect of ["missing-version", "wrong-role-type"] as const) {
    const graph = await fixture(), rule = graph.resources.find(r => r.id === "addon:rule")!
    if (defect === "missing-version") rule.metadata = { ruleId: "example-score-hint" }
    else rule.types = ["urn:example:UnknownRule"]
    await writeFile(file, JSON.stringify(graph))
    assert.equal((await json<AdapterResult<{ valid: boolean }>>([...adapt(file), "--operation", "check"])).result.valid, true)
    const rejected = await cli([...adapt(file), "--profile", profileFile, "--operation", "check"])
    assert.equal(rejected.code, 1, rejected.stderr)
    assert.equal(rejected.stdout, "")
    assert.match(rejected.stderr, defect === "missing-version" ? /MISSING_METADATA/ : /ROLE_TYPE/)
  }
})

test("CLI rebinds the addon target after relocation and explicit Git selection without changing its rule", async t => {
  const dir = await temporary(t), hostFile = join(dir, "host.json"), selectionsFile = join(dir, "selections.json")
  const localRoot = join(dir, "checkout"), movedRoot = join(dir, "moved")
  await mkdir(localRoot)
  await writeFile(join(localRoot, "target.txt"), "local addon target\n")
  const remote = "git://github.com/example/project@0123456789abcdef0123456789abcdef01234567:target.txt"
  await writeFile(join(dir, "bindings.json"), JSON.stringify({ schema: "usl-resource-bindings/v1", resources: [{
    id: "addon:target", representations: [
      { id: "target-local", relation: "working-copy", kind: "workspace", workspace: "project", path: "target.txt" },
      { id: "target-git", relation: "snapshot", kind: "locator", locator: remote },
    ],
  }] }))
  const host = (workspace: string) => writeFile(hostFile, JSON.stringify({
    schema: "usl-cli-host/v1", bindings: "bindings.json", workspaces: { project: workspace }, maxSourceBytes: 1024 * 1024, actions: [],
  }))
  await host("checkout")
  const ambiguous = await cli(["locate", "--config", hostFile, "--resource", "addon:target"])
  assert.notEqual(ambiguous.code, 0)
  assert.match(ambiguous.stderr + ambiguous.stdout, /ambiguous/)

  type Bound = { graph: ResourceGraph; bindingReceipt: ResourceGraphBindingReceipt }
  const bind = async (representation: string) => {
    await writeFile(selectionsFile, JSON.stringify([{ resource: "addon:target", representation }]))
    return json<Bound>(["bind-graph", "--config", hostFile, "--graph", graphFile, "--selections", selectionsFile])
  }
  const first = await bind("target-local")
  await rename(localRoot, movedRoot)
  await host("moved")
  const moved = await bind("target-local"), git = await bind("target-git"), original = await fixture()
  for (const result of [first, moved, git]) {
    const target = result.graph.resources.find(r => r.id === "addon:target")!
    assert.deepEqual({ ...result.graph, resources: result.graph.resources.map(resource =>
      resource.id === "addon:target" ? { ...resource, locator: original.resources.find(r => r.id === resource.id)!.locator } : resource) }, original)
    assert.equal(result.bindingReceipt.selections[0]!.resource, target.id)
  }
  const locator = (result: Bound) => result.graph.resources.find(r => r.id === "addon:target")!.locator
  assert.notEqual(locator(first), locator(moved))
  assert.equal(locator(git), remote)
  assert.equal(first.bindingReceipt.sourceDigest, moved.bindingReceipt.sourceDigest)
  assert.notEqual(first.bindingReceipt.resultDigest, moved.bindingReceipt.resultDigest)
  // Rebound output remains an ordinary graph accepted by the same optional profile.
  const reboundFile = join(dir, "rebound.json")
  await writeFile(reboundFile, JSON.stringify(moved.graph))
  assert.equal((await json<AdapterResult<{ valid: boolean }>>([
    ...adapt(reboundFile), "--profile", profileFile, "--operation", "check",
  ])).result.valid, true)
})
