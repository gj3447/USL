import assert from "node:assert/strict"
import { execFile as execFileCallback, spawn } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"
import { exportGitWorktreeState, verifyGitWorktreeState } from "../src/addons/portable-transfer-git-state.js"

const execFile = promisify(execFileCallback)
const ownerNamespace = "urn:example:owner"

const sha = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`
const gitEnv = (_cwd: string) => ({ PATH: process.env.PATH!, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" })
async function git(cwd: string, args: string[]) { return execFile("git", args, { cwd, env: gitEnv(cwd) }) }
async function gitInput(cwd: string, args: string[], input: string | Buffer) { return new Promise<string>((resolve, reject) => { const child = spawn("git", args, { cwd, env: gitEnv(cwd), stdio: ["pipe", "pipe", "pipe"] }), out: Buffer[] = [], errors: Buffer[] = []; child.stdout.on("data", item => out.push(Buffer.from(item))); child.stderr.on("data", item => errors.push(Buffer.from(item))); child.on("error", reject); child.on("exit", code => code === 0 ? resolve(Buffer.concat(out).toString("utf8")) : reject(new Error(Buffer.concat(errors).toString("utf8")))); child.stdin.end(input) }) }
async function cleanGitFixture(t: { after(callback: () => unknown): void }, objectFormat: "sha1" | "sha256" = "sha1") {
  const root = await mkdtemp(join(tmpdir(), "usl-cp03-git-")), source = join(root, "source"), exports = join(root, "exports"), template = join(root, "empty-template")
  await Promise.all([mkdir(source), mkdir(exports), mkdir(template)])
  t.after(() => rm(root, { recursive: true, force: true }))
  await git(source, ["init", `--template=${template}`, `--object-format=${objectFormat}`, "--initial-branch=main"])
  await git(source, ["config", "user.email", "cp03@example.test"]); await git(source, ["config", "user.name", "CP03"])
  await writeFile(join(source, "tracked.txt"), "base\n"); await writeFile(join(source, "rename-me.txt"), "rename\n")
  await git(source, ["add", "."]); await git(source, ["commit", "-m", "base"])
  const { stdout } = await git(source, ["rev-parse", "HEAD"])
  return { root, source, exports, head: stdout.trim(), objectFormat }
}

function request(fx: Awaited<ReturnType<typeof cleanGitFixture>>, selectedUntracked: string[] = []) {
  return { schema: "usl-git-state-export/v1" as const, sourceRoot: fx.source, destinationParent: fx.exports, ownerNamespace, repositoryId: "repo", worktreeId: "main", issuer: "urn:example:issuer", observedAt: "2026-10-06T00:00:00Z", expectedHead: fx.head, expectedObjectFormat: fx.objectFormat, selectedUntracked }
}
function verify(artifactPath: string, expectedReceiptDigest: string, head: string) {
  return { schema: "usl-git-state-verify/v1" as const, artifactPath, expectedReceiptDigest, allowedOwnerNamespace: ownerNamespace, expectedRepositoryId: "repo", expectedWorktreeId: "main", expectedHead: head }
}

test("CP03-1: captures staged A/worktree B, deletion, rename, executable mode, and selected binary/empty untracked bytes", async (t) => {
  const fx = await cleanGitFixture(t)
  await writeFile(join(fx.source, "tracked.txt"), "staged A\n"); await git(fx.source, ["add", "tracked.txt"])
  await writeFile(join(fx.source, "tracked.txt"), "working B\n")
  await git(fx.source, ["rm", "rename-me.txt"])
  await writeFile(join(fx.source, "renamed.txt"), "rename\n"); await git(fx.source, ["add", "renamed.txt"])
  await writeFile(join(fx.source, "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 }); await git(fx.source, ["add", "run.sh"])
  await writeFile(join(fx.source, "empty.bin"), ""); await writeFile(join(fx.source, "binary.bin"), Buffer.from([0, 255, 1, 128]))
  await writeFile(join(fx.source, "secret.txt"), "not selected")
  const result = await exportGitWorktreeState(request(fx, ["empty.bin", "binary.bin"]))
  assert.equal(result.state.profile, "RAW_REGULAR_GIT_STATE_V1")
  assert.equal(result.state.head, fx.head)
  assert.ok(result.state.index.some((entry: any) => entry.path === "tracked.txt" && entry.stage === 0))
  assert.deepEqual(result.state.working.find((entry: any) => entry.path === "tracked.txt")?.kind, "REGULAR")
  assert.equal(result.state.index.some((entry: any) => entry.path === "rename-me.txt"), false)
  assert.equal(result.state.working.some((entry: any) => entry.path === "rename-me.txt"), false)
  assert.ok(result.state.headTree.some((entry: any) => entry.path === "rename-me.txt"))
  assert.ok(result.state.index.some((entry: any) => entry.path === "run.sh" && entry.mode === "100755"))
  assert.deepEqual([...result.state.selectedUntracked].sort(), ["binary.bin", "empty.bin"])
  const staged = Buffer.from("staged A\n"), working = Buffer.from("working B\n"), binary = Buffer.from([0, 255, 1, 128])
  const index = result.state.index.find((entry: any) => entry.path === "tracked.txt" && entry.stage === 0)!
  const work = result.state.working.find((entry: any) => entry.path === "tracked.txt")!
  assert.equal(index.blobDigest, sha(staged)); assert.equal(work.kind, "REGULAR"); if (work.kind === "REGULAR") assert.equal(work.blobDigest, sha(working))
  for (const entry of result.state.blobs) assert.equal(sha(Buffer.from(entry.base64, "base64")), entry.digest)
  assert.ok(result.state.blobs.some((entry: any) => entry.bytes === 0)); assert.ok(result.state.blobs.some((entry: any) => entry.digest === sha(binary)))
  assert.equal(JSON.stringify(result.state).includes("secret.txt"), false)
  assert.equal(result.state.scope.restore, "NOT_IMPLEMENTED")
})

test("CP03-1: copied artifact verifies after source and original backup are deleted, with no restore authority", async (t) => {
  const fx = await cleanGitFixture(t)
  await writeFile(join(fx.source, "binary.bin"), Buffer.from([0, 1, 255]))
  const exported = await exportGitWorktreeState(request(fx, ["binary.bin"]))
  const copied = join(fx.root, "copied-artifact")
  await cp(exported.artifactPath, copied, { recursive: true, errorOnExist: true })
  await rm(fx.source, { recursive: true, force: true }); await rm(exported.artifactPath, { recursive: true, force: true })
  const state = await verifyGitWorktreeState(verify(copied, exported.receiptDigest, fx.head))
  assert.equal(state.head, fx.head)
  assert.equal(state.scope.restore, "NOT_IMPLEMENTED")
  assert.equal((state as any).restoreHandle, undefined)
})

test("CP03-1: captures SHA-256 object IDs and native conflict stages which round-trip into an isolated Git index", async (t) => {
  const fx = await cleanGitFixture(t, "sha256")
  const blobs = [Buffer.from("base conflict\n"), Buffer.from("ours conflict\n"), Buffer.from("theirs conflict\n")]
  const ids: string[] = []
  for (const bytes of blobs) ids.push((await gitInput(fx.source, ["hash-object", "-w", "--stdin"], bytes)).trim())
  await gitInput(fx.source, ["update-index", "-z", "--index-info"], Buffer.from(ids.map((id, i) => `100644 ${id} ${i + 1}\tconflict.txt\0`).join("")))
  await writeFile(join(fx.source, "conflict.txt"), "working conflict\n")
  const exported = await exportGitWorktreeState(request(fx))
  assert.equal(exported.state.objectFormat, "sha256")
  const conflict = exported.state.index.filter(entry => entry.path === "conflict.txt").sort((a, b) => a.stage - b.stage)
  assert.deepEqual(conflict.map(entry => [entry.stage, entry.objectId]), [[1, ids[0]], [2, ids[1]], [3, ids[2]]])

  const scratch = join(fx.root, "scratch"), template = join(fx.root, "scratch-template")
  await Promise.all([mkdir(scratch), mkdir(template)]); await git(scratch, ["init", `--template=${template}`, "--object-format=sha256"])
  const byDigest = new Map(exported.state.blobs.map(blob => [blob.digest, Buffer.from(blob.base64, "base64")]))
  for (const entry of exported.state.index) {
    const bytes = byDigest.get(entry.blobDigest)!;
    const wrote = (await gitInput(scratch, ["hash-object", "-w", "--stdin"], bytes)).trim()
    assert.equal(wrote, entry.objectId)
  }
  await gitInput(scratch, ["update-index", "-z", "--index-info"], Buffer.from(exported.state.index.map(entry => `${entry.mode} ${entry.objectId} ${entry.stage}\t${entry.path}\0`).join("")))
  const native = (await git(scratch, ["ls-files", "--stage", "-z"])).stdout.split("\0").filter(Boolean).map(row => row.replace(/^([0-9]+) ([a-f0-9]+) ([0-3])\t(.+)$/u, "$4\t$3\t$1\t$2")).sort()
  const captured = exported.state.index.map(entry => `${entry.path}\t${entry.stage}\t${entry.mode}\t${entry.objectId}`).sort()
  assert.deepEqual(native, captured)
})

test("CP03-2: rejects unsafe Git states, selected paths, unsupported index flags, and incomplete operations", async (t) => {
  const cases: Array<[string, (fx: Awaited<ReturnType<typeof cleanGitFixture>>) => Promise<unknown>, string[]]> = [
    ["symlink", async fx => { await symlink("tracked.txt", join(fx.source, "bad-link")) }, ["bad-link"]],
    ["submodule-mode", async fx => { await git(fx.source, ["update-index", "--add", "--cacheinfo", `160000,${fx.head},submodule`]) }, []],
    ["merge", async fx => { await writeFile(join(fx.source, ".git", "MERGE_HEAD"), fx.head + "\n") }, []],
    ["rebase", async fx => { await mkdir(join(fx.source, ".git", "rebase-merge")) }, []],
  ]
  for (const [name, mutate, selected] of cases) {
    const fx = await cleanGitFixture(t); await mutate(fx)
    await assert.rejects(exportGitWorktreeState(request(fx, selected)), /symlink|mode|submodule|merge|rebase|unsupported|regular|in-progress/i, name)
  }
  const fx = await cleanGitFixture(t)
  await writeFile(join(fx.source, ".gitignore"), "ignored.txt\n"); await writeFile(join(fx.source, "ignored.txt"), "ignored")
  for (const selected of [["../escape"], ["ignored.txt"], [".git/config"]]) await assert.rejects(exportGitWorktreeState(request(fx, selected)), /unsafe|ignored|path|selected/i)
  await git(fx.source, ["update-index", "--skip-worktree", "tracked.txt"])
  await assert.rejects(exportGitWorktreeState(request(fx)), /skip|index|unsupported/i)
})

test("CP03-2: edited state bytes cannot inherit the original receipt pin", async (t) => {
  const fx = await cleanGitFixture(t); await writeFile(join(fx.source, "u.bin"), "payload")
  const exported = await exportGitWorktreeState(request(fx, ["u.bin"]))
  const stateText = await readFile(exported.statePath, "utf8")
  await writeFile(exported.statePath, stateText.replace("RAW_REGULAR_GIT_STATE_V1", "FORGED"))
  await assert.rejects(verifyGitWorktreeState(verify(exported.artifactPath, exported.receiptDigest, fx.head)), /digest|receipt|state|tamper/i)
})

test("CP03-2: verifier rejects wrong identity/head and an altered receipt", async (t) => {
  const fx = await cleanGitFixture(t); await writeFile(join(fx.source, "u.bin"), "payload")
  const exported = await exportGitWorktreeState(request(fx, ["u.bin"]))
  for (const input of [
    { ...verify(exported.artifactPath, exported.receiptDigest, fx.head), allowedOwnerNamespace: "urn:wrong:owner" },
    { ...verify(exported.artifactPath, exported.receiptDigest, fx.head), expectedWorktreeId: "wrong" },
    { ...verify(exported.artifactPath, exported.receiptDigest, fx.head), expectedHead: "0".repeat(40) },
  ]) await assert.rejects(verifyGitWorktreeState(input), /owner|repository|worktree|head|identity/i)
  const receipt = join(exported.artifactPath, "receipt.json"), receiptText = await readFile(receipt, "utf8")
  await writeFile(receipt, receiptText.replace("LOCAL_CAPTURE_ONLY", "FORGED"))
  await assert.rejects(verifyGitWorktreeState(verify(exported.artifactPath, exported.receiptDigest, fx.head)), /receipt|digest/i)
})
