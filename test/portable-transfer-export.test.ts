import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFile as execFileCallback } from "node:child_process"
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"
import { exportPortableTransfer, PORTABLE_TRANSFER_EXPORT_SCHEMA, portableTransferClosureDigest, type PortableTransferExportRequest } from "../src/addons/portable-transfer-export.js"

const sha256 = (value: Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`
const execFile = promisify(execFileCallback)

async function fixture(t: { after(callback: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), "usl-pt02-export-"))
  const sourceRoot = join(root, "source"), destinationParent = join(root, "exports")
  await Promise.all([mkdir(sourceRoot), mkdir(destinationParent)])
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, sourceRoot, destinationParent }
}

async function put(sourceRoot: string, name: string, bytes: Uint8Array) {
  const path = join(sourceRoot, name)
  await writeFile(path, bytes)
  return { path, sourcePath: name, bytes, expectedByteDigest: sha256(bytes), expectedByteLength: bytes.length }
}

function request(fx: { sourceRoot: string, destinationParent: string }, file: Awaited<ReturnType<typeof put>>, owner: PortableTransferExportRequest["owner"], extra: Partial<PortableTransferExportRequest> = {}): PortableTransferExportRequest {
  return {
    schema: PORTABLE_TRANSFER_EXPORT_SCHEMA,
    sourceRoot: fx.sourceRoot,
    destinationParent: fx.destinationParent,
    ownerNamespace: "urn:example:owner",
    issuer: "urn:example:issuer",
    observedAt: "2026-10-04T00:00:00Z",
    owner,
    restoreProfile: "PINNED_FILES",
    files: [{ sourcePath: file.sourcePath, payloadPath: "records/item.bin", expectedByteDigest: file.expectedByteDigest, expectedByteLength: file.expectedByteLength, nativeId: "원본 항목", revisionId: "urn:example:revision:one", representationId: "urn:example:representation:one" }],
    ...extra,
  }
}

async function tree(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) for (const nested of await tree(child)) out.push(`${entry.name}/${nested}`)
    else out.push(entry.name)
  }
  return out.sort()
}

test("PT02-C1: records independent SHA-256 and length for the bytes actually published", async (t) => {
  const fx = await fixture(t), bytes = Buffer.from("한글 source path payload\n", "utf8")
  const file = await put(fx.sourceRoot, "한글-원본.bin", bytes)
  const result = await exportPortableTransfer(request(fx, file, { snapshotId: "snap-1", assertConsistent: () => {} }))
  const payload = await readFile(join(result.bundlePath, "payload-bundle/payload/records/item.bin"))
  const manifest = JSON.parse(await readFile(join(result.bundlePath, "payload-bundle/manifest.json"), "utf8"))
  const receipt = JSON.parse(await readFile(join(result.bundlePath, "receipt.json"), "utf8"))
  const inventory = JSON.parse(await readFile(join(result.bundlePath, "payload-bundle/inventory.json"), "utf8"))
  assert.equal(sha256(payload), sha256(bytes))
  assert.equal(payload.length, Buffer.byteLength(bytes))
  assert.deepEqual(manifest.representations[0], {
    id: "urn:example:representation:one", revision: "urn:example:revision:one", payloadPath: "payload/records/item.bin",
    byteDigestAlgorithm: "SHA256_RAW_BYTES_V1", byteDigest: sha256(bytes), byteLength: Buffer.byteLength(bytes),
  })
  assert.equal(receipt.snapshotId, "snap-1")
  assert.equal(receipt.manifestDigest, result.manifestDigest)
  assert.equal(result.receiptDigest, sha256(await readFile(join(result.bundlePath, "receipt.json"))))
  assert.equal(inventory.files[0].nativeId, "원본 항목")
  assert.equal(inventory.files[0].restorePath, "한글-원본.bin")
  for (const name of ["manifest.json", "envelope.json", "policy.json", "dictionary.json", "inventory.json", "schema.json"]) {
    const metadata = await readFile(join(result.bundlePath, "payload-bundle", name))
    assert.deepEqual(receipt.metadata[name], { byteDigest: sha256(metadata), byteLength: metadata.length })
  }
  assert.deepEqual(await tree(result.bundlePath), ["payload-bundle/dictionary.json", "payload-bundle/envelope.json", "payload-bundle/inventory.json", "payload-bundle/manifest.json", "payload-bundle/payload/records/item.bin", "payload-bundle/policy.json", "payload-bundle/schema.json", "receipt.json"])
})

test("PT02-C1: unique staged publication never overwrites an existing export", async (t) => {
  const fx = await fixture(t), file = await put(fx.sourceRoot, "source.bin", Buffer.from("fixed"))
  const owner = { snapshotId: "snap-no-overwrite", assertConsistent: () => {} }
  const first = await exportPortableTransfer(request(fx, file, owner))
  const second = await exportPortableTransfer(request(fx, file, owner))
  assert.notEqual(first.bundlePath, second.bundlePath)
  assert.equal(await readFile(join(first.bundlePath, "receipt.json"), "utf8"), await readFile(join(second.bundlePath, "receipt.json"), "utf8"))
  assert.deepEqual((await readdir(fx.destinationParent)).sort(), [basename(first.bundlePath), basename(second.bundlePath)].sort())
})

test("PT02-C1: an owner snapshot mismatch before or after copying aborts and cleans up the bundle", async (t) => {
  const fx = await fixture(t), file = await put(fx.sourceRoot, "source.bin", Buffer.from("frozen bytes"))
  let attempts = 0
  const owner = { snapshotId: "snap-drift", assertConsistent: async () => {
    attempts++
    if (attempts === 2) { await writeFile(file.path, "mutated after copy"); throw new Error("owner snapshot changed") }
  } }
  await assert.rejects(exportPortableTransfer(request(fx, file, owner)), /snapshot changed/)
  assert.equal((await readdir(fx.destinationParent)).length, 0)
  await writeFile(file.path, "mutated before copy")
  await assert.rejects(exportPortableTransfer(request(fx, file, { snapshotId: "snap-before", assertConsistent: () => {} })), /differs from owner-frozen/)
  assert.equal((await readdir(fx.destinationParent)).length, 0)
})

test("PT02-C1: snapshots mutable request fields before awaiting the owner", async (t) => {
  const fx = await fixture(t), frozen = await put(fx.sourceRoot, "frozen.bin", Buffer.from("frozen")), changed = await put(fx.sourceRoot, "changed.bin", Buffer.from("changed"))
  let input!: any
  const owner = { snapshotId: "snap-input", assertConsistent: async () => {
    input.files = [{ ...changed, payloadPath: "records/changed.bin", nativeId: "changed", revisionId: "urn:example:revision:changed", representationId: "urn:example:representation:changed" }]
    input.restoreProfile = "rewritten-profile"
  } }
  input = request(fx, frozen, owner)
  const result = await exportPortableTransfer(input)
  const manifest = JSON.parse(await readFile(join(result.bundlePath, "payload-bundle/manifest.json"), "utf8"))
  assert.equal(manifest.revisions[0].id, "urn:example:revision:one")
  assert.equal(manifest.representations[0].byteDigest, sha256(frozen.bytes))
})

test("PT02-C1: accessor-backed requests are refused before their values can vary across awaits", async (t) => {
  const fx = await fixture(t), file = await put(fx.sourceRoot, "source.bin", Buffer.from("payload"))
  const input: any = request(fx, file, { snapshotId: "snap-getter", assertConsistent: () => {} })
  Object.defineProperty(input, "files", { enumerable: true, get: () => [input] })
  await assert.rejects(exportPortableTransfer(input), /accessor|plain JSON|input|data property/i)
})

test("PT02-C2: required dependencies are self-contained only when represented by packaged payload", async (t) => {
  const fx = await fixture(t), file = await put(fx.sourceRoot, "source.bin", Buffer.from("payload")), owner = { snapshotId: "snap-deps", assertConsistent: () => {} }
  const external = await exportPortableTransfer(request(fx, file, owner, { dependencies: [
    { id: "git-common-objects", class: "EXTERNAL_REQUIRED", required: true, reason: "not copied" },
    { id: "lfs", class: "OPTIONAL", required: false, reason: "not selected" },
  ] }))
  const packaged = await exportPortableTransfer(request(fx, file, owner, { dependencies: [{ id: "git-common-objects", class: "PACKAGED", required: true, packagedRepresentationIds: ["urn:example:representation:one"], reason: "closure verified" }] }))
  assert.equal(external.selfContained, false)
  assert.equal(packaged.selfContained, true)
  const policy = JSON.parse(await readFile(join(external.bundlePath, "payload-bundle/policy.json"), "utf8"))
  assert.deepEqual(policy.dependencyClasses, ["PACKAGED", "EXTERNAL_REQUIRED", "OPTIONAL"])
})

test("PT02-C2: a legacy caller-supplied verified flag cannot turn a dependency into a complete export", async (t) => {
  const fx = await fixture(t), file = await put(fx.sourceRoot, "source.bin", Buffer.from("payload"))
  const input: any = request(fx, file, { snapshotId: "snap-forged", assertConsistent: () => {} }, { dependencies: [{ id: "git-common-objects", class: "PACKAGED", required: true, verified: true, reason: "caller says so" }] as any })
  await assert.rejects(exportPortableTransfer(input), /unknown dependency field/)
})

test("PT02-C3: unknown nested file fields cannot become inventory or restore metadata", async (t) => {
  const fx = await fixture(t), file = await put(fx.sourceRoot, "source.bin", Buffer.from("payload"))
  const input: any = request(fx, file, { snapshotId: "snap-unknown", assertConsistent: () => {} })
  input.files[0].privateAction = { command: "not-a-program" }
  await assert.rejects(exportPortableTransfer(input), /unknown.*file field/i)
})

test("PT02-C2: dependency closure inputs are bounded and nested package evidence is captured before the owner await", async (t) => {
  const fx = await fixture(t), file = await put(fx.sourceRoot, "source.bin", Buffer.from("payload"))
  const tooMany = Array.from({ length: 1025 }, (_, index) => ({ id: `optional-${index}`, class: "OPTIONAL" as const, required: false, reason: "bounded inventory" }))
  await assert.rejects(exportPortableTransfer(request(fx, file, { snapshotId: "snap-many", assertConsistent: () => {} }, { dependencies: tooMany })), /dependency.*bound|bounded.*depend|Too big/i)
  const dependencies: any[] = [{ id: "closed-file", class: "PACKAGED", required: true, packagedRepresentationIds: ["urn:example:representation:one"], reason: "included file" }]
  const value = request(fx, file, { snapshotId: "snap-nested", assertConsistent: () => { dependencies[0].packagedRepresentationIds[0] = "urn:example:representation:rewritten" } }, { snapshotProfile: "PINNED_BYTE_SET", dependencies })
  const pinned = { ...value, expectedClosureDigest: portableTransferClosureDigest(value.restoreProfile, value.files, dependencies) }
  const result = await exportPortableTransfer(pinned)
  assert.equal(result.selfContained, true)
})

test("PT02-C2: rejects path escapes, special files, duplicate IDs, case collisions, excess entries, and byte budgets", async (t) => {
  const fx = await fixture(t), file = await put(fx.sourceRoot, "source.bin", Buffer.from("payload")), owner = { snapshotId: "snap-reject", assertConsistent: () => {} }
  await writeFile(join(fx.root, "outside.bin"), "outside")
  const escaped: any = request(fx, file, owner); escaped.files = [{ ...escaped.files[0]!, sourcePath: "../outside.bin" }]
  await assert.rejects(exportPortableTransfer(escaped), /unsafe source path|escapes/)
  await symlink(file.path, join(fx.sourceRoot, "link.bin"))
  const link: any = request(fx, file, owner); link.files = [{ ...link.files[0]!, sourcePath: "link.bin" }]
  await assert.rejects(exportPortableTransfer(link), /non-symlink|symlink component/)
  await execFile("mkfifo", [join(fx.sourceRoot, "pipe")])
  const fifo: any = request(fx, file, owner); fifo.files = [{ ...fifo.files[0]!, sourcePath: "pipe" }]
  await assert.rejects(exportPortableTransfer(fifo), /regular non-symlink file/)
  await mkdir(join(fx.root, "outside-dir")); await writeFile(join(fx.root, "outside-dir", "outside.bin"), "outside")
  await symlink(join(fx.root, "outside-dir"), join(fx.sourceRoot, "linked-dir"))
  const componentLink: any = request(fx, file, owner); componentLink.files = [{ ...componentLink.files[0]!, sourcePath: "linked-dir/outside.bin", expectedByteDigest: sha256(Buffer.from("outside")), expectedByteLength: 7 }]
  await assert.rejects(exportPortableTransfer(componentLink), /symlink|escapes selected source root/)
  const duplicate: any = request(fx, file, owner); duplicate.files = [...duplicate.files, { ...duplicate.files[0]!, payloadPath: "RECORDS/ITEM.BIN" }]
  await assert.rejects(exportPortableTransfer(duplicate), /collision|duplicate/)
  await assert.rejects(exportPortableTransfer(request(fx, file, owner, { maxTotalBytes: file.bytes.length - 1 })), /byte budget/)
  const tooMany: any = request(fx, file, owner); tooMany.files = Array.from({ length: 1025 }, (_, index) => ({ ...tooMany.files[0]!, payloadPath: `records/${index}.bin`, nativeId: `item-${index}`, revisionId: `urn:example:revision:${index}`, representationId: `urn:example:representation:${index}` }))
  await assert.rejects(exportPortableTransfer(tooMany), /bounded non-empty file list|Too big/)
  assert.equal((await readdir(fx.destinationParent)).length, 0)
})

test("PT02-C2: restore paths preserve Unicode only when their NFC and case-folded forms are unambiguous", async (t) => {
  const fx = await fixture(t), composed = await put(fx.sourceRoot, "é.txt", Buffer.from("one")), decomposed = await put(fx.sourceRoot, "e\u0301.txt", Buffer.from("two"))
  const unicode: any = request(fx, composed, { snapshotId: "snap-nfc", assertConsistent: () => {} })
  unicode.files = [
    { ...unicode.files[0], sourcePath: composed.sourcePath, payloadPath: "records/a.bin" },
    { ...unicode.files[0], sourcePath: decomposed.sourcePath, payloadPath: "records/b.bin", nativeId: "other", revisionId: "urn:example:revision:two", representationId: "urn:example:representation:two", expectedByteDigest: decomposed.expectedByteDigest, expectedByteLength: decomposed.expectedByteLength },
  ]
  await assert.rejects(exportPortableTransfer(unicode), /NFC|restore path collision/i)
  const upper = await put(fx.sourceRoot, "A.txt", Buffer.from("upper")), lower = await put(fx.sourceRoot, "a.txt", Buffer.from("lower"))
  const caseFold: any = request(fx, upper, { snapshotId: "snap-case", assertConsistent: () => {} })
  caseFold.files = [
    { ...caseFold.files[0], sourcePath: upper.sourcePath, payloadPath: "records/c.bin" },
    { ...caseFold.files[0], sourcePath: lower.sourcePath, payloadPath: "records/d.bin", nativeId: "lower", revisionId: "urn:example:revision:three", representationId: "urn:example:representation:three", expectedByteDigest: lower.expectedByteDigest, expectedByteLength: lower.expectedByteLength },
  ]
  await assert.rejects(exportPortableTransfer(caseFold), /case|restore path collision/i)
})

test("PT02-C2: a Git worktree restore profile is explicitly external without a Git closure adapter", async (t) => {
  const fx = await fixture(t), file = await put(fx.sourceRoot, "source.bin", Buffer.from("payload"))
  const result = await exportPortableTransfer(request(fx, file, { snapshotId: "snap-git-profile", assertConsistent: () => {} }, { restoreProfile: "GIT_WORKTREE" }))
  assert.equal(result.selfContained, false)
  const inventory = JSON.parse(await readFile(join(result.bundlePath, "payload-bundle/inventory.json"), "utf8"))
  assert.ok(inventory.dependencies.some((dependency: { id: string, class: string }) => dependency.id.includes("git") && dependency.class === "EXTERNAL_REQUIRED"))
})

test("PT02-C3: packages policy and dictionary pins without host registration or machine-local secret paths", async (t) => {
  const fx = await fixture(t), file = await put(fx.sourceRoot, "source.bin", Buffer.from("payload"))
  const value = request(fx, file, { snapshotId: "snap-policy", assertConsistent: () => {} }, { snapshotProfile: "PINNED_BYTE_SET", aliasDictionary: { "native:한글": "records/item.bin" } })
  const pinned = { ...value, expectedClosureDigest: portableTransferClosureDigest(value.restoreProfile, value.files, []) }
  const result = await exportPortableTransfer(pinned)
  const rootText = await Promise.all((await tree(result.bundlePath)).map(async name => readFile(join(result.bundlePath, name), "utf8")))
  assert.ok(rootText.join("\n").includes("native:한글"))
  const policy = JSON.parse(await readFile(join(result.bundlePath, "payload-bundle/policy.json"), "utf8"))
  assert.equal(policy.snapshotProfile, "PINNED_BYTE_SET")
  assert.equal(policy.expectedClosureDigest, pinned.expectedClosureDigest)
  await assert.rejects(exportPortableTransfer(request(fx, file, { snapshotId: "snap-secret", assertConsistent: () => {} }, { aliasDictionary: { credential: "/home/user/.config/token" } })), /unsafe public alias dictionary/)
})

test("PT02-C1: duration budget expires before any complete bundle is published", async (t) => {
  const fx = await fixture(t), file = await put(fx.sourceRoot, "source.bin", Buffer.from("payload"))
  const owner = { snapshotId: "snap-time", assertConsistent: async () => { await new Promise(resolve => setTimeout(resolve, 8)) } }
  await assert.rejects(exportPortableTransfer(request(fx, file, owner, { maxDurationMs: 1 })), /duration budget/)
  assert.equal((await readdir(fx.destinationParent)).length, 0)
})

test("PT02-C1: PINNED_BYTE_SET accepts an optional host assertion but never relabels itself as OWNER_FROZEN", async (t) => {
  const fx = await fixture(t), file = await put(fx.sourceRoot, "source.bin", Buffer.from("payload"))
  const value = request(fx, file, { snapshotId: "logical-set" }, { snapshotProfile: "PINNED_BYTE_SET" })
  const pinned = await exportPortableTransfer({ ...value, expectedClosureDigest: portableTransferClosureDigest(value.restoreProfile, value.files, []) })
  const policy = JSON.parse(await readFile(join(pinned.bundlePath, "payload-bundle/policy.json"), "utf8"))
  assert.equal(policy.snapshotProfile, "PINNED_BYTE_SET")
  await assert.rejects(exportPortableTransfer(request(fx, file, { snapshotId: "missing-assertion" })), /requires an owner consistency assertion/)
  await assert.rejects(exportPortableTransfer(request(fx, file, { snapshotId: "unknown-profile", assertConsistent: () => {} }, { snapshotProfile: "UNVERIFIED" as any })), /snapshot profile|Invalid option/)
  await assert.rejects(exportPortableTransfer(request(fx, file, { snapshotId: "missing-closure" }, { snapshotProfile: "PINNED_BYTE_SET" })), /closure digest/)
})

test("PT02-C4: unsupported Git closure remains explicitly external and no arbitrary host program runs", async (t) => {
  const fx = await fixture(t), file = await put(fx.sourceRoot, "source.bin", Buffer.from("payload"))
  let calls = 0
  const result = await exportPortableTransfer(request(fx, file, { snapshotId: "snap-git", assertConsistent: () => { calls++ } }, { dependencies: [
    { id: "git-main-objects", class: "EXTERNAL_REQUIRED", required: true, reason: "Git closure adapter unavailable" },
    { id: "linked-worktree-head-index-config", class: "EXTERNAL_REQUIRED", required: true, reason: "Git closure adapter unavailable" },
    { id: "dirty-untracked-submodule-lfs-alternates", class: "EXTERNAL_REQUIRED", required: true, reason: "Git closure adapter unavailable" },
  ] }))
  assert.equal(result.selfContained, false)
  assert.equal(calls, 2)
  assert.equal((await lstat(result.bundlePath)).isDirectory(), true)
})

test("PT02-C3: the standalone CLI accepts only a bounded PINNED_BYTE_SET spec and exposes help", async (t) => {
  const fx = await fixture(t), file = await put(fx.sourceRoot, "source.bin", Buffer.from("cli payload"))
  const value = request(fx, file, { snapshotId: "cli-logical-set" }, { snapshotProfile: "PINNED_BYTE_SET" })
  const { destinationParent: _destinationParent, owner: _owner, ...portableSpec } = value
  const spec = { ...portableSpec, snapshotId: value.owner.snapshotId, dependencies: [], aliasDictionary: {}, expectedClosureDigest: portableTransferClosureDigest(value.restoreProfile, value.files, []) }
  const specPath = join(fx.root, "export-spec.json")
  await writeFile(specPath, JSON.stringify(spec))
  const run = await execFile("npm", ["run", "portable-transfer:export", "--", "--spec", specPath, "--destination-parent", fx.destinationParent], { cwd: process.cwd() })
  const result = JSON.parse(run.stdout.trim().split("\n").at(-1)!)
  assert.equal(result.snapshotId, "cli-logical-set")
  const help = await execFile("npm", ["run", "portable-transfer:export", "--", "--help"], { cwd: process.cwd() })
  assert.match(help.stdout, /--spec FILE --destination-parent DIRECTORY/)
  for (const [name, mutation] of [
    ["forged-owner-frozen", { snapshotProfile: "OWNER_FROZEN" }],
    ["unknown-field", { arbitraryProgram: "rm -rf /" }],
  ] as const) {
    const path = join(fx.root, `${name}.json`)
    await writeFile(path, JSON.stringify({ ...spec, ...mutation }))
    await assert.rejects(execFile("npm", ["run", "portable-transfer:export", "--", "--spec", path, "--destination-parent", fx.destinationParent], { cwd: process.cwd() }))
  }
  const oversized = join(fx.root, "oversized.json")
  await writeFile(oversized, " ".repeat(2 * 1024 * 1024 + 1))
  await assert.rejects(execFile("npm", ["run", "portable-transfer:export", "--", "--spec", oversized, "--destination-parent", fx.destinationParent], { cwd: process.cwd() }))
})

test("PT02-C4: a PINNED_BYTE_SET Git-worktree closure digest is computed over exactly one normalized Git closure", async (t) => {
  const fx = await fixture(t), file = await put(fx.sourceRoot, "source.bin", Buffer.from("git payload"))
  const value = request(fx, file, { snapshotId: "git-pinned" }, { snapshotProfile: "PINNED_BYTE_SET", restoreProfile: "GIT_WORKTREE" })
  const result = await exportPortableTransfer({ ...value, expectedClosureDigest: portableTransferClosureDigest(value.restoreProfile, value.files, []) })
  assert.equal(result.selfContained, false)
  const inventory = JSON.parse(await readFile(join(result.bundlePath, "payload-bundle/inventory.json"), "utf8"))
  assert.deepEqual(inventory.dependencies.map((item: { id: string }) => item.id), [
    "git-common-objects-refs-admin", "git-worktree-head-index-config", "git-dirty-untracked", "git-submodules", "git-lfs", "git-alternates",
  ])
  assert.ok(inventory.dependencies.every((item: { class: string; required: boolean }) => item.class === "EXTERNAL_REQUIRED" && item.required === true))
})

test("PT02-C1: any staged-payload tamper or extra staged entry after the final owner assertion aborts publication", async (t) => {
  const fx = await fixture(t), file = await put(fx.sourceRoot, "source.bin", Buffer.from("payload"))
  for (const mode of ["tamper", "extra"] as const) {
    let checks = 0
    const owner = { snapshotId: `stage-${mode}`, assertConsistent: async () => {
      checks++
      if (checks !== 2) return
      const [bundle] = await readdir(fx.destinationParent)
      const stage = join(fx.destinationParent, bundle!, ".staging")
      if (mode === "tamper") await writeFile(join(stage, "payload/records/item.bin"), "tampered")
      else await writeFile(join(stage, "unlisted.bin"), "unlisted")
    } }
    await assert.rejects(exportPortableTransfer(request(fx, file, owner)), /staged|payload|unexpected|verification/i)
    assert.equal((await readdir(fx.destinationParent)).length, 0)
  }
})

test("PT02-C1: time spent in the final owner assertion counts against the export duration", async (t) => {
  const fx = await fixture(t), file = await put(fx.sourceRoot, "source.bin", Buffer.from("payload"))
  let checks = 0
  const owner = { snapshotId: "late-owner", assertConsistent: async () => { if (++checks === 2) await new Promise(resolve => setTimeout(resolve, 12)) } }
  await assert.rejects(exportPortableTransfer(request(fx, file, owner, { maxDurationMs: 2 })), /duration budget/)
  assert.equal((await readdir(fx.destinationParent)).length, 0)
})

test("PT02-C3: CLI refuses a FIFO spec promptly instead of reading an unbounded stream", async (t) => {
  const fx = await fixture(t), fifo = join(fx.root, "spec.fifo")
  await execFile("mkfifo", [fifo])
  await assert.rejects(execFile("npm", ["run", "portable-transfer:export", "--", "--spec", fifo, "--destination-parent", fx.destinationParent], { cwd: process.cwd(), timeout: 500 }), /timed out|special|regular|FIFO|Command failed/i)
})

test("PT02-C2: dependency class and required semantics cannot be forged with JSON lookalikes", async (t) => {
  const fx = await fixture(t), file = await put(fx.sourceRoot, "source.bin", Buffer.from("payload"))
  for (const dependency of [
    { id: "external-string", class: "EXTERNAL_REQUIRED", required: "false", reason: "invalid boolean" },
    { id: "external-false", class: "EXTERNAL_REQUIRED", required: false, reason: "required external omitted" },
    { id: "optional-required", class: "OPTIONAL", required: true, reason: "optional cannot be required" },
  ] as const) {
    await assert.rejects(exportPortableTransfer(request(fx, file, { snapshotId: dependency.id, assertConsistent: () => {} }, { dependencies: [dependency] as any })), /invalid|expected|external|required|optional/i)
  }
})

test("PT02-C2: restore paths reject Windows-reserved, colon/control, and file-directory ambiguities", async (t) => {
  const fx = await fixture(t), file = await put(fx.sourceRoot, "source.bin", Buffer.from("payload")), owner = { snapshotId: "restore-paths", assertConsistent: () => {} }
  for (const sourcePath of ["CON.txt", "folder/name:stream", "control\u0001.txt"] as const) {
    const input: any = request(fx, file, owner); input.files = [{ ...input.files[0], sourcePath }]
    await assert.rejects(exportPortableTransfer(input), /restore|unsafe|reserved|path/i)
  }
  const ambiguous: any = request(fx, file, owner)
  ambiguous.files = [
    { ...ambiguous.files[0], sourcePath: "a", payloadPath: "records/a.bin" },
    { ...ambiguous.files[0], sourcePath: "a/child", payloadPath: "records/b.bin", nativeId: "child", revisionId: "urn:example:revision:child", representationId: "urn:example:representation:child" },
  ]
  await assert.rejects(exportPortableTransfer(ambiguous), /restore path collision|file.*directory/i)
})
