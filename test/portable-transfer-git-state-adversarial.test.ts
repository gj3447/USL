import assert from "node:assert/strict"
import { watch } from "node:fs"
import { chmod, cp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { contractDigest } from "../src/contract-core.js"
import { exportGitWorktreeState, verifyGitWorktreeState } from "../src/addons/portable-transfer-git-state.js"
import { byteDigest, cleanGitFixture, gitFixtureCommand as git } from "./clean-git-fixture.js"

type Fixture = Awaited<ReturnType<typeof cleanGitFixture>>
const request = (f: Fixture, selectedUntracked: string[] = []) => ({ schema: "usl-git-state-export/v1", sourceRoot: f.source, destinationParent: f.output,
  ownerNamespace: "urn:example:owner", repositoryId: "repo", worktreeId: "main", issuer: "urn:example:issuer", observedAt: "2026-10-06T00:00:00Z",
  expectedHead: f.head, expectedObjectFormat: "sha1", selectedUntracked })
const verification = (f: Fixture, exported: Awaited<ReturnType<typeof exportGitWorktreeState>>) => ({ schema: "usl-git-state-verify/v1", artifactPath: exported.artifactPath,
  expectedReceiptDigest: exported.receiptDigest, expectedHead: f.head, allowedOwnerNamespace: "urn:example:owner", expectedRepositoryId: "repo", expectedWorktreeId: "main" })

test("CP03-1: working deletion, executable mode divergence, detached worktree and index v4 stay distinct", async t => {
  const f = await cleanGitFixture(t)
  const linked = join(f.root, "linked")
  git(f.source, "worktree", "add", "--detach", linked, f.head)
  await rm(join(linked, "note.txt"))
  await chmod(join(linked, "run.sh"), 0o600)
  git(linked, "update-index", "--index-version=4")
  const captured = await exportGitWorktreeState({ ...request(f), sourceRoot: linked })
  assert.equal(captured.state.branch, null)
  assert.equal(captured.state.indexObservation.version, 4)
  assert.equal(captured.state.index.find(x => x.path === "run.sh")?.mode, "100755")
  const working = captured.state.working.find(x => x.path === "run.sh")!
  assert.equal(working.kind, "REGULAR")
  if (working.kind === "REGULAR") assert.equal(working.mode, "100644")
  assert.deepEqual(captured.state.working.find(x => x.path === "note.txt"), { path: "note.txt", kind: "ABSENT" })
  await rm(f.source, { recursive: true }); await rm(linked, { recursive: true })
  assert.deepEqual(await verifyGitWorktreeState(verification(f, captured)), captured.state)
})

test("CP03-1: binary state above four MiB verifies within an explicit budget without disclosing unselected bytes", async t => {
  const f = await cleanGitFixture(t), bytes = Buffer.alloc(4 * 1024 * 1024 + 17, 0xa7)
  await writeFile(join(f.source, "large.bin"), bytes)
  await writeFile(join(f.source, ".env"), "not-collected-secret")
  const captured = await exportGitWorktreeState({ ...request(f, ["large.bin"]), maxBytes: 5 * 1024 * 1024 })
  assert.ok(captured.state.blobs.some(b => b.digest === byteDigest(bytes) && b.bytes === bytes.length))
  const raw = await readFile(captured.statePath, "utf8")
  assert.ok(!raw.includes(f.root) && !raw.includes("not-collected-secret") && !raw.includes(".env"))
  assert.deepEqual(await verifyGitWorktreeState({ ...verification(f, captured), maxBytes: 5 * 1024 * 1024 }), captured.state)
  await assert.rejects(verifyGitWorktreeState({ ...verification(f, captured), maxBytes: 1024 }))
})

test("CP03-2: intent-to-add, assume flags, attributes, LFS and special selections HOLD without publication", async t => {
  const cases: ((f: Fixture) => Promise<string[]>)[] = [
    async f => { await writeFile(join(f.source, "intent.txt"), "intent"); git(f.source, "add", "-N", "intent.txt"); return [] },
    async f => { git(f.source, "update-index", "--assume-unchanged", "note.txt"); return [] },
    async f => { await writeFile(join(f.source, ".gitattributes"), "*.txt text\n"); git(f.source, "add", ".gitattributes"); return [] },
    async f => { await writeFile(join(f.source, "note.txt"), "version https://git-lfs.github.com/spec/v1\noid sha256:" + "a".repeat(64) + "\nsize 20\n"); return [] },
    async f => { await mkdir(join(f.source, "directory")); return ["directory"] },
    async f => { await symlink(f.output, join(f.source, "alias")); return ["alias/outside"] },
    async f => { await writeFile(join(f.source, ".env"), "private"); return [".env"] },
    async f => { git(f.source, "config", "core.sparseCheckout", "true"); return [] },
  ]
  for (const prepare of cases) {
    const f = await cleanGitFixture(t), selected = await prepare(f)
    await assert.rejects(exportGitWorktreeState(request(f, selected)))
    assert.deepEqual(await readdir(f.output), [])
  }
})

test("CP03-2: state changes during capture and exhausted budgets leave no artifact or source edits", async t => {
  const f = await cleanGitFixture(t)
  const beforeIndex = await readFile(join(f.source, ".git", "index"))
  await assert.rejects(exportGitWorktreeState({ ...request(f), maxBytes: 1 }))
  await assert.rejects(exportGitWorktreeState({ ...request(f), maxEntries: 1 }))
  await assert.rejects(exportGitWorktreeState({ ...request(f), maxDurationMs: 1 }))
  assert.deepEqual(await readFile(join(f.source, ".git", "index")), beforeIndex)
  let changed: Promise<void> | undefined
  const watcher = watch(f.output, (_event, name) => {
    if (name?.startsWith(".usl-git-state-stage-") && !changed) changed = writeFile(join(f.source, "note.txt"), "changed after observation\n")
  })
  try { await assert.rejects(exportGitWorktreeState(request(f)), /source changed/u) } finally { watcher.close(); await changed }
  assert.ok(changed)
  assert.deepEqual(await readdir(f.output), [])
  assert.equal(await readFile(join(f.source, "note.txt"), "utf8"), "changed after observation\n")
})

test("CP03-2: rehashed receipts cannot validate missing blobs, incorrect native OIDs, mixed stages or broader scope", async t => {
  const f = await cleanGitFixture(t), exported = await exportGitWorktreeState(request(f))
  const original = JSON.parse(await readFile(exported.statePath, "utf8"))
  const mutations: ((s: typeof original) => void)[] = [
    s => { const bytes = Buffer.from("unselected private bytes"); s.blobs.push({ digest: byteDigest(bytes), bytes: bytes.length, base64: bytes.toString("base64") }) },
    s => { s.blobs = [] },
    s => { s.index[0].objectId = "a".repeat(40) },
    s => { s.index.push({ ...s.index[0], stage: 1 }) },
    s => { s.working.pop() },
    s => { s.scope.restore = "FULL_WORKSPACE" },
    s => { s.index.push({ ...s.index[0] }) },
  ]
  for (let i = 0; i < mutations.length; i++) {
    const artifactPath = join(f.root, `forged-${i}`)
    await cp(exported.artifactPath, artifactPath, { recursive: true })
    const state = structuredClone(original); mutations[i]!(state)
    const stateBytes = Buffer.from(JSON.stringify(state) + "\n")
    const receipt = Buffer.from(JSON.stringify({ schema: "usl-git-state-receipt/v1", stateDigest: contractDigest(state), stateByteDigest: byteDigest(stateBytes), bytes: stateBytes.length, execution: "LOCAL_CAPTURE_ONLY" }) + "\n")
    await writeFile(join(artifactPath, "state.json"), stateBytes); await writeFile(join(artifactPath, "receipt.json"), receipt)
    await assert.rejects(verifyGitWorktreeState({ ...verification(f, exported), artifactPath, expectedReceiptDigest: byteDigest(receipt) }))
  }
  await writeFile(join(exported.artifactPath, "extra"), "unselected")
  await assert.rejects(verifyGitWorktreeState(verification(f, exported)), /unexpected artifact/u)
})

test("CP03-2: path collisions, stale independent pins and input mutation cannot broaden selected capture", async t => {
  const f = await cleanGitFixture(t)
  await writeFile(join(f.source, "Case.txt"), "case"); await writeFile(join(f.source, "case.txt"), "other")
  await assert.rejects(exportGitWorktreeState(request(f, ["Case.txt", "case.txt"])), /collision/u)
  await assert.rejects(exportGitWorktreeState({ ...request(f), expectedHead: "a".repeat(40) }), /pin/u)
  await assert.rejects(exportGitWorktreeState({ ...request(f), expectedObjectFormat: "sha256" }), /pin/u)
  const input = request(f, ["Case.txt"]), captured = exportGitWorktreeState(input)
  input.selectedUntracked.push("case.txt"); input.expectedHead = "b".repeat(40)
  const result = await captured
  assert.deepEqual(result.state.selectedUntracked, ["Case.txt"])
  const invalid = { ...request(f), get issuer() { throw new Error("accessor executed") } }
  await assert.rejects(exportGitWorktreeState(invalid), /accessor/iu)
})
