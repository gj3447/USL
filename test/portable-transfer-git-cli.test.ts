import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"

const execFile = promisify(execFileCallback)
const command = ["--import", "tsx", "scripts/usl-git-export.ts"]
const cli = (...args: string[]) => execFile(process.execPath, [...command, ...args], { cwd: resolve(import.meta.dirname, ".."), timeout: 30_000 })
const git = (root: string, ...args: string[]) => execFile("git", ["-C", root, ...args], {
  env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", LC_ALL: "C" },
  timeout: 10_000,
})

test("CP01-1: standalone CLI exports an explicitly pinned clean repository", async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "usl-clean-git-cli-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourceRoot = join(root, "source"), destinationParent = join(root, "output")
  await Promise.all([mkdir(sourceRoot), mkdir(destinationParent)])
  await git(sourceRoot, "init", "--initial-branch=main")
  await writeFile(join(sourceRoot, "note.txt"), "portable clean Git\n")
  await git(sourceRoot, "add", "note.txt")
  await git(sourceRoot, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture")
  const head = (await git(sourceRoot, "rev-parse", "HEAD")).stdout.trim()
  const spec = join(root, "spec.json")
  await writeFile(spec, JSON.stringify({
    schema: "usl-clean-git-export/v1", sourceRoot,
    ownerNamespace: "urn:example:owner", repositoryId: "urn:example:repository", worktreeId: "urn:example:worktree",
    expectedHead: head, expectedRefs: { "refs/heads/main": head }, expectedObjectFormat: "sha1",
    issuer: "urn:example:issuer", observedAt: "2026-10-05T00:00:00Z",
  }))
  const response = await cli("--spec", spec, "--destination-parent", destinationParent)
  const result = JSON.parse(response.stdout) as { bundlePath: string; manifestDigest: string }
  assert.match(result.manifestDigest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(response.stderr, "")
  const manifest = JSON.parse(await readFile(join(result.bundlePath, "manifest.json"), "utf8"))
  assert.equal(JSON.stringify(manifest).includes(sourceRoot), false)
})

test("CP01-2: Git export CLI refuses invalid flags, special files, and spec destinations", async t => {
  const help = await cli("--help")
  assert.match(help.stdout, /--spec FILE --destination-parent DIRECTORY/)
  await assert.rejects(cli("--source", "-"), /usage:/)
  const root = await mkdtemp(join(await realpath(tmpdir()), "usl-clean-git-cli-input-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const spec = join(root, "spec.json")
  await writeFile(spec, JSON.stringify({ sourceRoot: root, destinationParent: root }))
  await assert.rejects(cli("--spec", spec, "--destination-parent", root), /caller flag/)
  if (process.platform !== "win32") {
    const linked = join(root, "linked.json"), fifo = join(root, "pipe")
    await symlink(spec, linked)
    await assert.rejects(cli("--spec", linked, "--destination-parent", root), /regular non-symlink/)
    await execFile("mkfifo", [fifo])
    await assert.rejects(cli("--spec", fifo, "--destination-parent", root), /regular non-symlink/)
  }
  await writeFile(spec, Buffer.alloc(2 * 1024 * 1024 + 1, 32))
  await assert.rejects(cli("--spec", spec, "--destination-parent", root), /2 MiB/)
  await writeFile(spec, Buffer.from([0xff]))
  await assert.rejects(cli("--spec", spec, "--destination-parent", root), /encoded data|encoding/i)
})
