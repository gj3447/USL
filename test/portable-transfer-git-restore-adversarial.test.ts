import assert from "node:assert/strict"
import { readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { contractDigest } from "../src/contract-core.js"
import { importCleanGitTransfer, recheckCleanGitRestore } from "../src/addons/portable-transfer-git.js"
import { byteDigest, cleanGitFixture, gitFixtureCommand as git } from "./clean-git-fixture.js"

test("CP02-1: SHA-256 restores complete trees, executable bits and independent object storage", async t => {
  const fx = await cleanGitFixture(t, "sha256")
  await rm(fx.source, { recursive: true })
  const restored = await importCleanGitTransfer(fx.request)
  await rm(fx.backup, { recursive: true })
  const main = join(restored.destinationPath, "worktrees/main")
  assert.equal(git(main, "rev-parse", "--show-object-format"), "sha256")
  assert.equal(git(main, "rev-parse", "HEAD"), fx.head)
  assert.equal(git(main, "status", "--porcelain"), "")
  assert.equal(await readFile(join(main, "run.sh"), "utf8"), "#!/bin/sh\nexit 9\n")
  assert.ok((await stat(join(main, "run.sh"))).mode & 0o100)
  assert.equal(git(restored.repositoryPath, "config", "--local", "--list").includes("remote."), false)
  await assert.rejects(stat(join(restored.repositoryPath, "objects/info/alternates")), { code: "ENOENT" })
  await recheckCleanGitRestore(restored)
})

test("CP02-2: failed file pins and aggregate checkout budgets clean only newly reserved destinations", async t => {
  const fx = await cleanGitFixture(t)
  const badFile = { ...fx.request.files[0]!, expectedByteDigest: "sha256:" + "0".repeat(64) }
  for (const request of [
    { ...fx.request, files: [badFile] },
    { ...fx.request, maxCheckoutBytes: 1 }, { ...fx.request, maxUncompressedBytes: 1 },
    { ...fx.request, maxBundleBytes: 1 }, { ...fx.request, maxObjects: 1 }, { ...fx.request, maxDurationMs: 1 },
  ]) {
    await assert.rejects(importCleanGitTransfer(request), /pin|budget/i)
    assert.deepEqual(await readdir(fx.output), [])
  }
  assert.equal(git(fx.source, "status", "--porcelain"), "")
})

test("CP02-2: receipt metadata and a corrupted pack cannot inherit a valid-looking digest chain", async t => {
  const fx = await cleanGitFixture(t)
  const receiptPath = join(fx.exported.bundlePath, "receipt.json"), manifestPath = join(fx.exported.bundlePath, "manifest.json")
  const originalReceipt = JSON.parse(await readFile(receiptPath, "utf8"))
  const writeReceipt = async (value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value) + "\n")
    await writeFile(receiptPath, bytes)
    return byteDigest(bytes)
  }
  let expectedReceiptDigest = await writeReceipt({ ...originalReceipt, unexpected: "extension" })
  await assert.rejects(importCleanGitTransfer({ ...fx.request, expectedReceiptDigest }), /unrecognized|unknown/i)
  expectedReceiptDigest = await writeReceipt(originalReceipt)
  await writeFile(manifestPath, (await readFile(manifestPath, "utf8")) + " ")
  await assert.rejects(importCleanGitTransfer({ ...fx.request, expectedReceiptDigest }), /raw manifest/)
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  const bundle = await readFile(fx.exported.gitBundlePath)
  bundle[bundle.length - 1] = bundle[bundle.length - 1]! ^ 1
  await writeFile(fx.exported.gitBundlePath, bundle)
  manifest.bundle.byteDigest = byteDigest(bundle)
  const manifestBytes = Buffer.from(JSON.stringify(manifest) + "\n")
  await writeFile(manifestPath, manifestBytes)
  expectedReceiptDigest = await writeReceipt({ ...originalReceipt, manifestDigest: contractDigest(manifest), manifestByteDigest: byteDigest(manifestBytes), bundleByteDigest: byteDigest(bundle) })
  await assert.rejects(importCleanGitTransfer({ ...fx.request, expectedReceiptDigest }), /Git command failed|bundle|pack/i)
  assert.deepEqual(await readdir(fx.output), [])
})

test("CP02-2: unsupported transformations, case collisions and symlink transports are refused", async t => {
  const attrs = await cleanGitFixture(t, "sha1", { ".gitattributes": "note.txt text eol=lf\n" })
  await assert.rejects(importCleanGitTransfer(attrs.request), /attributes|transform/)
  assert.deepEqual(await readdir(attrs.output), [])
  const collision = await cleanGitFixture(t, "sha1", { "NOTE.txt": "ambiguous\n" })
  await assert.rejects(importCleanGitTransfer(collision.request), /collision/)
  assert.deepEqual(await readdir(collision.output), [])
  const fx = await cleanGitFixture(t)
  const extraEntry = join(fx.exported.bundlePath, "unexpected")
  await writeFile(extraEntry, "unselected")
  await assert.rejects(importCleanGitTransfer(fx.request), /unexpected bundle entry/)
  await rm(extraEntry)
  const link = join(fx.root, "transport-link")
  await symlink(fx.exported.bundlePath, link)
  await assert.rejects(importCleanGitTransfer({ ...fx.request, bundlePath: link }), /symlink/)
  await rm(fx.exported.gitBundlePath)
  await symlink(join(fx.source, "note.txt"), fx.exported.gitBundlePath)
  await assert.rejects(importCleanGitTransfer(fx.request), /file type|symlink/)
  assert.deepEqual(await readdir(fx.output), [])
})

test("CP02-2: captured inputs, branch collisions and ignored additions cannot bypass verification", async t => {
  const fx = await cleanGitFixture(t, "sha1", { ".gitignore": "ignored.txt\n" })
  const mutable = structuredClone(fx.request)
  const pending = importCleanGitTransfer(mutable)
  mutable.worktrees[0]!.head = "0".repeat(40)
  mutable.files[0]!.expectedByteDigest = "sha256:" + "0".repeat(64)
  const restored = await pending
  assert.equal(restored.worktrees[0]!.head, fx.head)
  await writeFile(join(restored.destinationPath, "worktrees/main/ignored.txt"), "injected\n")
  await assert.rejects(recheckCleanGitRestore(restored), /stale|changed/)
  const duplicate = { ...fx.request, destinationName: "another", worktrees: [...fx.request.worktrees, { ...fx.request.worktrees[0]!, worktreeId: "other", path: "other" }] }
  await assert.rejects(importCleanGitTransfer(duplicate), /branch/)
  await assert.rejects(importCleanGitTransfer({ ...fx.request, destinationName: "another", allowedOwnerNamespace: "urn:wrong:owner" }), /owner/)
  await assert.rejects(importCleanGitTransfer({ ...fx.request, destinationName: "another", expectedRepositoryId: "wrong" }), /repository/)
})
