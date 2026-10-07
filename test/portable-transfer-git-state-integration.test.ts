import assert from "node:assert/strict"
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { contractDigest } from "../src/contract-core.js"
import { parseResourceBindings } from "../src/resource-bindings.js"
import { recheckCleanGitRestore, gitTransferInternals } from "../src/addons/portable-transfer-git.js"
import { rebindCleanGitRestore } from "../src/addons/portable-transfer-git-bindings.js"
import { exportGitWorktreeState } from "../src/addons/portable-transfer-git-state.js"
import { importGitWorktreeState, recheckGitStateRestore, gitStateRevisionId } from "../src/addons/portable-transfer-git-state-restore.js"
import { rebindGitStateRestore } from "../src/addons/portable-transfer-git-state-bindings.js"
import { prepareCheckoutGuard, recheckCheckoutGuard } from "../src/addons/checkout-guard.js"
import { byteDigest, cleanGitFixture, gitFixtureCommand as git } from "./clean-git-fixture.js"

const owner = "urn:example:owner", dirty = Buffer.from("working B\n")
const capture = (f: Awaited<ReturnType<typeof cleanGitFixture>>) => ({ schema: "usl-git-state-export/v1", sourceRoot: f.source, destinationParent: f.backup,
  ownerNamespace: owner, repositoryId: "repo", worktreeId: "main", issuer: "urn:example:issuer", observedAt: "2026-10-07T00:00:00Z", expectedHead: f.head, expectedObjectFormat: "sha1", selectedUntracked: [] })
async function fixture(t: TestContext) {
  const f = await cleanGitFixture(t)
  await writeFile(join(f.source, "note.txt"), "staged A\n"); git(f.source, "add", "note.txt"); await writeFile(join(f.source, "note.txt"), dirty)
  const state = await exportGitWorktreeState(capture(f))
  const selection = { resource: "memory", bindingRepresentation: "memory-local", nativeId: "memory", revisionId: gitStateRevisionId(state.receiptDigest), representationId: "memory-original", worktreeId: "main" }
  const request = { schema: "usl-git-state-import/v1", bundlePath: f.exported.bundlePath, expectedReceiptDigest: f.exported.receiptDigest,
    allowedOwnerNamespace: owner, expectedRepositoryId: "repo", destinationParent: f.output, destinationName: "restored", freshnessMode: "LOCAL_BRANCH",
    worktrees: [{ worktreeId: "main", path: "main", head: f.head, branch: "refs/heads/main", artifactPath: state.artifactPath, expectedStateReceiptDigest: state.receiptDigest }],
    files: [{ nativeId: selection.nativeId, revisionId: selection.revisionId, representationId: selection.representationId, worktreeId: "main", path: "note.txt", expectedByteDigest: byteDigest(dirty), expectedByteLength: dirty.length }],
  }
  return { ...f, state, selection, request }
}
const bindings = () => parseResourceBindings({ schema: "usl-resource-bindings/v1", resources: [
  { id: "memory", representations: [{ id: "memory-local", kind: "workspace", workspace: "old", path: "old.txt", relation: "working-copy", digest: byteDigest(dirty) }] },
  { id: "source", representations: [{ id: "source-web", kind: "locator", relation: "documentation", locator: "https://example.invalid/source" }] },
] })
const graph = { schema: "usl-resource-graph/v1", resources: [
  { id: "memory", types: ["urn:example:Memory"], locator: "https://example.invalid/memory" },
  { id: "source", types: ["urn:example:Source"], locator: "https://example.invalid/source" },
  { id: "read", types: ["http://www.w3.org/ns/prov#Activity"], locator: "https://example.invalid/read" },
  { id: "owner", types: ["http://www.w3.org/ns/prov#Agent"], locator: "https://example.invalid/owner" },
], meanings: [{ id: "cites", description: "Memory cites source" }], links: [
  { id: "citation", meaning: "cites", participants: [{ role: "memory", resource: "memory" }, { role: "source", resource: "source" }] },
], provenance: { sources: ["source"], activity: "read", agent: "owner" } }

