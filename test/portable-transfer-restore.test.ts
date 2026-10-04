import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"
import { exportPortableTransfer, PORTABLE_TRANSFER_EXPORT_SCHEMA, portableTransferClosureDigest, type PortableTransferExportRequest } from "../src/addons/portable-transfer-export.js"
import { importPortableTransfer, isVerifiedPortableRestore, PORTABLE_TRANSFER_IMPORT_SCHEMA, recheckPortableRestore } from "../src/addons/portable-transfer-import.js"

const execFile = promisify(execFileCallback)
const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`
const OWNER = "urn:pt03:test-owner"

async function fixture(t: { after(callback: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), "usl-pt03-restore-"))
  const sourceRoot = join(root, "source"), exports = join(root, "exports"), restores = join(root, "restores")
  await Promise.all([mkdir(sourceRoot), mkdir(exports), mkdir(restores)])
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, sourceRoot, exports, restores }
}

async function exported(t: { after(callback: () => unknown): void }, extra: Partial<PortableTransferExportRequest> = {}) {
  const fx = await fixture(t), bytes = Buffer.from("PT03 source bytes: \ud55c\uae00\n")
  await writeFile(join(fx.sourceRoot, "\ud55c\uae00 \uc6d0\ubcf8.txt"), bytes)
  const file = { sourcePath: "\ud55c\uae00 \uc6d0\ubcf8.txt", payloadPath: "records/item.bin", nativeId: "\uc6d0\ubcf8-ID", revisionId: "urn:pt03:revision:one", representationId: "urn:pt03:representation:one", expectedByteDigest: sha256(bytes), expectedByteLength: bytes.length }
  const base: PortableTransferExportRequest = {
    schema: PORTABLE_TRANSFER_EXPORT_SCHEMA, sourceRoot: fx.sourceRoot, destinationParent: fx.exports,
    ownerNamespace: OWNER, issuer: "urn:pt03:issuer", observedAt: "2026-10-04T00:00:00Z",
    owner: { snapshotId: "pt03-pinned" }, snapshotProfile: "PINNED_BYTE_SET", restoreProfile: "PINNED_FILES", files: [file], dependencies: [],
    expectedClosureDigest: portableTransferClosureDigest("PINNED_FILES", [file], []), ...extra,
  }
  const request = { ...base, expectedClosureDigest: portableTransferClosureDigest(base.restoreProfile, base.files, base.dependencies ?? []) }
  const bundle = await exportPortableTransfer(request)
  return { fx, bundle, bytes, file: request.files[0]! }
}

async function exportedPair(t: { after(callback: () => unknown): void }) {
  const fx = await fixture(t), left = Buffer.from("left"), right = Buffer.from("right")
  await Promise.all([mkdir(join(fx.sourceRoot, "A")), mkdir(join(fx.sourceRoot, "b"))])
  await Promise.all([writeFile(join(fx.sourceRoot, "A/x"), left), writeFile(join(fx.sourceRoot, "b/y"), right)])
  const files = [
    { sourcePath: "A/x", payloadPath: "records/one.bin", nativeId: "pair-one", revisionId: "urn:pt03:pair:one", representationId: "urn:pt03:pair-rep:one", expectedByteDigest: sha256(left), expectedByteLength: left.length },
    { sourcePath: "b/y", payloadPath: "records/two.bin", nativeId: "pair-two", revisionId: "urn:pt03:pair:two", representationId: "urn:pt03:pair-rep:two", expectedByteDigest: sha256(right), expectedByteLength: right.length },
  ]
  const bundle = await exportPortableTransfer({ schema: PORTABLE_TRANSFER_EXPORT_SCHEMA, sourceRoot: fx.sourceRoot, destinationParent: fx.exports, ownerNamespace: OWNER, issuer: "urn:pt03:issuer", observedAt: "2026-10-04T00:00:00Z", owner: { snapshotId: "pair" }, snapshotProfile: "PINNED_BYTE_SET", restoreProfile: "PINNED_FILES", files, dependencies: [], expectedClosureDigest: portableTransferClosureDigest("PINNED_FILES", files, []) })
  return { fx, bundle, files }
}

function request(bundlePath: string, destinationParent: string, expectedReceiptDigest: string, destinationName = "restored") {
  return { schema: PORTABLE_TRANSFER_IMPORT_SCHEMA, bundlePath, destinationParent, destinationName, expectedReceiptDigest, allowedOwnerNamespace: OWNER }
}

/** Rewrite a sidecar and its receipt pin. This models an authenticated-but-malicious bundle. */
async function repinSidecar(bundlePath: string, name: string, body: unknown) {
  const sidecar = join(bundlePath, "payload-bundle", name)
  const bytes = Buffer.from(JSON.stringify(body))
  await writeFile(sidecar, bytes)
  const receiptPath = join(bundlePath, "receipt.json")
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"))
  receipt.metadata[name] = { byteDigest: sha256(bytes), byteLength: bytes.length }
  const receiptBytes = Buffer.from(JSON.stringify(receipt) + "\n")
  await writeFile(receiptPath, receiptBytes)
  return sha256(receiptBytes)
}

/** Re-pin a deliberately malicious but internally self-consistent metadata set. */
async function repinSidecars(bundlePath: string, replacements: Record<string, unknown>) {
  const receiptPath = join(bundlePath, "receipt.json")
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"))
  for (const [name, body] of Object.entries(replacements)) {
    const bytes = Buffer.from(JSON.stringify(body))
    await writeFile(join(bundlePath, "payload-bundle", name), bytes)
    receipt.metadata[name] = { byteDigest: sha256(bytes), byteLength: bytes.length }
  }
  const bytes = Buffer.from(JSON.stringify(receipt) + "\n")
  await writeFile(receiptPath, bytes)
  return sha256(bytes)
}

async function sidecars(bundlePath: string) {
  const names = ["inventory.json", "policy.json", "schema.json"]
  return Object.fromEntries(await Promise.all(names.map(async name => [name, JSON.parse(await readFile(join(bundlePath, "payload-bundle", name), "utf8"))]))) as Record<string, any>
}

test("PT03-C1: verifies a real PT02 bundle before rebinding exact IDs at a different root", async (t) => {
  const { fx, bundle, bytes, file } = await exported(t)
  await rm(fx.sourceRoot, { recursive: true, force: true })
  const result = await importPortableTransfer(request(bundle.bundlePath, fx.restores, bundle.receiptDigest))
  assert.equal(result.bundleDigest, bundle.receiptDigest)
  assert.equal(result.ownerNamespace, OWNER)
  assert.deepEqual(result.restored, [{ representationId: file.representationId, revisionId: file.revisionId, nativeId: file.nativeId, restorePath: file.sourcePath }])
  assert.deepEqual(await readFile(join(result.destinationPath, file.sourcePath)), bytes)
  assert.equal(result.executionCalls, 0)
  assert.equal(result.operations, "HISTORICAL_UNRECONCILED")

  const mutable: any = request(bundle.bundlePath, fx.restores, bundle.receiptDigest, "getter")
  Object.defineProperty(mutable, "bundlePath", { enumerable: true, get: () => bundle.bundlePath })
  await assert.rejects(importPortableTransfer(mutable), /JSON|data|accessor/i)
})

test("PT03-C2: rejects receipt-pinned metadata and payload attacks without publishing a workspace", async (t) => {
  const { fx, bundle, file } = await exported(t)
  const payload = join(bundle.bundlePath, "payload-bundle", "payload", file.payloadPath)
  await writeFile(payload, "altered payload")
  await assert.rejects(importPortableTransfer(request(bundle.bundlePath, fx.restores, bundle.receiptDigest)), /payload|hash|digest|size/i)
  assert.deepEqual(await readdir(fx.restores), [])

  const second = await exported(t)
  const inventoryPath = join(second.bundle.bundlePath, "payload-bundle", "inventory.json")
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"))
  inventory.files[0].nativeId = "forged-native-id"
  const forgedReceipt = await repinSidecar(second.bundle.bundlePath, "inventory.json", inventory)
  await assert.rejects(importPortableTransfer(request(second.bundle.bundlePath, second.fx.restores, forgedReceipt)), /inventory.*manifest|manifest.*inventory|representation/i)
  assert.deepEqual(await readdir(second.fx.restores), [])
})

test("PT03-C2: refuses extra entries, symlinks, FIFOs, and does not overwrite an incomplete reservation", async (t) => {
  const { fx, bundle, file } = await exported(t)
  await writeFile(join(bundle.bundlePath, "payload-bundle", "extra"), "unexpected")
  await assert.rejects(importPortableTransfer(request(bundle.bundlePath, fx.restores, bundle.receiptDigest)), /unexpected|tree/i)
  const fresh = await exported(t)
  const payload = join(fresh.bundle.bundlePath, "payload-bundle", "payload", fresh.file.payloadPath)
  await rm(payload)
  await symlink("/etc/passwd", payload)
  await assert.rejects(importPortableTransfer(request(fresh.bundle.bundlePath, fresh.fx.restores, fresh.bundle.receiptDigest)), /symlink|regular|special/i)

  const fifoBundle = await exported(t)
  const fifoPayload = join(fifoBundle.bundle.bundlePath, "payload-bundle", "payload", fifoBundle.file.payloadPath)
  await rm(fifoPayload)
  await execFile("mkfifo", [fifoPayload])
  await assert.rejects(importPortableTransfer(request(fifoBundle.bundle.bundlePath, fifoBundle.fx.restores, fifoBundle.bundle.receiptDigest)), /regular|special|payload/i)

  const intact = await exported(t)
  const held = join(intact.fx.restores, "held")
  await mkdir(held)
  await assert.rejects(importPortableTransfer(request(intact.bundle.bundlePath, intact.fx.restores, intact.bundle.receiptDigest, "held")), /incomplete|held|reservation/i)
  assert.equal((await lstat(held)).isDirectory(), true)
  assert.ok(file.nativeId)
})

test("PT03-C2: rechecks an existing same-digest result and only one concurrent reservation publishes", async (t) => {
  const { fx, bundle, file } = await exported(t)
  const input = request(bundle.bundlePath, fx.restores, bundle.receiptDigest)
  const both = await Promise.allSettled([importPortableTransfer(input), importPortableTransfer(input)])
  assert.equal(both.filter(item => item.status === "fulfilled").length, 1)
  assert.equal(both.filter(item => item.status === "rejected").length, 1)
  const paths = both.map(item => item.status === "fulfilled" ? item.value.destinationPath : "").filter(Boolean)
  assert.equal(new Set(paths).size, 1)
  const replay = await importPortableTransfer(input)
  assert.equal(replay.reusedExisting, true)
  await writeFile(join(replay.destinationPath, file.sourcePath), "corrupted replay")
  await assert.rejects(importPortableTransfer(input), /existing.*verify|existing.*bytes|digest|size/i)
})

test("PT03-C2: authenticated malformed dependency and inventory metadata cannot change the restore closure", async (t) => {
  for (const mutation of [
    (inventory: any) => { inventory.dependencies = [{ id: "missing-representation", class: "PACKAGED", required: true, packagedRepresentationIds: ["urn:pt03:not-present"], reason: "forged" }] },
    (inventory: any) => { inventory.dependencies = [{ id: "optional-but-required", class: "OPTIONAL", required: true, reason: "forged" }] },
    (inventory: any) => { inventory.files[0].restorePath = "different-from-source.txt" },
    (inventory: any) => { inventory.files[0].parents = ["urn:pt03:unclosed-parent"] },
  ]) {
    const { fx, bundle } = await exported(t)
    const data = await sidecars(bundle.bundlePath)
    mutation(data["inventory.json"])
    const digest = await repinSidecars(bundle.bundlePath, { "inventory.json": data["inventory.json"] })
    await assert.rejects(importPortableTransfer(request(bundle.bundlePath, fx.restores, digest, `malicious-${Math.random().toString(36).slice(2)}`)), /closure|dependency|inventory|manifest|parent|restore/i)
  }
})

test("PT03-C2: authenticated policy/schema substitutions and duplicate representations are rejected semantically", async (t) => {
  for (const mutation of [
    (data: Record<string, any>) => { data["policy.json"].schema = "usl-portable-transfer-export/v0" },
    (data: Record<string, any>) => { data["schema.json"].schema = "substituted-not-PT02" },
    (data: Record<string, any>) => { data["inventory.json"].files[0].representationId = "urn:pt03:representation:absent" },
  ]) {
    const { fx, bundle } = await exported(t)
    const data = await sidecars(bundle.bundlePath)
    mutation(data)
    const digest = await repinSidecars(bundle.bundlePath, data)
    await assert.rejects(importPortableTransfer(request(bundle.bundlePath, fx.restores, digest)), /policy|schema|inventory|manifest|representation/i)
  }
})

test("PT03-C2: receipt-repinned case-folded restore paths cannot publish on a case-sensitive host", async (t) => {
  const { fx, bundle, files } = await exportedPair(t)
  const data = await sidecars(bundle.bundlePath)
  data["inventory.json"].files[1].restorePath = "a/y"
  const closureFiles = data["inventory.json"].files.map((f: any) => ({ sourcePath: f.restorePath, payloadPath: f.payloadPath, nativeId: f.nativeId, revisionId: f.revisionId, representationId: f.representationId, expectedByteDigest: f.byteDigest, expectedByteLength: f.byteLength }))
  data["policy.json"].closureDigest = portableTransferClosureDigest("PINNED_FILES", closureFiles, [])
  data["policy.json"].expectedClosureDigest = data["policy.json"].closureDigest
  const digest = await repinSidecars(bundle.bundlePath, { "inventory.json": data["inventory.json"], "policy.json": data["policy.json"] })
  await assert.rejects(importPortableTransfer(request(bundle.bundlePath, fx.restores, digest)), /collision|restore|inventory/i)
  assert.equal(files.length, 2)
})

test("PT03-C3: preserves unknown, diverged, and withdrawn history without automatic activation or merge", async (t) => {
  const { fx, bundle, file } = await exported(t)
  const unknown = await importPortableTransfer(request(bundle.bundlePath, fx.restores, bundle.receiptDigest, "unknown"))
  assert.equal(unknown.freshness, "FRESHNESS_UNKNOWN")
  const diverged = await importPortableTransfer({ ...request(bundle.bundlePath, fx.restores, bundle.receiptDigest, "diverged"), ownerState: { resources: [{ nativeId: file.nativeId, headRevisionId: "urn:pt03:other-head" }] } })
  assert.equal(diverged.freshness, "DIVERGED")
  const withdrawn = await importPortableTransfer({ ...request(bundle.bundlePath, fx.restores, bundle.receiptDigest, "withdrawn"), ownerState: { resources: [{ nativeId: file.nativeId, withdrawn: true }] } })
  assert.equal(withdrawn.freshness, "WITHDRAWN")
  const branch = await importPortableTransfer({ ...request(bundle.bundlePath, fx.restores, bundle.receiptDigest, "branch"), freshnessMode: "LOCAL_BRANCH", localBranchId: "local:pt03:branch" } as any)
  assert.equal(branch.freshnessMode, "LOCAL_BRANCH")
  assert.equal(branch.localBranchId, "local:pt03:branch")
  assert.equal(branch.executionCalls, 0)
})

test("PT03-C3: owner-state duplicate keys are rejected and __proto__ remains an ordinary withdrawn native ID", async (t) => {
  const ordinary = await exported(t)
  await assert.rejects(importPortableTransfer({ ...request(ordinary.bundle.bundlePath, ordinary.fx.restores, ordinary.bundle.receiptDigest), ownerState: { resources: [
    { nativeId: ordinary.file.nativeId, headRevisionId: ordinary.file.revisionId }, { nativeId: ordinary.file.nativeId, withdrawn: true },
  ] } }), /duplicate|owner.*state/i)

  const proto = await exported(t, { files: [{ sourcePath: "\ud55c\uae00 \uc6d0\ubcf8.txt", payloadPath: "records/item.bin", nativeId: "__proto__", revisionId: "urn:pt03:revision:one", representationId: "urn:pt03:representation:one", expectedByteDigest: sha256(Buffer.from("PT03 source bytes: \ud55c\uae00\n")), expectedByteLength: Buffer.byteLength("PT03 source bytes: \ud55c\uae00\n") }] })
  const result = await importPortableTransfer({ ...request(proto.bundle.bundlePath, proto.fx.restores, proto.bundle.receiptDigest), ownerState: { resources: [{ nativeId: "__proto__", withdrawn: true }] } })
  assert.equal(result.freshness, "WITHDRAWN")
  assert.equal(result.resourceFreshness["__proto__"], "WITHDRAWN")
})

test("PT03-C4: only an immutable in-process result can be rechecked; marker and workspace replacement are detected", async (t) => {
  const { fx, bundle, file } = await exported(t)
  const result = await importPortableTransfer(request(bundle.bundlePath, fx.restores, bundle.receiptDigest))
  assert.equal(isVerifiedPortableRestore(JSON.parse(JSON.stringify(result))), false)
  await assert.rejects(recheckPortableRestore(JSON.parse(JSON.stringify(result))), /not verified/i)
  assert.equal(Object.isFrozen(result.restored), true)
  assert.equal(Object.isFrozen(result.restored[0]!), true)
  await assert.rejects(Promise.resolve().then(() => { ;(result.restored[0] as any).nativeId = "forged" }), /read only|extensible|assign/i)
  const marker = join(fx.restores, "restored", "import-receipt.json")
  const body = JSON.parse(await readFile(marker, "utf8")); body.freshnessMode = "LOCAL_BRANCH"
  await writeFile(marker, JSON.stringify(body))
  await assert.rejects(recheckPortableRestore(result), /marker|published|mode|identity/i)
  await rm(result.destinationPath, { recursive: true, force: true }); await mkdir(result.destinationPath)
  await assert.rejects(recheckPortableRestore(result), /missing|tree|bytes|published/i)
  assert.ok(file.nativeId)
})

test("PT03-C4: rejects unsupported Git closure and keeps operations as historical data", async (t) => {
  const { fx, bundle } = await exported(t, { restoreProfile: "GIT_WORKTREE" })
  assert.equal(bundle.selfContained, false)
  await assert.rejects(importPortableTransfer(request(bundle.bundlePath, fx.restores, bundle.receiptDigest)), /incomplete|policy|Git|self-contained/i)
})

test("PT03-C5: rejects conflicting owner registry definitions without truncating native IDs", async (t) => {
  const nativeId = `native-${"x".repeat(249)}`
  const { fx, bundle, file } = await exported(t, { files: [{ sourcePath: "\ud55c\uae00 \uc6d0\ubcf8.txt", payloadPath: "records/item.bin", nativeId, revisionId: "urn:pt03:revision:one", representationId: "urn:pt03:representation:one", expectedByteDigest: sha256(Buffer.from("PT03 source bytes: \ud55c\uae00\n")), expectedByteLength: Buffer.byteLength("PT03 source bytes: \ud55c\uae00\n") }] })
  const conflict = { ...request(bundle.bundlePath, fx.restores, bundle.receiptDigest), registry: { resources: [{ ownerNamespace: OWNER, nativeId: file.nativeId, descriptorDigest: sha256(Buffer.from("different-definition")) }] } }
  await assert.rejects(importPortableTransfer(conflict), /registry|definition|conflict/i)
})

test("PT03-C4: CLI accepts help but rejects bad arguments and a FIFO spec promptly", async (t) => {
  const { fx, bundle } = await exported(t)
  const help = await execFile("tsx", ["scripts/usl-transfer-import.ts", "--help"], { cwd: process.cwd() })
  assert.match(help.stdout, /--spec FILE --destination-parent DIRECTORY --destination-name NAME/)
  await assert.rejects(execFile("tsx", ["scripts/usl-transfer-import.ts", "--bogus"], { cwd: process.cwd() }), /usage/i)
  const fifo = join(fx.root, "import-spec.fifo")
  await execFile("mkfifo", [fifo])
  await assert.rejects(execFile("tsx", ["scripts/usl-transfer-import.ts", "--spec", fifo, "--destination-parent", fx.restores, "--destination-name", "cli"], { cwd: process.cwd(), timeout: 500 }), /timed out|regular|FIFO|Command failed/i)
  assert.ok(bundle.bundlePath)
})
