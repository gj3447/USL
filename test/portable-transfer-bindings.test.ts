import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { exportPortableTransfer } from "../src/addons/portable-transfer-export.js"
import { importPortableTransfer } from "../src/addons/portable-transfer-import.js"
import { rebindPortableRestore } from "../src/addons/portable-transfer-bindings.js"
import { parseResourceBindings } from "../src/resource-bindings.js"

const original = Buffer.from("원래 메모리\n")
const originalDigest = `sha256:${createHash("sha256").update(original).digest("hex")}`
const graph = {
  schema: "usl-resource-graph/v1", resources: [
    { id: "note", types: ["urn:example:Memory"], locator: "https://old.example/note", metadata: { owner: "notes" } },
    { id: "source", types: ["urn:example:Document"], locator: "https://source.example/paper" },
    { id: "urn:example:read", types: ["http://www.w3.org/ns/prov#Activity"], locator: "https://notes.example/read" },
    { id: "urn:example:owner", types: ["http://www.w3.org/ns/prov#Agent"], locator: "https://notes.example/owner" },
  ], meanings: [{ id: "cites", description: "Memory cites its source" }], links: [
    { id: "note-source", meaning: "cites", participants: [{ role: "memory", resource: "note" }, { role: "source", resource: "source" }] },
  ], provenance: { sources: ["source"], activity: "urn:example:read", agent: "urn:example:owner" },
}
const selection = { resource: "note", bindingRepresentation: "note-local", nativeId: "원본 메모", revisionId: "urn:example:revision:note", representationId: "urn:example:representation:note" }
const bindings = (relation: "snapshot" | "working-copy" = "snapshot") => parseResourceBindings({ schema: "usl-resource-bindings/v1", resources: [
  { id: "note", representations: [{ id: "note-local", kind: "workspace", workspace: "old", path: "old-note.md", relation, digest: originalDigest }] },
  { id: "source", representations: [{ id: "paper-url", kind: "locator", relation: "documentation", locator: "https://source.example/paper" }] },
] })

async function fixture(t: TestContext, localBranch = false) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "usl-restore-bindings-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourceRoot = join(root, "source"), backupParent = join(root, "backups"), destinationParent = join(root, "destination")
  await Promise.all([mkdir(sourceRoot), mkdir(backupParent), mkdir(destinationParent)])
  await writeFile(join(sourceRoot, "메모.md"), original)
  const exported = await exportPortableTransfer({
    schema: "usl-portable-transfer-export/v1", sourceRoot, destinationParent: backupParent,
    ownerNamespace: "urn:example:notes", issuer: "urn:example:owner", observedAt: "2026-10-04T00:00:00Z",
    owner: { snapshotId: "notes-snapshot", assertConsistent() {} }, restoreProfile: "PINNED_FILES",
    files: [{ sourcePath: "메모.md", payloadPath: "note.bin", nativeId: selection.nativeId, revisionId: selection.revisionId,
      representationId: selection.representationId, expectedByteDigest: originalDigest, expectedByteLength: original.length }],
  })
  const restored = await importPortableTransfer({
    schema: "usl-portable-transfer-import/v1", bundlePath: exported.bundlePath, destinationParent, destinationName: "notes-restored",
    expectedReceiptDigest: exported.receiptDigest, allowedOwnerNamespace: "urn:example:notes",
    ...(localBranch ? { freshnessMode: "LOCAL_BRANCH" as const, localBranchId: "notes-offline-branch" } : {}),
  })
  return { root, sourceRoot, exported, restored }
}

