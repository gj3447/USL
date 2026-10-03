import assert from "node:assert/strict"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { join } from "node:path"
import { promisify } from "node:util"
import { test } from "node:test"
import { contractDigest } from "../src/contract-core.js"
import { executeCliAction, planCliAction, type CliHostConfig } from "../src/cli-host.js"
import { digestSource } from "../src/language/digest.js"
import { temporary } from "./fixtures.js"

const run = promisify(execFile)

type WorktreeFixture = Awaited<ReturnType<typeof setup>>

/** Uses only a disposable local Git repository and the current Node runtime. */
const setup = async (t: Parameters<typeof temporary>[0]) => {
  const base = await temporary(t)
  const main = join(base, "main"), linked = join(base, "linked")
  const gitEnv = { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" }
  const git = async (cwd: string, ...args: string[]) => {
    const result = await run("/usr/bin/git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { env: gitEnv })
    return result.stdout.trim()
  }
  await mkdir(main)
  await git(main, "init", "-q")
  await git(main, "config", "user.name", "USL Worktree Test")
  await git(main, "config", "user.email", "usl-worktree@example.invalid")

  const runner = "import { appendFileSync } from 'node:fs'; appendFileSync('runs', 'ran\\n'); console.log(JSON.stringify({ ok: true }));"
  const graph = await readFile("examples/fixtures/cli/graphspec.json", "utf8")
  await writeFile(join(main, "run.mjs"), runner)
  await writeFile(join(main, "graph.json"), graph)
  await git(main, "add", "run.mjs", "graph.json")
  await git(main, "commit", "-qm", "fixture")
  await git(main, "worktree", "add", "-q", "-b", "linked", linked)

  await writeFile(join(base, "bindings.json"), JSON.stringify({ schema: "usl-resource-bindings/v1", resources:
    [["graph", "graph.json"], ["runner", "run.mjs"], ["cwd", "."]].map(([id, path]) => ({ id,
      representations: [{ id: `${id}-local`, relation: "working-copy", kind: "workspace", workspace: "project", path }] })) }))
  const sourceDigest = digestSource("operation descriptor")
  const descriptor: CliHostConfig["actions"][number]["descriptor"] = {
    schema: "usl-capability/v1", id: "run", version: "1", connection: "fixture", nativeOperation: "run", sourceDigest,
    kind: "ACTION", effect: "WRITE", meanings: ["urn:test:worktree-run"], requiredScopes: ["run"],
    input: { types: ["urn:test:Input"], schema: true },
    output: { types: ["urn:test:Output"], schema: { type: "object", required: ["ok"], properties: { ok: { const: true } }, additionalProperties: false } },
    mapping: { completeness: "COMPLETE", losses: [], unsupported: [] },
  }
  const config: CliHostConfig = { schema: "usl-cli-host/v1", bindings: "bindings.json", workspaces: { project: main }, maxSourceBytes: 65536,
    operations: { namespace: "worktree-fixture", directory: "operations" },
    actions: [{ id: "run", descriptor, policy: { connection: "fixture", capabilityId: "run", descriptorDigest: contractDigest(descriptor), sourceDigest,
      allowedEffects: ["WRITE"], allowedScopes: ["run"], allowLossy: false, maxInputBytes: 4096, maxOutputBytes: 4096, timeoutMs: 3000 },
      graph: { source: { resource: "graph", representation: "graph-local" }, sourceDigest: digestSource(graph),
        graphId: "usl.cli.example", graphspecDigest: JSON.parse(graph).identity.graphspec_sha256, node: "usl_check", scope: "ENTRY_NODE_ONLY" },
      cwd: { resource: "cwd", representation: "cwd-local" }, command: { executable: "node", args: [{ resource: "runner", representation: "runner-local" }], envAllowlist: [] },
      pins: [{ source: { resource: "runner", representation: "runner-local" }, digest: digestSource(runner) }] }] }
  const configFile = join(base, "host.json")
  const writeConfig = async () => writeFile(configFile, JSON.stringify(config))
  await writeConfig()
  const request = { descriptorDigest: contractDigest(descriptor), sourceDigest, input: { types: ["urn:test:Input"], value: { target: "one" } } }
  const plan = await planCliAction(configFile, "run", request)
  assert.equal(plan.status, "READY")
  return { base, main, linked, git, config, configFile, request, plan, writeConfig }
}

const selectWorkspace = async (f: WorktreeFixture, workspace: string, operationDirectory = "operations") => {
  f.config.workspaces.project = workspace
  f.config.operations = { namespace: "worktree-fixture", directory: operationDirectory }
  await f.writeConfig()
  const plan = await planCliAction(f.configFile, "run", f.request)
  assert.equal(plan.status, "READY")
  return plan
}

const assertNoMarker = async (directory: string) => assert.rejects(access(join(directory, "runs")))

test("remapping a real linked worktree rejects a stale main-worktree plan before an attempt", async t => {
  const f = await setup(t)
  const linkedPlan = await selectWorkspace(f, f.linked)
  assert.notEqual(linkedPlan.planDigest, f.plan.planDigest)
  const result = await executeCliAction(f.configFile, "run", f.request, f.plan.planDigest, join(f.base, "stale"), { operationKey: "move" })
  assert.equal(result.status, "REJECTED"); assert.equal(result.reason, "PLAN_CHANGED"); assert.equal(result.attempts, 0)
  await assertNoMarker(f.main); await assertNoMarker(f.linked)
})

test("a shared operation store prevents re-execution after remapping between real worktrees", async t => {
  const f = await setup(t)
  const first = await executeCliAction(f.configFile, "run", f.request, f.plan.planDigest, join(f.base, "main-attempt"), { operationKey: "logical-run" })
  assert.equal(first.status, "SUCCEEDED")
  const linkedPlan = await selectWorkspace(f, f.linked)
  if (f.plan.status !== "READY" || linkedPlan.status !== "READY") throw new Error("ready plans required")
  assert.equal(linkedPlan.operation?.semanticDigest, f.plan.operation?.semanticDigest)
  const second = await executeCliAction(f.configFile, "run", f.request, linkedPlan.planDigest, join(f.base, "linked-attempt"), { operationKey: "logical-run" })
  assert.equal(second.status, "REJECTED"); assert.equal(second.reason, "OPERATION_ALREADY_RESERVED"); assert.equal(second.attempts, 0)
  assert.equal(await readFile(join(f.main, "runs"), "utf8"), "ran\n")
  await assertNoMarker(f.linked)
})

test("separate operation stores are an explicit cross-worktree duplicate-execution limitation", async t => {
  const f = await setup(t)
  const first = await executeCliAction(f.configFile, "run", f.request, f.plan.planDigest, join(f.base, "main-attempt"), { operationKey: "logical-run" })
  assert.equal(first.status, "SUCCEEDED")
  const linkedPlan = await selectWorkspace(f, f.linked, "operations-linked")
  const second = await executeCliAction(f.configFile, "run", f.request, linkedPlan.planDigest, join(f.base, "linked-attempt"), { operationKey: "logical-run" })
  assert.equal(second.status, "SUCCEEDED")
  assert.equal(await readFile(join(f.main, "runs"), "utf8"), "ran\n")
  assert.equal(await readFile(join(f.linked, "runs"), "utf8"), "ran\n")
})

test("a Git branch HEAD change is not attested when the declared pinned files are unchanged", async t => {
  const f = await setup(t)
  const before = await selectWorkspace(f, f.linked)
  const headBefore = await f.git(f.linked, "rev-parse", "HEAD")
  await writeFile(join(f.linked, "unattested.txt"), "new commit, unchanged declared files\n")
  await f.git(f.linked, "add", "unattested.txt")
  await f.git(f.linked, "commit", "-qm", "advance linked head")
  const headAfter = await f.git(f.linked, "rev-parse", "HEAD")
  const after = await planCliAction(f.configFile, "run", f.request)
  assert.equal(after.status, "READY")
  assert.notEqual(headAfter, headBefore)
  assert.equal(after.planDigest, before.planDigest)
})

test("a changed pinned runner in a sibling worktree blocks before the external effect", async t => {
  const f = await setup(t)
  const plan = await selectWorkspace(f, f.linked)
  await writeFile(join(f.linked, "run.mjs"), "console.log(JSON.stringify({ ok: true }));\n")
  const result = await executeCliAction(f.configFile, "run", f.request, plan.planDigest, join(f.base, "changed-runner"), { operationKey: "changed-runner" })
  assert.equal(result.status, "REJECTED"); assert.equal(result.reason, "PREFLIGHT_REJECTED"); assert.equal(result.attempts, 0)
  await assertNoMarker(f.linked)
})