test("CP03-1: restored dirty bytes rebind stable resource IDs and ordered roles with a distinct state revision", async t => {
  const f = await fixture(t), result = await importGitWorktreeState(f.request)
  await rm(f.source, { recursive: true }); await rm(f.backup, { recursive: true })
  const original = bindings(), proposal = await rebindGitStateRestore(result, { bindings: original, selections: [f.selection], workspaceId: "moved", graph: JSON.stringify(graph), hostname: "fixture-host" })
  assert.deepEqual(proposal.graph!.links, graph.links)
  assert.deepEqual(proposal.graph!.meanings, graph.meanings)
  assert.deepEqual(proposal.graph!.provenance, graph.provenance)
  assert.deepEqual(proposal.graph!.resources.map(r => r.id), graph.resources.map(r => r.id))
  assert.deepEqual(proposal.bindings.resources[1], original.resources[1])
  assert.equal(proposal.bindings.resources[0]!.representations[0]!.id, "memory-local")
  assert.equal(proposal.workspaces.moved, join(result.destinationPath, "worktrees/main"))
  assert.equal(proposal.freshness, "PINNED_STATE_SNAPSHOT")
  assert.deepEqual(proposal.stateReceipts, result.stateReceipts)
  assert.notEqual(result.files[0]!.revisionId, f.head)
  assert.equal(result.files[0]!.parentHead, f.head)
  assert.equal(proposal.authority, "NOT_GRANTED"); assert.equal(proposal.registration, "LOCAL_PROPOSAL_ONLY"); assert.equal(proposal.execution, "NOT_REQUESTED")
  const main = join(result.destinationPath, "worktrees/main")
  const host = { workspaces: proposal.workspaces, checkouts: { checkout: { workspace: "moved", root: main } } }
  const prepared = await prepareCheckoutGuard(proposal.bindings, { resource: "memory", representation: "memory-local" }, {
    resource: "memory", representation: "memory-local", checkoutId: "checkout", expectedHead: { kind: "COMMIT", value: f.head }, dirtyPolicy: "ALLOW_DIRTY",
  }, host)
  assert.equal(prepared.report.status, "PASS", JSON.stringify(prepared.report))
  await writeFile(join(main, "note.txt"), "different working bytes\n")
  assert.equal((await recheckCheckoutGuard(prepared, host)).status, "HOLD")
})

test("CP03-1: multi-worktree restores keep staged deletion, working deletion, rename and detached state separate", async t => {
  const f = await fixture(t), otherRoot = join(f.root, "other-source")
  git(f.source, "worktree", "add", "--detach", otherRoot, f.head)
  git(otherRoot, "mv", "note.txt", "renamed.txt")
  await rm(join(otherRoot, "run.sh"))
  await writeFile(join(otherRoot, "renamed.txt"), "other dirty\n")
  const other = await exportGitWorktreeState({ ...capture(f), sourceRoot: otherRoot, worktreeId: "other" })
  const result = await importGitWorktreeState({ ...f.request, worktrees: [...f.request.worktrees,
    { worktreeId: "other", path: "other", head: f.head, artifactPath: other.artifactPath, expectedStateReceiptDigest: other.receiptDigest }], files: [...f.request.files,
    { ...f.request.files[0], representationId: "other-original", worktreeId: "other", revisionId: gitStateRevisionId(other.receiptDigest), path: "renamed.txt", expectedByteDigest: byteDigest(Buffer.from("other dirty\n")), expectedByteLength: 12 }],
  })
  const main = join(result.destinationPath, "worktrees/main"), second = join(result.destinationPath, "worktrees/other")
  assert.equal(git(main, "symbolic-ref", "HEAD"), "refs/heads/main")
  assert.throws(() => git(second, "symbolic-ref", "HEAD"))
  assert.equal(git(second, "rev-parse", "HEAD"), f.head)
  assert.equal(await readFile(join(main, "note.txt"), "utf8"), dirty.toString())
  assert.equal(await readFile(join(second, "renamed.txt"), "utf8"), "other dirty\n")
  await assert.rejects(stat(join(second, "note.txt")), { code: "ENOENT" }); await assert.rejects(stat(join(second, "run.sh")), { code: "ENOENT" })
  assert.equal(git(second, "ls-files", "--stage", "-z"), other.state.index.map(e => `${e.mode} ${e.objectId} ${e.stage}\t${e.path}\0`).join(""))
  const docs = parseResourceBindings({ schema: "usl-resource-bindings/v1", resources: [...bindings().resources,
    { id: "other-memory", representations: [{ id: "other-local", kind: "workspace", workspace: "old-other", path: "note.txt", relation: "working-copy" }] }],
  })
  const proposal = await rebindGitStateRestore(result, { bindings: docs, selections: [f.selection, { ...f.selection, resource: "other-memory", bindingRepresentation: "other-local", representationId: "other-original", worktreeId: "other", revisionId: gitStateRevisionId(other.receiptDigest) }], workspaces: { main: "main-restored", other: "other-restored" } })
  assert.deepEqual(Object.values(proposal.workspaces).sort(), [main, second].sort())
})

test("CP03-2: stale, serialized, cross-profile and wrong-revision handles cannot update a binding", async t => {
  const f = await fixture(t), result = await importGitWorktreeState(f.request), input = { bindings: bindings(), selections: [f.selection], workspaceId: "moved" }
  await assert.rejects(rebindGitStateRestore(structuredClone(result), input), /handle/u)
  await assert.rejects(recheckCleanGitRestore(result), /handle/u)
  await assert.rejects(rebindCleanGitRestore(result as any, input), /handle/u)
  await assert.rejects(rebindGitStateRestore(result, { ...input, selections: [{ ...f.selection, revisionId: f.head }] }), /identity/u)
  let invoked = 0
  await assert.rejects(rebindGitStateRestore({ get stateReceipts() { invoked++; return [] } } as any, input), /handle/u)
  assert.equal(invoked, 0)
  const pending = rebindGitStateRestore(result, input)
  input.selections[0] = { ...f.selection, worktreeId: "changed" }
  assert.equal((await pending).selections[0]!.worktreeId, "main")
  const main = join(result.destinationPath, "worktrees/main")
  git(main, "read-tree", f.head) // working bytes unchanged, but staged A was discarded
  assert.deepEqual(await readFile(join(main, "note.txt")), dirty)
  await assert.rejects(recheckGitStateRestore(result), /stale|changed/u)
  await assert.rejects(rebindGitStateRestore(result, { ...input, selections: [f.selection] }), /stale|changed/u)
})