test("PT03-C1: verified restore rebinds only selected locators and preserves graph identities and ordered roles without the original source", async t => {
  const fx = await fixture(t)
  await rm(fx.sourceRoot, { recursive: true })
  await rm(fx.exported.bundlePath, { recursive: true })
  const document = bindings(), result = await rebindPortableRestore(fx.restored, {
    bindings: document, selections: [selection], workspaceId: "restored", graph: JSON.stringify(graph), hostname: "restore-host",
  })
  assert.deepEqual(result.graph!.links, graph.links)
  assert.deepEqual(result.graph!.meanings, graph.meanings)
  assert.deepEqual(result.graph!.provenance, graph.provenance)
  assert.deepEqual(result.graph!.resources.map(item => item.id), graph.resources.map(item => item.id))
  assert.deepEqual(result.graph!.resources[0]!.metadata, graph.resources[0]!.metadata)
  assert.deepEqual(result.graph!.resources[1], graph.resources[1])
  assert.equal(result.graph!.resources[0]!.locator, `file://restore-host${join(fx.restored.destinationPath, "메모.md")}`)
  assert.deepEqual(result.bindings.resources[1], document.resources[1])
  assert.equal(result.bindings.resources[0]!.representations[0]!.id, "note-local")
  assert.equal(result.bindings.resources[0]!.representations[0]!.relation, "snapshot")
  assert.equal(result.workspaces.restored, fx.restored.destinationPath)
  assert.equal(result.registration, "LOCAL_PROPOSAL_ONLY")
  assert.equal(result.authority, "NOT_GRANTED")
  assert.equal(result.execution, "NOT_REQUESTED")
  assert.deepEqual(await readFile(join(fx.restored.destinationPath, "메모.md")), original)
})

test("PT03-C1: rebinding rejects forged handles, changed restored bytes and mismatched explicit identities", async t => {
  const { restored } = await fixture(t), request = { bindings: bindings(), selections: [selection], workspaceId: "restored" }
  await assert.rejects(rebindPortableRestore(structuredClone(restored), request))
  await assert.rejects(rebindPortableRestore(restored, { ...request, selections: [{ ...selection, revisionId: "urn:example:wrong" }] }), /identity selection/)
  const conflict = structuredClone(bindings()) as any
  conflict.resources[0].representations[0].digest = `sha256:${"0".repeat(64)}`
  await assert.rejects(rebindPortableRestore(restored, { ...request, bindings: conflict }), /digest conflicts/)
  await writeFile(join(restored.destinationPath, "메모.md"), "changed after import")
  await assert.rejects(rebindPortableRestore(restored, request))
})

test("PT03-C1: rebinding captures mutable selections and refuses implicit remapping of unselected workspaces", async t => {
  const { restored } = await fixture(t), document = structuredClone(bindings()), selections = [{ ...selection }]
  const pending = rebindPortableRestore(restored, { bindings: document, selections, workspaceId: "restored", graph: JSON.stringify(graph) })
  selections[0]!.revisionId = "urn:example:changed"
  const result = await pending
  assert.equal(result.selections[0]!.revisionId, selection.revisionId)
  const collision = structuredClone(bindings()) as any
  collision.resources.push({ id: "unselected", representations: [{ id: "unselected-local", kind: "workspace", workspace: "restored", path: "elsewhere", relation: "snapshot" }] })
  await assert.rejects(rebindPortableRestore(restored, { bindings: collision, selections: [selection], workspaceId: "restored" }), /unselected/)
  const getter = { get selections() { throw new Error("getter must not run") }, bindings: bindings(), workspaceId: "restored" }
  await assert.rejects(rebindPortableRestore(restored, getter as never), /accessors/)
})

test("PT03-C3: historical snapshots cannot be implicitly rebound as working copies; explicit local branches retain their original revisions", async t => {
  const historical = await fixture(t), branch = await fixture(t, true)
  await assert.rejects(rebindPortableRestore(historical.restored, { bindings: bindings("working-copy"), selections: [selection], workspaceId: "restored" }), /snapshot/)
  await assert.rejects(rebindPortableRestore(branch.restored, { bindings: bindings("snapshot"), selections: [selection], workspaceId: "restored" }), /working-copy/)
  const result = await rebindPortableRestore(branch.restored, { bindings: bindings("working-copy"), selections: [selection], workspaceId: "branch" })
  assert.equal(result.bindings.resources[0]!.representations[0]!.relation, "working-copy")
  assert.equal(branch.restored.manifest.revisions[0]!.id, selection.revisionId)
  assert.equal(result.execution, "NOT_REQUESTED")
  assert.equal(result.authority, "NOT_GRANTED")
})
