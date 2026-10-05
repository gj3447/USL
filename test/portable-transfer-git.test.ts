import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { exportCleanGitTransfer, parseCleanGitTransferManifest } from "../src/addons/portable-transfer-git.js"

const gitEnvironment = (): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(environment)) if (key.startsWith("GIT_")) delete environment[key]
  return { ...environment, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" }
}
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
  encoding: "utf8", env: gitEnvironment(), stdio: ["ignore", "pipe", "pipe"],
}).trim()

async function fixture(t: TestContext, detached = false) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "usl-clean-git-")), main = join(root, "main"), worker = join(root, "worker"), exports = join(root, "exports")
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  await Promise.all([mkdir(main), mkdir(exports)])
  await writeFile(join(main, "note.txt"), "base\n")
  git(main, "init", "-q", "--initial-branch=main")
  git(main, "add", ".")
  git(main, "-c", "user.name=USL Test", "-c", "user.email=usl-test@example.invalid", "commit", "-qm", "base")
  const mainHead = git(main, "rev-parse", "HEAD")
  git(main, "worktree", "add", "-q", "-b", "worker", worker)
  await writeFile(join(worker, "note.txt"), "worker\n")
  git(worker, "add", "note.txt")
  git(worker, "-c", "user.name=USL Test", "-c", "user.email=usl-test@example.invalid", "commit", "-qm", "worker")
  const workerRefHead = git(worker, "rev-parse", "HEAD")
  if (detached) {
    git(worker, "checkout", "-q", "--detach", "HEAD")
    await writeFile(join(worker, "detached.txt"), "detached-only\n")
    git(worker, "add", "detached.txt")
    git(worker, "-c", "user.name=USL Test", "-c", "user.email=usl-test@example.invalid", "commit", "-qm", "detached")
  }
  const workerHead = git(worker, "rev-parse", "HEAD")
  return { root, main, worker, exports, mainHead, workerHead, workerRefHead }
}

function request(fx: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}) {
  return {
    schema: "usl-clean-git-export/v1",
    sourceRoot: fx.worker,
    destinationParent: fx.exports,
    ownerNamespace: "urn:example:git-owner",
    repositoryId: "repo.example",
    worktreeId: "worker.detached",
    expectedHead: fx.workerHead,
    expectedRefs: { "refs/heads/main": fx.mainHead, "refs/heads/worker": fx.workerRefHead },
    expectedObjectFormat: "sha1",
    issuer: "urn:example:issuer",
    observedAt: "2026-10-05T00:00:00Z",
    ...extra,
  }
}

async function published(parent: string) {
  return (await readdir(parent)).filter(name => !name.startsWith("."))
}

test("CP01-1: exports a clean detached linked worktree as a native self-contained bundle without source paths", async t => {
  const fx = await fixture(t, true)
  await writeFile(join(fx.worker, ".git-local-secret"), "not committed")
  await rm(join(fx.worker, ".git-local-secret"))
  git(fx.worker, "config", "usl.private", "must-not-transfer")
  const result = await exportCleanGitTransfer(request(fx))
  assert.equal(result.manifest.expectedHead, fx.workerHead)
  assert.deepEqual(result.manifest.expectedRefs, { "refs/heads/main": fx.mainHead, "refs/heads/worker": fx.workerRefHead })
  assert.equal(result.manifest.repositoryId, "repo.example")
  assert.equal(result.manifest.worktreeId, "worker.detached")
  assert.ok((await lstat(result.bundlePath)).isDirectory())
  assert.ok((await lstat(result.gitBundlePath)).isFile())
  assert.ok((await lstat(result.manifestPath)).isFile())
  assert.ok((await lstat(result.receiptPath)).isFile())
  const bundleBytes = await readFile(result.gitBundlePath)
  assert.equal(result.bytes, bundleBytes.byteLength)
  assert.equal(result.bundleByteDigest, `sha256:${createHash("sha256").update(bundleBytes).digest("hex")}`)
  const sidecars = await Promise.all([result.manifestPath, result.receiptPath].map(path => readFile(path, "utf8")))
  assert.ok(!sidecars.join("\n").includes(fx.root))
  assert.ok(!sidecars.join("\n").includes("must-not-transfer"))
  const parsed = parseCleanGitTransferManifest(JSON.parse(await readFile(result.manifestPath, "utf8")))
  assert.equal(parsed.expectedHead, fx.workerHead)
  const manifestJson = JSON.parse(await readFile(result.manifestPath, "utf8"))
  const forged = { ...manifestJson }
  forged.observedHead = fx.workerRefHead
  assert.throws(() => parseCleanGitTransferManifest(forged), /owner pins|observed/i)
  assert.throws(() => parseCleanGitTransferManifest({ ...manifestJson, unexpected: true }), /unrecognized|unknown/i)
  await rm(fx.main, { recursive: true, force: true })
  await rm(fx.worker, { recursive: true, force: true })
  const bare = join(fx.root, "bare")
  await mkdir(bare)
  git(bare, "init", "--bare", "-q")
  git(bare, "bundle", "verify", result.gitBundlePath)
  const heads = git(bare, "bundle", "list-heads", result.gitBundlePath).split("\n")
  assert.ok(heads.some(line => line === `${fx.mainHead} refs/heads/main`))
  assert.ok(heads.some(line => line === `${fx.workerRefHead} refs/heads/worker`))
  git(bare, "bundle", "unbundle", result.gitBundlePath)
  git(bare, "fsck", "--no-dangling")
  git(bare, "cat-file", "-e", `${fx.mainHead}^{commit}`)
  git(bare, "cat-file", "-e", `${fx.workerRefHead}^{commit}`)
  git(bare, "cat-file", "-e", `${fx.workerHead}^{commit}`)
  git(bare, "cat-file", "-e", `${fx.workerHead}:detached.txt`)
})

