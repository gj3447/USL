import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { exportCleanGitTransfer, importCleanGitTransfer } from "../src/addons/portable-transfer-git.js"
import { rebindCleanGitRestore } from "../src/addons/portable-transfer-git-bindings.js"
import { parseResourceBindings } from "../src/resource-bindings.js"
import { prepareCheckoutGuard, recheckCheckoutGuard } from "../src/addons/checkout-guard.js"

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8", env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: ["ignore", "pipe", "pipe"] }).trim()
const contents = Buffer.from("stable memory\n"), digest = "sha256:" + createHash("sha256").update(contents).digest("hex")
const graph = { schema: "usl-resource-graph/v1", resources: [
  { id: "memory", types: ["urn:example:Memory"], locator: "https://example.invalid/memory", metadata: { owner: "owner" } },
  { id: "source", types: ["urn:example:Source"], locator: "https://example.invalid/source" },
  { id: "read", types: ["http://www.w3.org/ns/prov#Activity"], locator: "https://example.invalid/read" },
  { id: "owner", types: ["http://www.w3.org/ns/prov#Agent"], locator: "https://example.invalid/owner" },
], meanings: [{ id: "cites", description: "Memory cites source" }], links: [
  { id: "citation", meaning: "cites", participants: [{ role: "memory", resource: "memory" }, { role: "source", resource: "source" }] },
], provenance: { sources: ["source"], activity: "read", agent: "owner" } }
const bindings = (relation: "snapshot" | "working-copy" = "snapshot") => parseResourceBindings({ schema: "usl-resource-bindings/v1", resources: [
  { id: "memory", representations: [{ id: "memory-local", kind: "workspace", workspace: "old", path: "old.md", relation, digest }] },
  { id: "source", representations: [{ id: "source-url", kind: "locator", relation: "documentation", locator: "https://example.invalid/source" }] },
] })
async function fixture(t: TestContext, freshnessMode: "HISTORICAL_SNAPSHOT" | "LOCAL_BRANCH" = "HISTORICAL_SNAPSHOT", multiple = false) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "usl-cp02-bindings-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, "source"), backup = join(root, "backup"), output = join(root, "output")
  await Promise.all([mkdir(source), mkdir(backup), mkdir(output)])
  git(source, "init", "--initial-branch=main")
  await writeFile(join(source, "memory.md"), contents)
  git(source, "add", "memory.md")
  git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture")
  const head = git(source, "rev-parse", "HEAD")
  const exported = await exportCleanGitTransfer({ schema: "usl-clean-git-export/v1", sourceRoot: source, destinationParent: backup,
    ownerNamespace: "urn:example:owner", repositoryId: "repo", worktreeId: "main", expectedHead: head, expectedRefs: { "refs/heads/main": head }, expectedObjectFormat: "sha1", issuer: "urn:example:issuer", observedAt: "2026-10-05T00:00:00Z" })
  await rm(source, { recursive: true })
  const selection = { resource: "memory", bindingRepresentation: "memory-local", nativeId: "native-memory", revisionId: head, representationId: "original-representation", worktreeId: "main" }
  const restored = await importCleanGitTransfer({ schema: "usl-clean-git-import/v1", bundlePath: exported.bundlePath,
    destinationParent: output, destinationName: "restore", expectedReceiptDigest: exported.receiptDigest, allowedOwnerNamespace: "urn:example:owner", expectedRepositoryId: "repo", freshnessMode,
    worktrees: [{ worktreeId: "main", path: "main", head, branch: "refs/heads/main" }, ...(multiple ? [{ worktreeId: "other", path: "other", head }] : [])],
    files: [{ nativeId: selection.nativeId, revisionId: head, representationId: selection.representationId, worktreeId: "main", path: "memory.md", expectedByteDigest: digest, expectedByteLength: contents.length },
      ...(multiple ? [{ nativeId: selection.nativeId, revisionId: head, representationId: "other-representation", worktreeId: "other", path: "memory.md", expectedByteDigest: digest, expectedByteLength: contents.length }] : [])],
  })
  await rm(backup, { recursive: true })
  return { restored, selection }
}

test("CP02-1: Git restore rebinds selected IDs and ordered roles after source and backup deletion", async t => {
  const { restored, selection } = await fixture(t)
  const original = bindings()
  const result = await rebindCleanGitRestore(restored, { bindings: original, selections: [selection], workspaceId: "restored", graph: JSON.stringify(graph), hostname: "fixture-host" })
  assert.deepEqual(result.graph!.links, graph.links)
  assert.deepEqual(result.graph!.meanings, graph.meanings)
  assert.deepEqual(result.graph!.provenance, graph.provenance)
  assert.deepEqual(result.graph!.resources.map(x => x.id), graph.resources.map(x => x.id))
  assert.deepEqual(result.graph!.resources[0]!.metadata, graph.resources[0]!.metadata)
  assert.equal(result.graph!.resources[0]!.locator, `file://fixture-host${restored.destinationPath}/worktrees/main/memory.md`)
  assert.deepEqual(result.bindings.resources[1], original.resources[1])
  assert.equal(result.bindings.resources[0]!.representations[0]!.id, "memory-local")
  assert.equal(result.registration, "LOCAL_PROPOSAL_ONLY")
  assert.equal(result.authority, "NOT_GRANTED")
  assert.equal(result.execution, "NOT_REQUESTED")
})

