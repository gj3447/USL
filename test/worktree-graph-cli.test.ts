import assert from "node:assert/strict"
import { execFile, execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { test, type TestContext } from "node:test"
import { bindResourceGraph } from "../src/integrations/resource-bindings.js"
import { parseResourceBindings } from "../src/resource-bindings.js"
import { inspectResourceBinding } from "../src/binding-inspection.js"
import { digestSource } from "../src/language/digest.js"
import { temporary } from "./fixtures.js"

const execute = promisify(execFile)
const git = (cwd: string, ...args: string[]) => execFileSync("/usr/bin/git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
  encoding: "utf8", env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"],
}).trim()
const fixture = async (t: TestContext) => {
  const base = await temporary(t), main = join(base, "main"), worker = join(base, "worker")
  await mkdir(join(main, "src"), { recursive: true }); await writeFile(join(main, "src/a.txt"), "main\n")
  git(main, "init", "-q", "-b", "main"); git(main, "add", "."); git(main, "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "base")
  git(main, "worktree", "add", "-q", "-b", "worker", worker)
  await writeFile(join(worker, "src/a.txt"), "worker\n"); git(worker, "add", "."); git(worker, "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "worker")
  const bindings = parseResourceBindings({ schema: "usl-resource-bindings/v1", resources: [{ id: "resource:a", representations: [
    { id: "a-main", relation: "working-copy", kind: "workspace", workspace: "main", path: "src/a.txt" },
    { id: "a-worker", relation: "working-copy", kind: "workspace", workspace: "worker", path: "src/a.txt" },
  ] }] })
  return { base, main, worker, bindings, workspaces: { main, worker } }
}

test("worktree graph rebinding preserves complete logical links while selecting divergent content", async t => {
  const f = await fixture(t)
  const graph = { schema: "usl-resource-graph/v1", resources: [
    { id: "resource:a", types: ["urn:test:Code"], locator: "https://example.test/a", metadata: { owner: "fixture" } },
    { id: "resource:requirement", types: ["urn:test:Requirement"], locator: "https://example.test/r" },
  ], meanings: [{ id: "meaning:implements", description: "Declared implementation; not proof" }], links: [{ id: "link:implements", meaning: "meaning:implements", participants: [
    { role: "implementation", resource: "resource:a" }, { role: "requirement", resource: "resource:requirement" },
  ], metadata: { status: "DECLARED" } }] }
  const results = await Promise.all(["a-main", "a-worker"].map(representation => bindResourceGraph(JSON.stringify(graph), f.bindings, [{ resource: "resource:a", representation }], { workspaces: f.workspaces, hostname: "fixture" })))
  for (const result of results) { assert.deepEqual(result.graph.links, graph.links); assert.deepEqual(result.graph.meanings, graph.meanings); assert.deepEqual(result.graph.resources.map(r => r.id), graph.resources.map(r => r.id)); assert.deepEqual(result.graph.resources[0]!.metadata, graph.resources[0]!.metadata) }
  assert.notEqual(results[0]!.graph.resources[0]!.locator, results[1]!.graph.resources[0]!.locator)
  assert.notEqual(results[0]!.bindingReceipt.resultDigest, results[1]!.bindingReceipt.resultDigest)
  await assert.rejects(bindResourceGraph(JSON.stringify(graph), f.bindings, [{ resource: "resource:a" }], { workspaces: f.workspaces }), /ambiguous/)
})

test("CLI inspection selects the linked worktree through host-relative workspace configuration", async t => {
  const f = await fixture(t), host = join(f.base, "host.json")
  await writeFile(join(f.base, "bindings.json"), JSON.stringify(f.bindings))
  await writeFile(host, JSON.stringify({ schema: "usl-cli-host/v1", bindings: "bindings.json", workspaces: { main: "main", worker: "worker" }, maxSourceBytes: 65536, actions: [] }))
  const { stdout } = await execute(process.execPath, ["--import", "tsx", join(process.cwd(), "src/cli.ts"), "inspect-binding", "--config", host, "--resource", "resource:a", "--representation", "a-worker"], { maxBuffer: 1024 * 1024 })
  const report = JSON.parse(stdout)
  assert.equal(report.resource, "resource:a"); assert.equal(report.representation, "a-worker")
  assert.equal(report.git.root, f.worker); assert.equal(report.git.head, git(f.worker, "rev-parse", "HEAD"))
  assert.notEqual(report.git.head, git(f.main, "rev-parse", "HEAD")); assert.equal(report.content.digest, digestSource("worker\n"))
})

test("a subdirectory workspace observes its enclosing Git root without asserting checkout identity", async t => {
  const f = await fixture(t), root = join(f.worker, "src")
  const bindings = parseResourceBindings({ schema: "usl-resource-bindings/v1", resources: [{ id: "a", representations: [{ id: "local", relation: "working-copy", kind: "workspace", workspace: "subdir", path: "a.txt" }] }] })
  const report = await inspectResourceBinding(bindings, { resource: "a", representation: "local" }, { workspaces: { subdir: root } })
  assert.ok(report.git?.state === "REPOSITORY"); assert.equal(report.git.root, f.worker); assert.notEqual(report.git.root, root)
  assert.equal(report.git.identity, "OWNER_ASSERTED_UNVERIFIED_REMOTE"); assert.equal(report.consistency, "BEST_EFFORT_OBSERVATION")
})

test("a worktree directory digest declaration remains unchecked rather than proving a tree snapshot", async t => {
  const f = await fixture(t)
  const bindings = parseResourceBindings({ schema: "usl-resource-bindings/v1", resources: [{ id: "tree", representations: [{ id: "local", relation: "snapshot", kind: "workspace", workspace: "worker", path: ".", digest: digestSource("not-a-tree-snapshot") }] }] })
  const report = await inspectResourceBinding(bindings, { resource: "tree", representation: "local" }, { workspaces: f.workspaces })
  assert.equal(report.content.kind, "directory"); assert.equal(report.content.pinStatus, "NOT_CHECKED"); assert.equal(report.content.digest, null)
  assert.equal(report.relation, "snapshot"); assert.equal(report.consistency, "BEST_EFFORT_OBSERVATION")
})