test("CP03-2: state and history mismatches fail before publication even with a fully rehashed receipt", async t => {
  const f = await fixture(t), original = JSON.parse(await readFile(f.state.statePath, "utf8"))
  for (const mutate of [(s: any) => { s.headTree[0].objectId = "b".repeat(40) }, (s: any) => { s.headTree.pop() }]) {
    const forged = structuredClone(original); mutate(forged)
    const stateBytes = Buffer.from(JSON.stringify(forged) + "\n")
    const receiptBytes = Buffer.from(JSON.stringify({ schema: "usl-git-state-receipt/v1", stateDigest: contractDigest(forged), stateByteDigest: byteDigest(stateBytes), bytes: stateBytes.length, execution: "LOCAL_CAPTURE_ONLY" }) + "\n")
    await writeFile(f.state.statePath, stateBytes); await writeFile(join(f.state.artifactPath, "receipt.json"), receiptBytes)
    await assert.rejects(importGitWorktreeState({ ...f.request, files: [], worktrees: [{ ...f.request.worktrees[0], expectedStateReceiptDigest: byteDigest(receiptBytes) }] }), /HEAD tree/u)
    assert.deepEqual(await readdir(f.output), [])
  }
})

test("CP03-2: budgets and explicit selection pins prevent partial or misidentified state restores", async t => {
  const f = await fixture(t)
  for (const request of [
    { ...f.request, maxStateBytes: 1 }, { ...f.request, maxStateEntries: 1 }, { ...f.request, maxCheckoutBytes: 1 }, { ...f.request, maxDurationMs: 1 },
    { ...f.request, files: [{ ...f.request.files[0], expectedByteDigest: "sha256:" + "0".repeat(64) }] },
    { ...f.request, files: [{ ...f.request.files[0], revisionId: "urn:usl:git-state:" + "0".repeat(64) }] },
    { ...f.request, files: [{ ...f.request.files[0], path: "absent.txt" }] },
    { ...f.request, expectedRepositoryId: "wrong" },
    { ...f.request, worktrees: [{ ...f.request.worktrees[0], branch: "refs/heads/other" }] },
    { ...f.request, worktrees: [{ ...f.request.worktrees[0], head: "a".repeat(40) }] },
  ]) { await assert.rejects(importGitWorktreeState(request)); assert.deepEqual(await readdir(f.output), []) }
})

test("CP03-2: one destination reservation wins, existing data remains intact and metadata edits stale the restore", async t => {
  const f = await fixture(t)
  const attempts = await Promise.allSettled([importGitWorktreeState(f.request), importGitWorktreeState(f.request)])
  assert.equal(attempts.filter(a => a.status === "fulfilled").length, 1)
  const result = attempts.find(a => a.status === "fulfilled")!.value
  const sentinel = join(result.destinationPath, "keep.txt"); await writeFile(sentinel, "existing data\n")
  await assert.rejects(importGitWorktreeState(f.request))
  assert.equal(await readFile(sentinel, "utf8"), "existing data\n")
  await assert.rejects(recheckGitStateRestore(result), /stale|changed/u)
  await rm(sentinel)
  await recheckGitStateRestore(result)
  await writeFile(join(result.repositoryPath, "config"), "[core]\nrepositoryformatversion = 0\nbare = true\n[alias]\npwn = !exit 1\n")
  await assert.rejects(recheckGitStateRestore(result), /stale|changed/u)
})

test("CP03-2: internal overlay integrity cannot mint a verified CP03 state or clean binding handle", async t => {
  const f = await fixture(t)
  const raw = await gitTransferInternals.importWithOverlay({ ...f.request, schema: "usl-clean-git-import/v1", files: [],
    worktrees: f.request.worktrees.map(({ worktreeId, path, head, branch }) => ({ worktreeId, path, head, branch })),
  }, { maxExtraBytes: 1024, deadline: Date.now() + 60_000, async apply({ stage }) {
    await writeFile(join(stage, "worktrees/main/injected.txt"), "not a verified state\n")
    return { unverifiedOverlay: true }
  } })
  await gitTransferInternals.recheckOverlayIntegrity(raw)
  await assert.rejects(recheckGitStateRestore(raw), /handle/u)
  await assert.rejects(recheckCleanGitRestore(raw), /handle/u)
  await assert.rejects(rebindGitStateRestore(raw as any, { bindings: bindings(), selections: [f.selection], workspaceId: "moved" }), /handle/u)
})