test("CP02-2: forged, stale and mismatched Git restore handles cannot produce bindings", async t => {
  const { restored, selection } = await fixture(t)
  const request = { bindings: bindings(), selections: [selection], workspaceId: "restored" }
  await assert.rejects(rebindCleanGitRestore(structuredClone(restored), request), /handle/)
  await assert.rejects(rebindCleanGitRestore(restored, { ...request, selections: [{ ...selection, worktreeId: "other" }] }), /identity/)
  const bad = structuredClone(bindings()) as any; bad.resources[0].representations[0].digest = "sha256:" + "0".repeat(64)
  await assert.rejects(rebindCleanGitRestore(restored, { ...request, bindings: bad }), /digest/)
  await writeFile(join(restored.destinationPath, "worktrees/main/memory.md"), "edited\n")
  await assert.rejects(rebindCleanGitRestore(restored, request), /changed|stale/)
})

test("CP02-2: binding inputs are captured, unselected workspaces stay intact, and branch mode is explicit", async t => {
  const { restored, selection } = await fixture(t, "LOCAL_BRANCH")
  const request = { bindings: bindings("working-copy"), selections: [{ ...selection }], workspaceId: "new" }
  const pending = rebindCleanGitRestore(restored, request)
  request.selections[0]!.worktreeId = "changed"
  assert.equal((await pending).selections[0]!.worktreeId, "main")
  const colliding = structuredClone(bindings("working-copy")) as any
  colliding.resources.push({ id: "unselected", representations: [{ id: "unselected-local", kind: "workspace", workspace: "new", path: "elsewhere", relation: "snapshot" }] })
  await assert.rejects(rebindCleanGitRestore(restored, { bindings: colliding, selections: [selection], workspaceId: "new" }), /unselected/)
  await assert.rejects(rebindCleanGitRestore(restored, { bindings: bindings("snapshot"), selections: [selection], workspaceId: "new" }), /working-copy/)
})

test("CP02-2: restored binding uses the existing checkout guard and holds stale HEAD before an owner action", async t => {
  const { restored, selection } = await fixture(t, "LOCAL_BRANCH")
  const proposal = await rebindCleanGitRestore(restored, { bindings: bindings("working-copy"), selections: [selection], workspaceId: "restored" })
  const main = join(restored.destinationPath, "worktrees/main")
  const host = { workspaces: proposal.workspaces, checkouts: { checkout: { workspace: "restored", root: main } } }
  const prepared = await prepareCheckoutGuard(proposal.bindings, { resource: "memory", representation: "memory-local" }, {
    resource: "memory", representation: "memory-local", checkoutId: "checkout", expectedHead: { kind: "COMMIT", value: selection.revisionId }, dirtyPolicy: "REQUIRE_CLEAN",
  }, host)
  assert.equal(prepared.report.status, "PASS", JSON.stringify(prepared.report))
  git(main, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "same bytes different HEAD")
  const check = await recheckCheckoutGuard(prepared, host)
  let actions = 0
  if (check.status === "PASS") actions++
  assert.equal(check.status, "HOLD")
  assert.equal(actions, 0)
})

test("CP02-1: multiple worktrees retain separate explicit workspace roots and representation identities", async t => {
  const { restored, selection } = await fixture(t, "LOCAL_BRANCH", true)
  const document = parseResourceBindings({ schema: "usl-resource-bindings/v1", resources: [...bindings("working-copy").resources,
    { id: "other-memory", representations: [{ id: "other-local", kind: "workspace", workspace: "old-other", path: "old.md", relation: "working-copy", digest }] },
  ] })
  const other = { ...selection, resource: "other-memory", bindingRepresentation: "other-local", worktreeId: "other", representationId: "other-representation" }
  const input = { bindings: document, selections: [selection, other], workspaces: { main: "main-restored", other: "other-restored" } }
  const result = await rebindCleanGitRestore(restored, input)
  assert.equal(result.workspaces["main-restored"], join(restored.destinationPath, "worktrees/main"))
  assert.equal(result.workspaces["other-restored"], join(restored.destinationPath, "worktrees/other"))
  assert.equal(result.bindings.resources[0]!.representations[0]!.id, "memory-local")
  assert.equal(result.bindings.resources[2]!.representations[0]!.id, "other-local")
  await assert.rejects(rebindCleanGitRestore(restored, { bindings: document, selections: [selection, other], workspaceId: "ambiguous" }), /multiple worktrees/)
  await assert.rejects(rebindCleanGitRestore(restored, { ...input, workspaces: { main: "same", other: "same" } }), /unique workspace/)
})
