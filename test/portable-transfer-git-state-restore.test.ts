import assert from "node:assert/strict"
import { cp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { exportGitWorktreeState } from "../src/addons/portable-transfer-git-state.js"
import { gitStateRevisionId, importGitWorktreeState, recheckGitStateRestore } from "../src/addons/portable-transfer-git-state-restore.js"
import { byteDigest, cleanGitFixture, gitFixtureCommand as git } from "./clean-git-fixture.js"

const sha = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`

function stateRequest(fx: Awaited<ReturnType<typeof cleanGitFixture>>, selectedUntracked: string[] = []) {
  return { schema: "usl-git-state-export/v1" as const, sourceRoot: fx.source, destinationParent: fx.backup, ownerNamespace: "urn:example:owner", repositoryId: "repo", worktreeId: "main", issuer: "urn:example:issuer", observedAt: "2026-10-07T00:00:00Z", expectedHead: fx.head, expectedObjectFormat: fx.exported.manifest.objectFormat, selectedUntracked }
}
function restoreRequest(fx: Awaited<ReturnType<typeof cleanGitFixture>>, state: Awaited<ReturnType<typeof exportGitWorktreeState>>, artifactPath: string, files: any[] = []) {
  return { schema: "usl-git-state-import/v1" as const, bundlePath: fx.exported.bundlePath, expectedReceiptDigest: fx.exported.receiptDigest, allowedOwnerNamespace: "urn:example:owner", expectedRepositoryId: "repo", destinationParent: fx.output, destinationName: "state-restored", worktrees: [{ worktreeId: "main", path: "main", head: fx.head, branch: "refs/heads/main", artifactPath, expectedStateReceiptDigest: state.receiptDigest }], files }
}
const stageRows = (cwd: string) => git(cwd, "ls-files", "--stage", "-z").split("\0").filter(Boolean).map(row => row.replace(/^([0-9]+) ([a-f0-9]+) ([0-3])\t(.+)$/u, "$4\t$3\t$1\t$2")).sort()

test("CP03-1: restores a copied state sidecar onto the clean bundle's exact native index and dirty working bytes", async (t) => {
  const fx = await cleanGitFixture(t)
  await writeFile(join(fx.source, "note.txt"), "staged A\n"); git(fx.source, "add", "note.txt")
  await writeFile(join(fx.source, "note.txt"), "working B\n")
  await writeFile(join(fx.source, "run.sh"), "#!/bin/sh\nexit 77\n", { mode: 0o755 }); git(fx.source, "add", "run.sh")
  await writeFile(join(fx.source, "selected.bin"), Buffer.from([0, 255, 1])); await writeFile(join(fx.source, "empty.bin"), "")
  const state = await exportGitWorktreeState(stateRequest(fx, ["selected.bin", "empty.bin"]))
  const copied = join(fx.root, "transferred-state"), copiedBundle = join(fx.root, "transferred-bundle")
  await cp(state.artifactPath, copied, { recursive: true }); await cp(fx.exported.bundlePath, copiedBundle, { recursive: true })
  const expectedIndex = state.state.index.map(entry => `${entry.path}\t${entry.stage}\t${entry.mode}\t${entry.objectId}`).sort()
  const files = [
    { nativeId: "note-dirty", revisionId: gitStateRevisionId(state.receiptDigest), representationId: "note-dirty-rep", worktreeId: "main", path: "note.txt", expectedByteDigest: byteDigest(Buffer.from("working B\n")), expectedByteLength: 10 },
    { nativeId: "untracked", revisionId: gitStateRevisionId(state.receiptDigest), representationId: "untracked-rep", worktreeId: "main", path: "selected.bin", expectedByteDigest: sha(Buffer.from([0, 255, 1])), expectedByteLength: 3 },
  ]
  await rm(fx.source, { recursive: true, force: true }); await rm(fx.backup, { recursive: true, force: true })
  const result = await importGitWorktreeState({ ...restoreRequest(fx, state, copied, files), bundlePath: copiedBundle })
  await rm(copied, { recursive: true }); await rm(copiedBundle, { recursive: true })
  await recheckGitStateRestore(result)
  const worktree = join(result.destinationPath, "worktrees", "main")
  assert.equal(git(worktree, "rev-parse", "HEAD"), fx.head)
  assert.deepEqual(stageRows(worktree), expectedIndex)
  assert.equal(await readFile(join(worktree, "note.txt"), "utf8"), "working B\n")
  assert.deepEqual(await readFile(join(worktree, "selected.bin")), Buffer.from([0, 255, 1]))
  assert.equal((await readFile(join(worktree, "empty.bin"))).length, 0)
  assert.equal(result.files.every((file: any) => file.revisionId === gitStateRevisionId(state.receiptDigest)), true)
  assert.equal(result.files.every((file: any) => file.parentHead === fx.head), true)
})

test("CP03-1: restores SHA-256 conflict stages and executable working mode without treating the handle as serializable", async (t) => {
  const fx = await cleanGitFixture(t, "sha256")
  const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" }
  const ids = ["base\n", "ours\n", "theirs\n"].map(value => execFileSync("git", ["-C", fx.source, "hash-object", "-w", "--stdin"], { input: value, encoding: "utf8", env }).trim())
  execFileSync("git", ["-C", fx.source, "update-index", "-z", "--index-info"], { input: ids.map((id, index) => `100644 ${id} ${index + 1}\tconflict.txt\0`).join(""), env })
  await writeFile(join(fx.source, "conflict.txt"), "working conflict\n")
  await writeFile(join(fx.source, "run.sh"), "#!/bin/sh\nexit 88\n", { mode: 0o755 }); git(fx.source, "add", "run.sh")
  const state = await exportGitWorktreeState(stateRequest(fx))
  const copied = join(fx.root, "sha256-state"); await cp(state.artifactPath, copied, { recursive: true })
  await rm(fx.source, { recursive: true, force: true })
  const result = await importGitWorktreeState(restoreRequest(fx, state, copied))
  await recheckGitStateRestore(result)
  const roundTrip = JSON.parse(JSON.stringify(result))
  await assert.rejects(recheckGitStateRestore(roundTrip), /handle|verified|serialized/i)
  const worktree = join(result.destinationPath, "worktrees", "main")
  assert.equal(git(worktree, "rev-parse", "--show-object-format"), "sha256")
  assert.equal(git(worktree, "rev-parse", "HEAD"), fx.head)
  assert.deepEqual(stageRows(worktree), state.state.index.map(entry => `${entry.path}\t${entry.stage}\t${entry.mode}\t${entry.objectId}`).sort())
  assert.deepEqual(stageRows(worktree).filter(row => row.startsWith("conflict.txt\t")).map(row => row.split("\t")[1]), ["1", "2", "3"])
  assert.equal((await readFile(join(worktree, "run.sh"))).toString("utf8"), "#!/bin/sh\nexit 88\n")
  assert.equal((await stat(join(worktree, "run.sh"))).mode & 0o100, 0o100)
})
