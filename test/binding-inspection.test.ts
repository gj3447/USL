import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { inspectResourceBinding } from "../src/binding-inspection.js"
import { parseResourceBindings } from "../src/resource-bindings.js"
import { temporary } from "./fixtures.js"

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" }).trim()
const localDocument = (path = "a.txt") => parseResourceBindings({ schema: "usl-resource-bindings/v1", resources: [{ id: "node:a", representations: [
  { id: "local", relation: "working-copy", kind: "workspace", workspace: "r", path },
  { id: "github", relation: "mirror", kind: "locator", locator: "https://github.com/owner/repo/blob/main/a.txt" },
] }] })

test("explicit workspace inspection hashes files and emits a redacted Git candidate", async t => {
  const root = await temporary(t), repo = join(root, "repo"); await mkdir(repo); await writeFile(join(repo, "a.txt"), "hello")
  git(repo, "init", "-q"); git(repo, "add", "a.txt"); git(repo, "-c", "user.name=x", "-c", "user.email=x@y", "commit", "-qm", "x")
  git(repo, "remote", "add", "origin", "ssh://alice:secret@gitHub.com:2222/owner/repo.git?access_token=secret#readme")
  await assert.rejects(inspectResourceBinding(localDocument(), { resource: "node:a" }, { workspaces: { r: repo } }), /explicit representation/)
  const report = await inspectResourceBinding(localDocument(), { resource: "node:a", representation: "local" }, { workspaces: { r: repo }, maxBytes: 8 })
  assert.equal(report.content.digest, "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
  assert.ok(report.git !== null && report.git.state === "REPOSITORY")
  assert.deepEqual(report.git.origin, {
    transport: "ssh", host: "github.com", port: "2222", path: "owner/repo",
    queryDigest: "sha256:3ea9fc22b0d89c3e98a4fd6b6159ebe51302df043bcfa4e5509f6ef189b3ef48",
    fragmentDigest: "sha256:711a6108ba2ce6ca93dd47d6817f2361db10d8ab6eec89460b2dfc2c325efabe",
    credentialsRedacted: true,
  })
  assert.equal(JSON.stringify(report).includes("secret"), false)
  assert.equal(JSON.stringify(report).includes("alice"), false)
  assert.equal(report.git.state, "REPOSITORY")
  const remote = await inspectResourceBinding(localDocument(), { resource: "node:a", representation: "github" }, { workspaces: {} }); assert.equal(remote.content.kind, "locator"); assert.equal(remote.git, null)
})

test("worktree facts survive a moved registered root and report a common Git directory", async t => {
  const root = await temporary(t), repo = join(root, "repo"), moved = join(root, "moved"); await mkdir(repo); await writeFile(join(repo, "a.txt"), "hello")
  git(repo, "init", "-q"); git(repo, "add", "a.txt"); git(repo, "-c", "user.name=x", "-c", "user.email=x@y", "commit", "-qm", "x")
  await rename(repo, moved); await writeFile(join(moved, "a.txt"), "changed")
  const report = await inspectResourceBinding(localDocument(), { resource: "node:a", representation: "local" }, { workspaces: { r: moved } })
  assert.ok(report.git !== null && report.git.state === "REPOSITORY")
  assert.equal(report.git.state, "REPOSITORY"); assert.equal(report.git.root, moved); assert.equal(report.git.worktree, moved); assert.equal(report.git.dirty, true)
  assert.match(report.git.commonGitDir, /\.git$/)
})

test("a linked worktree uses the main checkout common Git directory", async t => {
  const root = await temporary(t), main = join(root, "main"), worker = join(root, "worker"); await mkdir(main); await writeFile(join(main, "a.txt"), "hello")
  git(main, "init", "-q"); git(main, "add", "a.txt"); git(main, "-c", "user.name=x", "-c", "user.email=x@y", "commit", "-qm", "x")
  git(main, "worktree", "add", "-q", "-b", "worker", worker)
  const report = await inspectResourceBinding(localDocument(), { resource: "node:a", representation: "local" }, { workspaces: { r: worker } })
  assert.ok(report.git !== null && report.git.state === "REPOSITORY")
  assert.equal(report.git.root, worker); assert.equal(report.git.worktree, worker); assert.equal(report.git.commonGitDir, join(main, ".git"))
})

test("ordinary directories and unborn repositories are distinguished without origin", async t => {
  const root = await temporary(t), plain = join(root, "plain"), unborn = join(root, "unborn"); await mkdir(plain); await mkdir(unborn); await writeFile(join(plain, "big"), "abcdef"); await writeFile(join(unborn, "a.txt"), "x")
  git(unborn, "init", "-q")
  const plainDoc = localDocument("plain")
  const folder = await inspectResourceBinding(plainDoc, { resource: "node:a", representation: "local" }, { workspaces: { r: root } })
  assert.ok(folder.git !== null && folder.git.state === "NO_REPOSITORY")
  assert.equal(folder.git.state, "NO_REPOSITORY")
  const unbornDoc = localDocument("unborn/a.txt")
  const report = await inspectResourceBinding(unbornDoc, { resource: "node:a", representation: "local" }, { workspaces: { r: root } })
  assert.ok(report.git !== null && report.git.state === "REPOSITORY")
  assert.equal(report.git.state, "REPOSITORY"); assert.equal(report.git.head, null); assert.equal(report.git.origin, null)
})

test("limits and input contracts fail before filesystem resolution", async t => {
  const root = await temporary(t), repo = join(root, "repo"); await mkdir(repo); await writeFile(join(repo, "a.txt"), "abcdef")
  await assert.rejects(inspectResourceBinding(localDocument(), { resource: "node:a", representation: "local" }, { workspaces: { r: repo }, maxBytes: 2 }), /exceeds maxBytes/)
  await assert.rejects(inspectResourceBinding(localDocument(), { resource: "node:a", representation: "local" }, { workspaces: { r: repo }, maxMetadataBytes: 0 }), /exceeded maxMetadataBytes/)
  await assert.rejects(inspectResourceBinding(localDocument(), { resource: "node:a", representation: "local" }, { workspaces: { r: repo }, extra: true } as any), /unknown binding inspection options field/)
})
