import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { watch, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { exportCleanGitTransfer, parseCleanGitTransferManifest } from "../src/addons/portable-transfer-git.js"

const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" }
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

async function fixture(t: TestContext, format: "sha1" | "sha256" = "sha1") {
  const root = await mkdtemp(join(await realpath(tmpdir()), "usl-cp01-adversarial-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourceRoot = join(root, "source"), destinationParent = join(root, "output")
  await Promise.all([mkdir(sourceRoot), mkdir(destinationParent)])
  git(sourceRoot, "init", "--initial-branch=main", `--object-format=${format}`)
  await writeFile(join(sourceRoot, "note.txt"), "pinned\n")
  git(sourceRoot, "add", "note.txt")
  git(sourceRoot, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture")
  const head = git(sourceRoot, "rev-parse", "HEAD")
  const input = {
    schema: "usl-clean-git-export/v1", sourceRoot, destinationParent,
    ownerNamespace: "urn:example:owner", repositoryId: "repo.fixture", worktreeId: "tree.fixture",
    expectedHead: head, expectedRefs: { "refs/heads/main": head }, expectedObjectFormat: format,
    issuer: "urn:example:issuer", observedAt: "2026-10-05T00:00:00Z",
  }
  return { root, sourceRoot, destinationParent, head, input }
}

test("CP01-1: SHA-256 repositories export verifiable objects without the source", async t => {
  const fx = await fixture(t, "sha256")
  const result = await exportCleanGitTransfer(fx.input)
  assert.equal(result.manifest.objectFormat, "sha256")
  assert.equal(result.manifest.expectedHead.length, 64)
  assert.equal(result.manifest.bundle.version, 3)
  assert.deepEqual(result.manifest.bundle.prerequisites, [])
  assert.equal(result.manifest.producer.gitVersion, git(fx.sourceRoot, "--version"))
  assert.equal(result.manifest.producer.nodeVersion, process.version)
  assert.deepEqual((await readdir(result.bundlePath)).sort(), ["manifest.json", "receipt.json", "repo.bundle"])
  await rm(fx.sourceRoot, { recursive: true })
  const verifier = join(fx.root, "verifier")
  await mkdir(verifier)
  git(verifier, "init", "--bare", "--object-format=sha256", "--template=")
  git(verifier, "bundle", "verify", result.gitBundlePath)
  git(verifier, "bundle", "unbundle", result.gitBundlePath)
  assert.equal(git(verifier, "show", `${fx.head}:note.txt`), "pinned")
})

test("CP01-1: input pins are captured before awaits and manifest contradictions are rejected", async t => {
  const fx = await fixture(t)
  const mutable = structuredClone(fx.input)
  const pending = exportCleanGitTransfer(mutable)
  mutable.expectedHead = "0".repeat(40)
  mutable.expectedRefs["refs/heads/main"] = "0".repeat(40)
  const result = await pending
  assert.equal(result.manifest.expectedHead, fx.head)
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"))
  for (const mutate of [
    (v: any) => { v.objectFormat = "sha256" },
    (v: any) => { v.bundle.heads["refs/heads/main"] = "0".repeat(40) },
    (v: any) => { v.bundle.heads["refs/heads/unselected"] = fx.head },
    (v: any) => { v.observedAt = "yesterday" },
    (v: any) => { v.bundle.bytes = Number.MAX_SAFE_INTEGER },
    (v: any) => { v.bundle.prerequisites = [fx.head] },
    (v: any) => { v.limits.maxBundleBytes = 1 },
    (v: any) => { v.producer.gitVersion = "" },
  ]) {
    const changed = structuredClone(manifest)
    mutate(changed)
    assert.throws(() => parseCleanGitTransferManifest(changed))
  }
})

test("CP01-2: source changes after staging starts abort publication and preserve the source", async t => {
  const fx = await fixture(t)
  let changed = false
  const watcher = watch(fx.destinationParent, (_event, filename) => {
    if (!changed && filename?.startsWith(".usl-clean-git-stage-")) {
      writeFileSync(join(fx.sourceRoot, "note.txt"), "changed during export\n")
      changed = true
    }
  })
  try {
    await assert.rejects(exportCleanGitTransfer(fx.input), /changed|clean|dirty/i)
    assert.equal(changed, true, "fixture must actually alter the source during staging")
    assert.deepEqual(await readdir(fx.destinationParent), [])
    assert.equal(await readFile(join(fx.sourceRoot, "note.txt"), "utf8"), "changed during export\n")
  } finally { watcher.close() }
})

test("CP01-2: ancestor symlinks, hidden dirty index flags, and promisor markers fail closed", async t => {
  const fx = await fixture(t), linkedParent = join(fx.root, "linked-parent")
  await symlink(fx.root, linkedParent)
  await assert.rejects(exportCleanGitTransfer({ ...fx.input, sourceRoot: join(linkedParent, "source") }), /symlink|directory/i)
  await assert.rejects(exportCleanGitTransfer({ ...fx.input, destinationParent: join(linkedParent, "output") }), /symlink|directory/i)
  git(fx.sourceRoot, "update-index", "--assume-unchanged", "note.txt")
  await writeFile(join(fx.sourceRoot, "note.txt"), "hidden dirty\n")
  await assert.rejects(exportCleanGitTransfer(fx.input), /assume|index|clean|unsupported/i)
  git(fx.sourceRoot, "update-index", "--no-assume-unchanged", "note.txt")
  git(fx.sourceRoot, "checkout", "--", "note.txt")
  await writeFile(join(fx.sourceRoot, ".git", "objects", "pack", "pack-deadbeef.promisor"), "")
  await assert.rejects(exportCleanGitTransfer(fx.input), /promisor|partial|unsupported/i)
  assert.deepEqual(await readdir(fx.destinationParent), [])
})

test("CP01-1: uncompressed and duration budgets abort without publishing or editing the source", async t => {
  const fx = await fixture(t)
  await assert.rejects(exportCleanGitTransfer({ ...fx.input, maxUncompressedBytes: 1 }), /budget/i)
  await assert.rejects(exportCleanGitTransfer({ ...fx.input, maxDurationMs: 1 }), /duration/i)
  assert.deepEqual(await readdir(fx.destinationParent), [])
  assert.equal(git(fx.sourceRoot, "status", "--porcelain"), "")
})

test("CP01-2: an unconfigured LFS pointer anywhere in selected history rejects incomplete content", async t => {
  const fx = await fixture(t)
  await writeFile(join(fx.sourceRoot, "note.txt"), "version https://git-lfs.github.com/spec/v1\noid sha256:" + "a".repeat(64) + "\nsize 10\n")
  const commit = (message: string) => {
    git(fx.sourceRoot, "add", "note.txt")
    git(fx.sourceRoot, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", message)
  }
  commit("historical pointer")
  await writeFile(join(fx.sourceRoot, "note.txt"), "current regular content\n")
  commit("current regular content")
  const head = git(fx.sourceRoot, "rev-parse", "HEAD")
  await assert.rejects(exportCleanGitTransfer({ ...fx.input, expectedHead: head, expectedRefs: { "refs/heads/main": head } }), /LFS pointer/i)
  assert.deepEqual(await readdir(fx.destinationParent), [])
  assert.equal(git(fx.sourceRoot, "status", "--porcelain"), "")
})
