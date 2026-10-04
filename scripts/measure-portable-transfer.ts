#!/usr/bin/env node
/** Measure one verified restore in its own Node process; this never records a release claim. */
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { resolve } from "node:path"
import { importPortableTransfer, PORTABLE_TRANSFER_IMPORT_SCHEMA, recheckPortableRestore } from "../src/addons/portable-transfer-import.js"

const usage = "usage: node --import tsx scripts/measure-portable-transfer.ts --bundle PATH --receipt-digest sha256:... --destination-parent PATH --destination-name NAME --owner-namespace IRI"
const args = process.argv.slice(2)
if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) { process.stdout.write(`${usage}\n`); process.exit(0) }
const values = new Map<string, string>()
for (let index = 0; index < args.length; index += 2) {
  const key = args[index], value = args[index + 1]
  if (!key || !value || !["--bundle", "--receipt-digest", "--destination-parent", "--destination-name", "--owner-namespace"].includes(key) || values.has(key)) throw new Error(usage)
  values.set(key, value)
}
if (values.size !== 5) throw new Error(usage)

async function hash(path: string, expectedBytes: number, expectedDigest: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  const digest = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024)
  let bytes = 0
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size !== expectedBytes) throw new Error("restored path is not the expected regular file")
    for (;;) {
      const read = await handle.read(buffer, 0, buffer.length, null)
      if (!read.bytesRead) break
      bytes += read.bytesRead
      if (bytes > expectedBytes) throw new Error("restored file exceeds the pinned byte length")
      digest.update(buffer.subarray(0, read.bytesRead))
    }
    const after = await handle.stat()
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("restored file changed while measuring")
  } finally { await handle.close() }
  const actual = `sha256:${digest.digest("hex")}`
  if (bytes !== expectedBytes || actual !== expectedDigest) throw new Error("restored bytes do not match the manifest")
  return { bytes, digest: actual }
}

const started = process.hrtime.bigint()
const result = await importPortableTransfer({
  schema: PORTABLE_TRANSFER_IMPORT_SCHEMA,
  bundlePath: resolve(values.get("--bundle")!),
  destinationParent: resolve(values.get("--destination-parent")!),
  destinationName: values.get("--destination-name")!,
  expectedReceiptDigest: values.get("--receipt-digest")!,
  allowedOwnerNamespace: values.get("--owner-namespace")!,
})
const importElapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000
const hashStarted = process.hrtime.bigint()
const payloads: Array<{ bytes: number, digest: string }> = []
for (const file of result.restored) {
  const path = resolve(result.destinationPath, file.restorePath)
  const representation = result.manifest.representations.find(item => item.id === file.representationId)
  if (!representation) throw new Error("restored representation is absent from manifest")
  payloads.push(await hash(path, representation.byteLength, representation.byteDigest))
}
const hashElapsedMs = Number(process.hrtime.bigint() - hashStarted) / 1_000_000
await recheckPortableRestore(result)
const usageNow = process.resourceUsage()
process.stdout.write(`${JSON.stringify({
  schema: "usl-portable-transfer-measurement/v1",
  scope: "one local import process; benchmark only, not an operation-effect or Lean-proof claim",
  pid: process.pid,
  platform: process.platform,
  node: process.version,
  importedBytes: payloads.reduce((total, value) => total + value.bytes, 0),
  restoredFiles: result.restored.length,
  importWallMs: importElapsedMs,
  postRestoreHashWallMs: hashElapsedMs,
  postRestoreDigests: payloads.map(value => value.digest),
  peakRssKiB: usageNow.maxRSS,
  executionCalls: result.executionCalls,
  operations: result.operations,
})}\n`)