test("CP01-1: rejects independently pinned HEAD/ref/object-format disagreement before publishing", async t => {
  for (const update of [
    { expectedHead: "0".repeat(40) },
    { expectedRefs: { "refs/heads/main": "0".repeat(40), "refs/heads/worker": "0".repeat(40) } },
    { expectedObjectFormat: "sha256" },
  ]) {
    const fx = await fixture(t, true)
    await assert.rejects(exportCleanGitTransfer(request(fx, update)), /head|ref|object|format|expected/i)
    assert.deepEqual(await published(fx.exports), [])
  }
})

test("CP01-2: rejects dirty index, worktree, and untracked states without changing the source", async t => {
  for (const mutation of [
    async (path: string) => { await writeFile(join(path, "note.txt"), "dirty\n") },
    async (path: string) => { await writeFile(join(path, "indexed.txt"), "index\n"); git(path, "add", "indexed.txt") },
    async (path: string) => { await writeFile(join(path, "untracked.txt"), "untracked\n") },
  ]) {
    const fx = await fixture(t, true)
    await mutation(fx.worker)
    const before = git(fx.worker, "status", "--porcelain=v1")
    await assert.rejects(exportCleanGitTransfer(request(fx)), /clean|dirty|index|untracked/i)
    assert.equal(git(fx.worker, "status", "--porcelain=v1"), before)
    assert.deepEqual(await published(fx.exports), [])
  }
})

