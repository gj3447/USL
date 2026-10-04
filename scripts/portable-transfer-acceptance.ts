#!/usr/bin/env node
/** PT04 cross-OS transport fixture. It has no network, host-registration, or execution callback. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { exportPortableTransfer, PORTABLE_TRANSFER_EXPORT_SCHEMA, portableTransferClosureDigest, type FrozenPortableTransferFile } from "../src/addons/portable-transfer-export.js"
import { importPortableTransfer, PORTABLE_TRANSFER_IMPORT_SCHEMA } from "../src/addons/portable-transfer-import.js"
import { rebindPortableRestore } from "../src/addons/portable-transfer-bindings.js"
import { parseResourceBindings } from "../src/resource-bindings.js"

const usage = "usage: node --import tsx scripts/portable-transfer-acceptance.ts produce --bundle-parent DIRECTORY | consume --bundle DIRECTORY --receipt-digest sha256:... --destination-parent DIRECTORY"
const args = process.argv.slice(2)
if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) { process.stdout.write(`${usage}\n`); process.exit(0) }
const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`
const ownerNamespace = "urn:example:pt04:transport", issuer = "urn:example:pt04:producer"
const fixture = [
  { resource: "note", role: "memory", sourcePath: "nested/note.txt", payloadPath: "payload/note.bin", nativeId: "portable-note", revisionId: "urn:example:revision:note", representationId: "urn:example:representation:note", bytes: Buffer.from("portable memory\n", "utf8") },
  { resource: "source", role: "source", sourcePath: "nested/binary/source.bin", payloadPath: "payload/source.bin", nativeId: "portable-source", revisionId: "urn:example:revision:source", representationId: "urn:example:representation:source", bytes: Buffer.from([0, 1, 2, 255, 128, 17]) },
] as const

const value = (flag: string) => { const index = args.indexOf(flag); const found = index < 0 ? undefined : args[index + 1]; if (index < 0 || found === undefined || found.startsWith("--")) throw new Error(usage); return found }
const exactFlags = (flags: readonly string[]) => {
  if (args.length !== flags.length * 2 - 1) throw new Error(usage)
  if (args[0] !== flags[0]) throw new Error(usage)
  for (let index = 1; index < flags.length; index++) if (args[index * 2 - 1] !== flags[index]) throw new Error(usage)
}

async function produce() {
  exactFlags(["produce", "--bundle-parent"])
  // This fixture owns its temporary source. Resolve OS temporary-directory
  // aliases before creation, retaining the exporter's no-symlink boundary.
  const bundleParent = resolve(value("--bundle-parent")!), sourceRoot = await mkdtemp(join(await realpath(tmpdir()), "usl-pt04-producer-"))
  try {
    const files: FrozenPortableTransferFile[] = []
    for (const item of fixture) {
      const path = join(sourceRoot, item.sourcePath)
      await mkdir(resolve(path, ".."), { recursive: true })
      await writeFile(path, item.bytes)
      files.push({ sourcePath: item.sourcePath, payloadPath: item.payloadPath, nativeId: item.nativeId, revisionId: item.revisionId, representationId: item.representationId, expectedByteDigest: sha256(item.bytes), expectedByteLength: item.bytes.length })
    }
    const dependencies = [{ id: "pt04-fixture-payloads", class: "PACKAGED" as const, required: true, packagedRepresentationIds: files.map(file => file.representationId), reason: "all fixture representations are packaged" }]
    const result = await exportPortableTransfer({ schema: PORTABLE_TRANSFER_EXPORT_SCHEMA, sourceRoot, destinationParent: bundleParent, ownerNamespace, issuer, observedAt: "2026-10-04T00:00:00Z", owner: { snapshotId: "pt04-fixed-fixture", assertConsistent() {} }, snapshotProfile: "PINNED_BYTE_SET", expectedClosureDigest: portableTransferClosureDigest("PINNED_FILES", files, dependencies), restoreProfile: "PINNED_FILES", files, dependencies })
    // Source is intentionally absent before the consumer can receive the bundle.
    await rm(sourceRoot, { recursive: true, force: true })
    process.stdout.write(`${JSON.stringify({ schema: "usl-portable-transfer-producer/v1", bundleName: basename(result.bundlePath), bundlePath: result.bundlePath, receiptDigest: result.receiptDigest, bytes: result.bytes, resources: fixture.map(item => item.nativeId) })}\n`)
  } finally { await rm(sourceRoot, { recursive: true, force: true }) }
}

async function consume() {
  exactFlags(["consume", "--bundle", "--receipt-digest", "--destination-parent"])
  const started = process.hrtime.bigint()
  const restored = await importPortableTransfer({ schema: PORTABLE_TRANSFER_IMPORT_SCHEMA, bundlePath: resolve(value("--bundle")!), destinationParent: resolve(value("--destination-parent")!), destinationName: "restored-pt04", expectedReceiptDigest: value("--receipt-digest")!, allowedOwnerNamespace: ownerNamespace })
  const selections = fixture.map(item => ({ resource: item.resource, bindingRepresentation: `${item.resource}-snapshot`, nativeId: item.nativeId, revisionId: item.revisionId, representationId: item.representationId }))
  const bindings = parseResourceBindings({ schema: "usl-resource-bindings/v1", resources: fixture.map(item => ({ id: item.resource, representations: [{ id: `${item.resource}-snapshot`, kind: "workspace" as const, workspace: "portable", path: item.sourcePath, relation: "snapshot" as const }] })) })
  const graph = { schema: "usl-resource-graph/v1", resources: [...fixture.map(item => ({ id: item.resource, types: [`urn:example:${item.resource}`], locator: `https://example.invalid/${item.resource}` })), { id: "activity", types: ["urn:example:activity"], locator: "https://example.invalid/activity" }, { id: "agent", types: ["urn:example:agent"], locator: "https://example.invalid/agent" }], meanings: [{ id: "cites", description: "fixed PT04 role fixture" }], links: [{ id: "note-source", meaning: "cites", participants: fixture.map(item => ({ role: item.role, resource: item.resource })) }], provenance: { sources: ["source"], activity: "activity", agent: "agent" } }
  const rebound = await rebindPortableRestore(restored, { bindings, selections, workspaceId: "portable", graph: JSON.stringify(graph), hostname: "pt04-consumer" })
  assert.deepEqual(rebound.graph!.links, graph.links)
  assert.deepEqual(restored.restored.map(item => [item.nativeId, item.revisionId, item.representationId, item.restorePath]).sort(), fixture.map(item => [item.nativeId, item.revisionId, item.representationId, item.sourcePath]).sort())
  const payloads = await Promise.all(fixture.map(async item => {
    const bytes = await readFile(join(restored.destinationPath, item.sourcePath)), digest = sha256(bytes)
    assert.equal(digest, sha256(item.bytes))
    return { nativeId: item.nativeId, revisionId: item.revisionId, representationId: item.representationId, restorePath: item.sourcePath, bytes: bytes.length, digest }
  }))
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000
  const roles = graph.links[0]!.participants
  process.stdout.write(`${JSON.stringify({ schema: "usl-portable-transfer-consumer-report/v1", observedAt: new Date().toISOString(), platform: process.platform, node: process.version, sourceBundleReceiptDigest: restored.bundleDigest, importedBytes: payloads.reduce((total, item) => total + item.bytes, 0), payloads, roles, roleVerification: "PASS", importAndRebindWallMs: elapsedMs, peakRssKiB: process.resourceUsage().maxRSS, operations: restored.operations, executionCalls: restored.executionCalls })}\n`)
}

if (args[0] === "produce") await produce()
else if (args[0] === "consume") await consume()
else throw new Error(usage)
