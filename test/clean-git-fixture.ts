import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TestContext } from "node:test"
import { exportCleanGitTransfer } from "../src/addons/portable-transfer-git.js"

export const gitFixtureCommand = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8", env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] }).trim()
export const byteDigest = (value: Uint8Array) => "sha256:" + createHash("sha256").update(value).digest("hex")
export async function cleanGitFixture(t: TestContext, format: "sha1" | "sha256" = "sha1", extra: Record<string, string> = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "usl-cp02-fixture-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, "source"), backup = join(root, "backup"), output = join(root, "output")
  await Promise.all([mkdir(source), mkdir(backup), mkdir(output)])
  gitFixtureCommand(source, "init", "--template=", "--initial-branch=main", `--object-format=${format}`)
  await writeFile(join(source, "note.txt"), "memory\n")
  await writeFile(join(source, "run.sh"), "#!/bin/sh\nexit 9\n")
  await chmod(join(source, "run.sh"), 0o755)
  for (const [path, value] of Object.entries(extra)) await writeFile(join(source, path), value)
  gitFixtureCommand(source, "add", ".")
  gitFixtureCommand(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture")
  const head = gitFixtureCommand(source, "rev-parse", "HEAD")
  const exported = await exportCleanGitTransfer({ schema: "usl-clean-git-export/v1", sourceRoot: source, destinationParent: backup,
    ownerNamespace: "urn:example:owner", repositoryId: "repo", worktreeId: "main", expectedHead: head, expectedRefs: { "refs/heads/main": head }, expectedObjectFormat: format, issuer: "urn:example:issuer", observedAt: "2026-10-05T00:00:00Z" })
  const request = { schema: "usl-clean-git-import/v1", bundlePath: exported.bundlePath, destinationParent: output, destinationName: "restored",
    expectedReceiptDigest: exported.receiptDigest, allowedOwnerNamespace: "urn:example:owner", expectedRepositoryId: "repo",
    worktrees: [{ worktreeId: "main", path: "main", head, branch: "refs/heads/main" }],
    files: [{ nativeId: "memory", revisionId: head, representationId: "memory-original", worktreeId: "main", path: "note.txt", expectedByteDigest: byteDigest(Buffer.from("memory\n")), expectedByteLength: 7 }],
  }
  return { root, source, backup, output, head, exported, request }
}