test("CP01-2: rejects unsupported repository closure forms without executing configured filters", async t => {
  const scenarios: Array<{ readonly name: string, readonly arrange: (fx: Awaited<ReturnType<typeof fixture>>) => Promise<void> }> = [
    { name: "sparse", arrange: async fx => { git(fx.worker, "sparse-checkout", "init", "--no-cone"); git(fx.worker, "sparse-checkout", "set", "--no-cone", "/note.txt") } },
    { name: "submodule", arrange: async fx => {
      const child = join(fx.root, "child"); await mkdir(child); git(child, "init", "-q"); await writeFile(join(child, "child.txt"), "child\n"); git(child, "add", "."); git(child, "-c", "user.name=USL Test", "-c", "user.email=usl-test@example.invalid", "commit", "-qm", "child")
      git(fx.worker, "-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "nested"); git(fx.worker, "add", ".gitmodules", "nested"); git(fx.worker, "-c", "user.name=USL Test", "-c", "user.email=usl-test@example.invalid", "commit", "-qm", "submodule")
    } },
  ]
  for (const scenario of scenarios) {
    const fx = await fixture(t)
    await scenario.arrange(fx)
    await assert.rejects(exportCleanGitTransfer(request(fx, { expectedHead: git(fx.worker, "rev-parse", "HEAD"), expectedRefs: { "refs/heads/main": fx.mainHead, "refs/heads/worker": git(fx.worker, "rev-parse", "HEAD") } })), /sparse|submodule|unsupported|clean/i, scenario.name)
    assert.deepEqual(await published(fx.exports), [])
  }
  const fx = await fixture(t), marker = join(fx.root, "filter-executed")
  await writeFile(join(fx.worker, ".gitattributes"), "note.txt filter=attack\n")
  git(fx.worker, "add", ".gitattributes")
  git(fx.worker, "-c", "user.name=USL Test", "-c", "user.email=usl-test@example.invalid", "commit", "-qm", "attributes")
  git(fx.worker, "config", "filter.attack.clean", `sh -c 'touch ${marker}'`)
  const head = git(fx.worker, "rev-parse", "HEAD")
  await assert.rejects(exportCleanGitTransfer(request(fx, { expectedHead: head, expectedRefs: { "refs/heads/main": fx.mainHead, "refs/heads/worker": head } })), /filter|promisor|unsupported/i)
  await assert.rejects(lstat(marker), /ENOENT/)
  assert.deepEqual(await published(fx.exports), [])
})

test("CP01-1: rejects shallow and alternates repositories rather than borrowing an original object store", async t => {
  const fx = await fixture(t, true)
  const shallow = join(fx.root, "shallow")
  execFileSync("git", ["clone", "--depth=1", `file://${fx.worker}`, shallow], { env: gitEnvironment(), stdio: "pipe" })
  const shallowHead = git(shallow, "rev-parse", "HEAD")
  await assert.rejects(exportCleanGitTransfer({ ...request(fx), sourceRoot: shallow, expectedHead: shallowHead, expectedRefs: { "refs/heads/main": shallowHead }, worktreeId: "shallow" }), /shallow|unsupported|closure/i)
  const alternate = join(fx.root, "alternate")
  execFileSync("git", ["clone", "--shared", fx.main, alternate], { env: gitEnvironment(), stdio: "pipe" })
  const alternateHead = git(alternate, "rev-parse", "HEAD")
  await assert.rejects(exportCleanGitTransfer({ ...request(fx), sourceRoot: alternate, expectedHead: alternateHead, expectedRefs: { "refs/heads/main": alternateHead }, worktreeId: "alternate" }), /alternate|unsupported|closure/i)
  assert.deepEqual(await published(fx.exports), [])
})

test("CP01-1: refuses symlink roots, malformed refs, accessors, and tiny budgets without publication", async t => {
  const fx = await fixture(t, true), sourceLink = join(fx.root, "source-link"), destinationLink = join(fx.root, "destination-link")
  await symlink(fx.worker, sourceLink)
  await assert.rejects(exportCleanGitTransfer({ ...request(fx), sourceRoot: sourceLink }), /symlink|directory/i)
  await assert.rejects(exportCleanGitTransfer(request(fx, { expectedRefs: { "refs/heads/ok;touch": fx.workerHead } })), /ref|invalid|expected/i)
  await assert.rejects(exportCleanGitTransfer(request(fx, { maxBundleBytes: 1 })), /budget|bundle|bytes/i)
  await assert.rejects(exportCleanGitTransfer(request(fx, { maxObjects: 1 })), /budget|object|closure/i)
  await symlink(fx.exports, destinationLink)
  await assert.rejects(exportCleanGitTransfer(request(fx, { destinationParent: destinationLink })), /symlink|directory/i)
  const accessor: any = request(fx)
  Object.defineProperty(accessor, "expectedHead", { enumerable: true, get: () => fx.workerHead })
  await assert.rejects(exportCleanGitTransfer(accessor), /JSON|data|accessor/i)
  assert.deepEqual(await published(fx.exports), [])
})

test("CP01-2: rejects unborn and LFS/filter worktrees before publication or filter execution", async t => {
  const fx = await fixture(t)
  const unborn = join(fx.root, "unborn")
  await mkdir(unborn)
  git(unborn, "init", "-q", "--initial-branch=main")
  await assert.rejects(exportCleanGitTransfer(request(fx, { sourceRoot: unborn, worktreeId: "unborn", expectedHead: "0".repeat(40), expectedRefs: { "refs/heads/main": "0".repeat(40) } })), /head|unborn|Git|worktree/i)
  const marker = join(fx.root, "lfs-filter-executed")
  await writeFile(join(fx.worker, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n")
  await writeFile(join(fx.worker, "asset.bin"), "version https://git-lfs.github.com/spec/v1\noid sha256:deadbeef\nsize 1\n")
  git(fx.worker, "add", ".gitattributes", "asset.bin")
  git(fx.worker, "-c", "user.name=USL Test", "-c", "user.email=usl-test@example.invalid", "commit", "-qm", "lfs pointer")
  git(fx.worker, "config", "filter.lfs.process", `sh -c 'touch ${marker}'`)
  const head = git(fx.worker, "rev-parse", "HEAD")
  await assert.rejects(exportCleanGitTransfer(request(fx, { expectedHead: head, expectedRefs: { "refs/heads/main": fx.mainHead, "refs/heads/worker": head } })), /filter|lfs|unsupported/i)
  await assert.rejects(lstat(marker), /ENOENT/)
  assert.deepEqual(await published(fx.exports), [])
})
