import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { exportCleanGitTransfer } from "../src/addons/portable-transfer-git.js"
import { importCleanGitTransfer, recheckCleanGitRestore } from "../src/addons/portable-transfer-git.js"

const env = () => ({ PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" })
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8", env: env(), stdio: ["ignore", "pipe", "pipe"] }).trim()
const sha = (value: Uint8Array) => "sha256:" + createHash("sha256").update(value).digest("hex")

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "usl-cp02-")), main = join(root, "main"), linked = join(root, "linked"), out = join(root, "out"), transport = join(root, "transport"), restored = join(root, "restored")
  t.after(() => rm(root, { recursive: true, force: true }))
  await Promise.all([mkdir(main), mkdir(out), mkdir(transport), mkdir(restored)])
  git(main, "init", "-q", "--initial-branch=main")
  await writeFile(join(main, "same.txt"), "same bytes\n")
  git(main, "add", "."); git(main, "-c", "user.name=USL", "-c", "user.email=u@example.invalid", "commit", "-qm", "main")
  const mainHead = git(main, "rev-parse", "HEAD")
  git(main, "worktree", "add", "-q", "-b", "topic", linked)
  await writeFile(join(linked, "same.txt"), "same bytes\n")
  await writeFile(join(linked, "topic.txt"), "topic\n")
  git(linked, "add", "."); git(linked, "-c", "user.name=USL", "-c", "user.email=u@example.invalid", "commit", "-qm", "topic")
  const topicRef = git(linked, "rev-parse", "HEAD")
  git(linked, "checkout", "-q", "--detach", "HEAD")
  await writeFile(join(linked, "detached.txt"), "detached\n")
  git(linked, "add", "."); git(linked, "-c", "user.name=USL", "-c", "user.email=u@example.invalid", "commit", "-qm", "detached")
  const detached = git(linked, "rev-parse", "HEAD")
  const transfer = await exportCleanGitTransfer({ schema: "usl-clean-git-export/v1", sourceRoot: linked, destinationParent: out, ownerNamespace: "urn:test:owner", repositoryId: "repo", worktreeId: "detached", expectedHead: detached, expectedRefs: { "refs/heads/main": mainHead, "refs/heads/topic": topicRef }, expectedObjectFormat: "sha1", issuer: "urn:test:issuer", observedAt: "2026-10-05T00:00:00Z" })
  const copied = join(transport, "bundle")
  await cp(transfer.bundlePath, copied, { recursive: true })
  const receiptDigest = sha(await readFile(join(copied, "receipt.json")))
  await rm(main, { recursive: true, force: true }); await rm(linked, { recursive: true, force: true }); await rm(transfer.bundlePath, { recursive: true, force: true })
  const byte = async (name: string) => {
    const content = name === "same.txt" ? "same bytes\n" : name === "topic.txt" ? "topic\n" : "detached\n"
    return { expectedByteDigest: sha(Buffer.from(content)), expectedByteLength: Buffer.byteLength(content) }
  }
  return { root, copied, restored, receiptDigest, mainHead, topicRef, detached, byte }
}

async function input(fx: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}) {
  return { schema: "usl-clean-git-import/v1", bundlePath: fx.copied, destinationParent: fx.restored, destinationName: "restore", expectedReceiptDigest: fx.receiptDigest, allowedOwnerNamespace: "urn:test:owner", expectedRepositoryId: "repo", worktrees: [{ worktreeId: "main", path: "main", head: fx.mainHead, branch: "refs/heads/main" }, { worktreeId: "topic", path: "topic", head: fx.detached }], files: [{ nativeId: "n-same", revisionId: fx.mainHead, representationId: "r-main", worktreeId: "main", path: "same.txt", ...(await fx.byte("same.txt")) }, { nativeId: "n-same", revisionId: fx.detached, representationId: "r-detached", worktreeId: "topic", path: "same.txt", ...(await fx.byte("same.txt")) }, { nativeId: "n-detached", revisionId: fx.detached, representationId: "r-detached-file", worktreeId: "topic", path: "detached.txt", ...(await fx.byte("detached.txt")) }], ...extra }
}

test("CP02-1: restores independently from copied transport after original common store disappears", async t => {
  const fx = await fixture(t)
  const result = await importCleanGitTransfer(await input(fx))
  await rm(fx.copied, { recursive: true, force: true })
  assert.equal(result.authority, "NOT_GRANTED")
  assert.equal(git(join(result.destinationPath, "worktrees/main"), "rev-parse", "HEAD"), fx.mainHead)
  assert.equal(git(join(result.destinationPath, "worktrees/topic"), "rev-parse", "HEAD"), fx.detached)
  assert.equal(await readFile(join(result.destinationPath, "worktrees/topic/detached.txt"), "utf8"), "detached\n")
  assert.ok(result.repositoryPath.startsWith(result.destinationPath + "/"))
  await Promise.resolve(recheckCleanGitRestore(result))
  await assert.rejects(() => Promise.resolve(recheckCleanGitRestore(JSON.parse(JSON.stringify(result)))), /genuine|handle|serialized|restore/i)
  git(join(result.destinationPath, "worktrees/main"), "update-ref", "--no-deref", "HEAD", fx.topicRef)
  await assert.rejects(() => Promise.resolve(recheckCleanGitRestore(result)), /stale|head|changed|clean/i)
})

test("CP02-2: serializes a destination reservation and preserves an existing destination", async t => {
  const fx = await fixture(t), value = await input(fx, { destinationName: "race" })
  const settled = await Promise.allSettled([importCleanGitTransfer(value), importCleanGitTransfer(value)])
  assert.equal(settled.filter(item => item.status === "fulfilled").length, 1)
  assert.equal(settled.filter(item => item.status === "rejected").length, 1)
  const winner = settled.find((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof importCleanGitTransfer>>> => item.status === "fulfilled")!.value
  assert.equal(await readFile(join(winner.destinationPath, "worktrees/topic/detached.txt"), "utf8"), "detached\n")
  const second = await fixture(t)
  await mkdir(join(second.restored, "occupied")); await writeFile(join(second.restored, "occupied/keep"), "keep")
  await assert.rejects(importCleanGitTransfer(await input(second, { destinationName: "occupied" })), /destination|exist|collision/i)
  assert.equal(await readFile(join(second.restored, "occupied/keep"), "utf8"), "keep")
})

test("CP02-2: rejects tampered receipt, collisions, traversal and duplicate native revision before destination publication", async t => {
  const fx = await fixture(t)
  const base = { schema: "usl-clean-git-import/v1", bundlePath: fx.copied, destinationParent: fx.restored, destinationName: "collision", expectedReceiptDigest: fx.receiptDigest, allowedOwnerNamespace: "urn:test:owner", expectedRepositoryId: "repo", worktrees: [{ worktreeId: "main", path: "main", head: fx.mainHead, branch: "refs/heads/main" }], files: [{ nativeId: "n", revisionId: fx.mainHead, representationId: "a", worktreeId: "main", path: "same.txt", ...(await fx.byte("same.txt")) }] }
  for (const value of [{ ...base, expectedReceiptDigest: sha(Buffer.from("bad")) }, { ...base, destinationName: "../escape" }, { ...base, files: [...base.files, { ...base.files[0], representationId: "other", path: "other.txt" }] }]) await assert.rejects(importCleanGitTransfer(value), /receipt|path|native|revision|duplicate|invalid/i)
  assert.deepEqual((await readdir(fx.restored)).filter(name => !name.startsWith(".")), [])
})
