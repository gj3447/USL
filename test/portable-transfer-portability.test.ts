import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFile as execFileCallback } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"
import { exportPortableTransfer, PORTABLE_TRANSFER_EXPORT_SCHEMA, portableTransferClosureDigest, type FrozenPortableTransferFile } from "../src/addons/portable-transfer-export.js"
import { importPortableTransfer, PORTABLE_TRANSFER_IMPORT_SCHEMA } from "../src/addons/portable-transfer-import.js"

const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`
const execFile = promisify(execFileCallback)

async function fixture(t: { after(callback: () => unknown): void }) {
  // OS temporary-directory aliases must be resolved by the fixture owner.
  // mkdtemp alone preserves symlink ancestors; the exporter rejects them.
  const root = await mkdtemp(join(await realpath(tmpdir()), "usl-pt04-"))
  const sourceRoot = join(root, "source-device", "selection")
  const exportsRoot = join(root, "source-device", "exports")
  const transferredRoot = join(root, "transferred-device", "incoming")
  const destinationParent = join(root, "destination-device", "workspaces")
  await Promise.all([mkdir(sourceRoot, { recursive: true }), mkdir(exportsRoot, { recursive: true }), mkdir(transferredRoot, { recursive: true }), mkdir(destinationParent, { recursive: true })])
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, sourceRoot, exportsRoot, transferredRoot, destinationParent }
}

async function createBundle(fx: Awaited<ReturnType<typeof fixture>>, dependency: "PACKAGED" | "EXTERNAL_REQUIRED" = "PACKAGED") {
  const entries = [
    ["records/alpha.txt", "payload/alpha", "alpha", "urn:example:revision:alpha", "urn:example:representation:alpha"],
    ["records/beta.bin", "\u0000\u0001\u0002\u00ff", "beta", "urn:example:revision:beta", "urn:example:representation:beta"],
  ] as const
  const files: FrozenPortableTransferFile[] = []
  for (const [sourcePath, text, nativeId, revisionId, representationId] of entries) {
    const bytes = Buffer.from(text, "utf8")
    await mkdir(join(fx.sourceRoot, "records"), { recursive: true })
    await writeFile(join(fx.sourceRoot, sourcePath), bytes)
    files.push({ sourcePath, payloadPath: sourcePath, nativeId, revisionId, representationId, expectedByteDigest: sha256(bytes), expectedByteLength: bytes.length })
  }
  const dependencies = dependency === "PACKAGED"
    ? [{ id: "selected-records", class: "PACKAGED" as const, required: true, packagedRepresentationIds: files.map(file => file.representationId), reason: "selected payloads close this fixture" }]
    : [{ id: "missing-owner-store", class: "EXTERNAL_REQUIRED" as const, required: true, reason: "fixture intentionally lacks this dependency" }]
  const request = {
    schema: PORTABLE_TRANSFER_EXPORT_SCHEMA, sourceRoot: fx.sourceRoot, destinationParent: fx.exportsRoot,
    ownerNamespace: "urn:example:owner:pt04", issuer: "urn:example:issuer:pt04", observedAt: "2026-10-04T00:00:00Z",
    owner: { snapshotId: "pt04-snapshot", assertConsistent: () => {} }, snapshotProfile: "PINNED_BYTE_SET" as const,
    expectedClosureDigest: portableTransferClosureDigest("PINNED_FILES", files, dependencies), restoreProfile: "PINNED_FILES" as const, files, dependencies,
  }
  return exportPortableTransfer(request)
}

async function copiedBundle(fx: Awaited<ReturnType<typeof fixture>>, bundlePath: string) {
  const destination = join(fx.transferredRoot, "bundle-copy")
  await cp(bundlePath, destination, { recursive: true, errorOnExist: true, force: false })
  await rm(fx.sourceRoot, { recursive: true, force: true })
  await rm(bundlePath, { recursive: true, force: true })
  await assert.rejects(stat(fx.sourceRoot))
  await assert.rejects(stat(bundlePath))
  return destination
}

function importRequest(bundlePath: string, destinationParent: string, receiptDigest: string, destinationName = "restored") {
  return { schema: PORTABLE_TRANSFER_IMPORT_SCHEMA, bundlePath, destinationParent, destinationName, expectedReceiptDigest: receiptDigest, allowedOwnerNamespace: "urn:example:owner:pt04" }
}

test("PT04-C1: a copied self-contained bundle restores without source, cache, or original bundle", async (t) => {
  const fx = await fixture(t), exported = await createBundle(fx)
  assert.equal(exported.selfContained, true)
  const bundlePath = await copiedBundle(fx, exported.bundlePath)
  const result = await importPortableTransfer(importRequest(bundlePath, fx.destinationParent, exported.receiptDigest))
  const exact = result.restored.map(value => [value.nativeId, value.revisionId, value.representationId, value.restorePath]).sort()
  assert.deepEqual(exact, [
    ["alpha", "urn:example:revision:alpha", "urn:example:representation:alpha", "records/alpha.txt"],
    ["beta", "urn:example:revision:beta", "urn:example:representation:beta", "records/beta.bin"],
  ])
  assert.equal(await readFile(join(result.destinationPath, "records/alpha.txt"), "utf8"), "payload/alpha")
  assert.deepEqual(await readFile(join(result.destinationPath, "records/beta.bin")), Buffer.from("\u0000\u0001\u0002\u00ff", "utf8"))
  assert.equal(result.operations, "HISTORICAL_UNRECONCILED")
  assert.equal(result.executionCalls, 0)
  const repeated = await importPortableTransfer(importRequest(bundlePath, fx.destinationParent, exported.receiptDigest))
  assert.equal(repeated.reusedExisting, true)
  assert.equal(repeated.executionCalls, 0)
})

test("PT04-C2: missing required dependencies and a one-byte payload change never publish a restored workspace", async (t) => {
  const missing = await fixture(t), incomplete = await createBundle(missing, "EXTERNAL_REQUIRED")
  await assert.rejects(importPortableTransfer(importRequest(incomplete.bundlePath, missing.destinationParent, incomplete.receiptDigest)), /incomplete|self-contained|dependency/i)
  const fx = await fixture(t), exported = await createBundle(fx)
  const bundlePath = await copiedBundle(fx, exported.bundlePath)
  const payload = join(bundlePath, "payload-bundle", "payload", "records", "alpha.txt")
  const bytes = await readFile(payload)
  assert.ok(bytes.length > 0)
  bytes[0] = bytes[0]! ^ 1
  await writeFile(payload, bytes)
  await assert.rejects(importPortableTransfer(importRequest(bundlePath, fx.destinationParent, exported.receiptDigest)), /hash|digest|payload/i)
  await assert.rejects(stat(join(fx.destinationParent, "restored", "import-receipt.json")))
})

test("PT04-C2: a budget-interrupted import leaves no completion marker and does not retry effects", async (t) => {
  const fx = await fixture(t), exported = await createBundle(fx)
  const bundlePath = await copiedBundle(fx, exported.bundlePath)
  await assert.rejects(importPortableTransfer({ ...importRequest(bundlePath, fx.destinationParent, exported.receiptDigest), maxTotalBytes: 1 }), /budget/i)
  await assert.rejects(stat(join(fx.destinationParent, "restored", "import-receipt.json")))
  const result = await importPortableTransfer(importRequest(bundlePath, fx.destinationParent, exported.receiptDigest))
  assert.equal(result.executionCalls, 0)
  assert.equal(result.operations, "HISTORICAL_UNRECONCILED")
})

test("PT04-C3: a separate producer and cache-free consumer report exact transport metrics", async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "usl-pt04-c3-")), bundles = join(root, "producer-bundles"), copied = join(root, "consumer-download"), destination = join(root, "consumer-target")
  await Promise.all([mkdir(bundles), mkdir(copied), mkdir(destination)])
  t.after(() => rm(root, { recursive: true, force: true }))
  const producer = JSON.parse((await execFile(process.execPath, ["--import", "tsx", "scripts/portable-transfer-acceptance.ts", "produce", "--bundle-parent", bundles])).stdout) as { bundlePath: string, receiptDigest: string }
  const transferred = join(copied, "bundle")
  await cp(producer.bundlePath, transferred, { recursive: true, errorOnExist: true, force: false })
  await rm(producer.bundlePath, { recursive: true, force: true })
  await assert.rejects(stat(producer.bundlePath))
  const report = JSON.parse((await execFile(process.execPath, ["--import", "tsx", "scripts/portable-transfer-acceptance.ts", "consume", "--bundle", transferred, "--receipt-digest", producer.receiptDigest, "--destination-parent", destination])).stdout) as { platform: string, importedBytes: number, roleVerification: string, executionCalls: number, importAndRebindWallMs: number, peakRssKiB: number, payloads: unknown[] }
  assert.equal(report.platform, process.platform)
  assert.equal(report.importedBytes, 22)
  assert.equal(report.payloads.length, 2)
  assert.equal(report.roleVerification, "PASS")
  assert.equal(report.executionCalls, 0)
  assert.ok(Number.isFinite(report.importAndRebindWallMs) && report.importAndRebindWallMs >= 0)
  assert.ok(Number.isFinite(report.peakRssKiB) && report.peakRssKiB > 0)
})

test("PT04-C1: owned transport fixtures resolve temporary-directory aliases before strict filesystem checks", async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "usl-pt04-alias-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const actual = join(root, "actual"), alias = join(root, "alias"), bundles = join(root, "bundles")
  await Promise.all([mkdir(actual), mkdir(bundles)])
  await symlink(actual, alias, process.platform === "win32" ? "junction" : "dir")
  const env = { ...process.env, TMPDIR: alias, TEMP: alias, TMP: alias }
  const producer = JSON.parse((await execFile(process.execPath, ["--import", "tsx", "scripts/portable-transfer-acceptance.ts", "produce", "--bundle-parent", bundles], { env })).stdout) as { bytes: number }
  assert.equal(producer.bytes, 22)
  // Run only the ordinary copied-bundle fixture, preventing recursive execution
  // of this regression while exercising its temporary-root setup in a fresh process.
  await execFile(process.execPath, ["--import", "tsx", "--test", "--test-name-pattern", "^PT04-C1: a copied", "test/portable-transfer-portability.test.ts"], { env })
})
