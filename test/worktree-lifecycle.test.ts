import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { inspectResourceBinding } from "../src/binding-inspection.js"
import { parseResourceBindings, resolveResourceRepresentation } from "../src/resource-bindings.js"
import { temporary } from "./fixtures.js"

const gitEnvironment = (): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(environment)) if (key.startsWith("GIT_")) delete environment[key]
  return { ...environment, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" }
}
const git = (cwd: string, ...args: string[]) => execFileSync("/usr/bin/git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
  encoding: "utf8", env: gitEnvironment(), stdio: ["ignore", "pipe", "pipe"],
}).trim()
const sha256 = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`

const bindings = (representations: readonly { readonly id: string; readonly workspace: string; readonly path: string; readonly digest?: string }[]) => parseResourceBindings({
  schema: "usl-resource-bindings/v1",
  resources: [{ id: "repo:logical", representations: representations.map(representation => ({
    id: representation.id, relation: "working-copy", kind: "workspace", workspace: representation.workspace,
    path: representation.path, ...(representation.digest === undefined ? {} : { digest: representation.digest }),
  })) }],
})

const fixture = async (t: TestContext) => {
  const root = await temporary(t), main = join(root, "main"), worker = join(root, "worker")
  await mkdir(main)
  await writeFile(join(main, "note.txt"), "base\n")
  await writeFile(join(main, "visible.txt"), "visible\n")
  await writeFile(join(main, "hidden.txt"), "hidden\n")
  git(main, "init", "-q")
  git(main, "add", ".")
  git(main, "-c", "user.name=USL Test", "-c", "user.email=usl-test@example.invalid", "commit", "-qm", "base")
  git(main, "worktree", "add", "-q", "-b", "worker", worker)
  return { root, main, worker }
}

test("inspects explicit main and linked-worktree representations as one logical resource", async t => {
  const { main, worker } = await fixture(t)
  await writeFile(join(worker, "note.txt"), "worker\n")
  git(worker, "add", "note.txt"); git(worker, "-c", "user.name=USL Test", "-c", "user.email=usl-test@example.invalid", "commit", "-qm", "worker")
  const document = bindings([{ id: "main", workspace: "main", path: "note.txt" }, { id: "worker", workspace: "worker", path: "note.txt" }])
  const options = { workspaces: { main, worker }, hostname: "worktree-test" }
  const primary = await inspectResourceBinding(document, { resource: "repo:logical", representation: "main" }, options)
  const linked = await inspectResourceBinding(document, { resource: "repo:logical", representation: "worker" }, options)
  assert.equal(primary.resource, linked.resource); assert.notEqual(primary.representation, linked.representation)
  assert.notEqual(primary.locator, linked.locator); assert.notEqual(primary.content.digest, linked.content.digest)
  assert.ok(primary.git?.state === "REPOSITORY" && linked.git?.state === "REPOSITORY")
  assert.notEqual(primary.git.head, linked.git.head); assert.equal(linked.git.commonGitDir, join(main, ".git"))
})

test("observes dirty working tree and index state independently per worktree", async t => {
  const { main, worker } = await fixture(t)
  await writeFile(join(main, "note.txt"), "unstaged main\n")
  const document = bindings([{ id: "main", workspace: "main", path: "note.txt" }, { id: "worker", workspace: "worker", path: "note.txt" }])
  const options = { workspaces: { main, worker } }
  const primary = await inspectResourceBinding(document, { resource: "repo:logical", representation: "main" }, options)
  const linked = await inspectResourceBinding(document, { resource: "repo:logical", representation: "worker" }, options)
  assert.ok(primary.git?.state === "REPOSITORY" && linked.git?.state === "REPOSITORY")
  assert.equal(primary.git.dirty, true); assert.equal(linked.git.dirty, false)
  assert.equal(git(main, "diff", "--name-only"), "note.txt")
  git(main, "restore", "note.txt")
  await writeFile(join(worker, "indexed.txt"), "indexed worker\n"); git(worker, "add", "indexed.txt")
  const restoredMain = await inspectResourceBinding(document, { resource: "repo:logical", representation: "main" }, options)
  const stagedWorker = await inspectResourceBinding(document, { resource: "repo:logical", representation: "worker" }, options)
  assert.ok(restoredMain.git?.state === "REPOSITORY" && stagedWorker.git?.state === "REPOSITORY")
  assert.equal(restoredMain.git.dirty, false); assert.equal(stagedWorker.git.dirty, true)
  assert.equal(git(worker, "diff", "--cached", "--name-only"), "indexed.txt")
})

test("observes detached HEAD at the same commit without merging distinct representations", async t => {
  const { main, worker } = await fixture(t)
  git(worker, "checkout", "-q", "--detach", "HEAD")
  const document = bindings([{ id: "main", workspace: "main", path: "note.txt" }, { id: "worker", workspace: "worker", path: "note.txt" }])
  const options = { workspaces: { main, worker } }
  const primary = await inspectResourceBinding(document, { resource: "repo:logical", representation: "main" }, options)
  const linked = await inspectResourceBinding(document, { resource: "repo:logical", representation: "worker" }, options)
  assert.ok(primary.git?.state === "REPOSITORY" && linked.git?.state === "REPOSITORY")
  assert.equal(primary.git.head, linked.git.head); assert.notEqual(primary.representation, linked.representation)
  assert.notEqual(primary.locator, linked.locator)
})

test("git worktree move plus host remapping preserves selected resource and representation IDs", async t => {
  const { root, main, worker } = await fixture(t), moved = join(root, "worker-moved")
  const document = bindings([{ id: "worker", workspace: "worker", path: "note.txt" }])
  const before = await resolveResourceRepresentation(document, { resource: "repo:logical", representation: "worker" }, { workspaces: { worker }, hostname: "worktree-test" })
  git(main, "worktree", "move", worker, moved)
  const after = await resolveResourceRepresentation(document, { resource: "repo:logical", representation: "worker" }, { workspaces: { worker: moved }, hostname: "worktree-test" })
  const report = await inspectResourceBinding(document, { resource: "repo:logical", representation: "worker" }, { workspaces: { worker: moved } })
  assert.equal(before.resource, after.resource); assert.equal(before.representation, after.representation)
  assert.equal(before.relativePath, after.relativePath); assert.notEqual(before.path, after.path)
  assert.ok(report.git?.state === "REPOSITORY"); assert.equal(report.git.commonGitDir, join(main, ".git"))
})

test("manual main and linked-worktree moves report NO_REPOSITORY before repair and recover after repair", async t => {
  const { root, main, worker } = await fixture(t), movedMain = join(root, "main-moved"), movedWorker = join(root, "worker-moved")
  const document = bindings([{ id: "worker", workspace: "worker", path: "note.txt" }])
  await rename(main, movedMain); await rename(worker, movedWorker)
  const before = await inspectResourceBinding(document, { resource: "repo:logical", representation: "worker" }, { workspaces: { worker: movedWorker } })
  assert.ok(before.git?.state === "NO_REPOSITORY")
  git(movedMain, "worktree", "repair", movedWorker)
  const report = await inspectResourceBinding(document, { resource: "repo:logical", representation: "worker" }, { workspaces: { worker: movedWorker } })
  assert.ok(report.git?.state === "REPOSITORY"); assert.equal(report.git.root, movedWorker); assert.equal(report.git.commonGitDir, join(movedMain, ".git"))
})

test("observes limitation: a copied linked checkout retains Git metadata pointing at the original common directory", async t => {
  const { root, main, worker } = await fixture(t), copied = join(root, "copied-worker")
  await cp(worker, copied, { recursive: true, dereference: false })
  const document = bindings([{ id: "copy", workspace: "copy", path: "note.txt" }])
  const report = await inspectResourceBinding(document, { resource: "repo:logical", representation: "copy" }, { workspaces: { copy: copied } })
  assert.ok(report.git?.state === "REPOSITORY")
  assert.equal(report.git.root, copied); assert.equal(report.git.worktree, copied); assert.equal(report.git.commonGitDir, join(main, ".git"))
  await rename(main, join(root, "moved-main"))
  const afterMainMove = await inspectResourceBinding(document, { resource: "repo:logical", representation: "copy" }, { workspaces: { copy: copied } })
  assert.ok(afterMainMove.git?.state === "NO_REPOSITORY")
})

test("observes limitation: removing a selected worktree never falls back to a sibling and a recreated path has no cached Git identity", async t => {
  const { main, worker } = await fixture(t)
  const document = bindings([{ id: "main", workspace: "main", path: "note.txt" }, { id: "worker", workspace: "worker", path: "note.txt" }])
  await rm(worker, { recursive: true, force: true })
  await assert.rejects(resolveResourceRepresentation(document, { resource: "repo:logical", representation: "worker" }, { workspaces: { main, worker } }), /ENOENT/)
  const sibling = await resolveResourceRepresentation(document, { resource: "repo:logical", representation: "main" }, { workspaces: { main, worker } })
  assert.equal(sibling.representation, "main")
  git(main, "worktree", "prune")
  await mkdir(worker); await writeFile(join(worker, "note.txt"), "ordinary replacement\n")
  const report = await inspectResourceBinding(document, { resource: "repo:logical", representation: "worker" }, { workspaces: { worker } })
  assert.ok(report.git?.state === "NO_REPOSITORY")
})

test("observes limitation: sparse checkout omission has no representation fallback", async t => {
  const { main, worker } = await fixture(t)
  git(worker, "sparse-checkout", "init", "--no-cone"); git(worker, "sparse-checkout", "set", "--no-cone", "/visible.txt")
  const document = bindings([{ id: "main-hidden", workspace: "main", path: "hidden.txt" }, { id: "worker-hidden", workspace: "worker", path: "hidden.txt" }])
  await assert.rejects(resolveResourceRepresentation(document, { resource: "repo:logical", representation: "worker-hidden" }, { workspaces: { main, worker } }), /ENOENT/)
  const primary = await resolveResourceRepresentation(document, { resource: "repo:logical", representation: "main-hidden" }, { workspaces: { main, worker } })
  assert.equal(primary.representation, "main-hidden")
})

test("rejects a symlink from one worktree into another registered worktree", async t => {
  const { main, worker } = await fixture(t)
  await symlink(join(main, "note.txt"), join(worker, "main-note.txt"))
  const document = bindings([{ id: "worker", workspace: "worker", path: "main-note.txt" }])
  await assert.rejects(resolveResourceRepresentation(document, { resource: "repo:logical", representation: "worker" }, { workspaces: { worker } }), /outside its root/)
})

test("observes limitation: a wrong workspace alias can match bytes while its Git head differs", async t => {
  const { main, worker } = await fixture(t)
  await writeFile(join(main, "main-only.txt"), "main commit\n"); git(main, "add", "main-only.txt"); git(main, "-c", "user.name=USL Test", "-c", "user.email=usl-test@example.invalid", "commit", "-qm", "main only")
  const document = bindings([{ id: "expected-main", workspace: "worker", path: "note.txt", digest: sha256("base\n") }])
  const report = await inspectResourceBinding(document, { resource: "repo:logical", representation: "expected-main" }, { workspaces: { worker } })
  assert.ok(report.git?.state === "REPOSITORY"); assert.notEqual(report.git.head, git(main, "rev-parse", "HEAD"))
  assert.equal(report.content.pinStatus, "MATCH")
  await writeFile(join(worker, "note.txt"), "wrong bytes\n")
  const mismatch = await inspectResourceBinding(document, { resource: "repo:logical", representation: "expected-main" }, { workspaces: { worker } })
  assert.equal(mismatch.content.pinStatus, "MISMATCH")
})
