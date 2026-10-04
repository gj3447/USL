#!/usr/bin/env node
/** Standalone, fixed-format PT02 exporter.  It has no adapter/program execution hook. */
import { constants } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { exportPortableTransfer, PORTABLE_TRANSFER_EXPORT_SCHEMA, type PortableTransferDependency, type FrozenPortableTransferFile } from "../src/addons/portable-transfer-export.js"

const usage = "usage: tsx scripts/usl-transfer-export.ts --spec FILE --destination-parent DIRECTORY"
const args = process.argv.slice(2)
if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) { process.stdout.write(`${usage}\n`); process.exit(0) }
if (args.length !== 4 || args[0] !== "--spec" || args[2] !== "--destination-parent") throw new Error(usage)
const specPath = resolve(args[1]!), destinationParent = resolve(args[3]!)
const before = await lstat(specPath)
if (!before.isFile() || before.isSymbolicLink()) throw new Error("spec must be a regular non-symlink file")
if (before.size > 2 * 1024 * 1024) throw new Error("spec exceeds 2 MiB")
const handle = await open(specPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
let bytes: Buffer
try {
  const opened = await handle.stat()
  if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error("spec changed before reading")
  bytes = Buffer.alloc(before.size + 1)
  let length = 0
  while (length < bytes.length) {
    const next = await handle.read(bytes, length, bytes.length - length, null)
    if (!next.bytesRead) break
    length += next.bytesRead
  }
  const after = await handle.stat()
  if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("spec changed during reading")
  bytes = bytes.subarray(0, length)
} finally { await handle.close() }
const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
const spec: unknown = JSON.parse(text)
if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("spec must be an object")
const value = spec as Record<string, unknown>
const allowed = new Set(["schema", "sourceRoot", "ownerNamespace", "issuer", "observedAt", "snapshotId", "snapshotProfile", "expectedClosureDigest", "restoreProfile", "files", "dependencies", "aliasDictionary", "maxTotalBytes", "maxDurationMs"])
for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown spec field: ${key}`)
if (value.schema !== PORTABLE_TRANSFER_EXPORT_SCHEMA || value.snapshotProfile !== "PINNED_BYTE_SET") throw new Error("CLI requires usl-portable-transfer-export/v1 PINNED_BYTE_SET; it cannot assert an owner-frozen snapshot")
if (typeof value.sourceRoot !== "string" || !isAbsolute(value.sourceRoot) || typeof value.snapshotId !== "string" || !value.snapshotId || typeof value.expectedClosureDigest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value.expectedClosureDigest)) throw new Error("CLI spec needs absolute sourceRoot, snapshotId, and predeclared closure digest")
if (!Array.isArray(value.files) || value.files.length === 0 || !Array.isArray(value.dependencies)) throw new Error("CLI spec needs explicit files and dependency inventory")
const maxTotalBytes = optionalNumber(value.maxTotalBytes, "maxTotalBytes"), maxDurationMs = optionalNumber(value.maxDurationMs, "maxDurationMs")
const result = await exportPortableTransfer({
  schema: PORTABLE_TRANSFER_EXPORT_SCHEMA,
  sourceRoot: value.sourceRoot,
  destinationParent,
  ownerNamespace: string(value.ownerNamespace, "ownerNamespace"), issuer: string(value.issuer, "issuer"), observedAt: string(value.observedAt, "observedAt"),
  owner: { snapshotId: value.snapshotId }, snapshotProfile: "PINNED_BYTE_SET", expectedClosureDigest: value.expectedClosureDigest,
  restoreProfile: string(value.restoreProfile, "restoreProfile"), files: value.files as FrozenPortableTransferFile[], dependencies: value.dependencies as PortableTransferDependency[],
  ...(value.aliasDictionary === undefined ? {} : { aliasDictionary: object(value.aliasDictionary, "aliasDictionary") as Record<string, string> }),
  ...(maxTotalBytes === undefined ? {} : { maxTotalBytes }), ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
})
process.stdout.write(`${JSON.stringify(result)}\n`)

function string(input: unknown, name: string) { if (typeof input !== "string") throw new Error(`spec ${name} must be a string`); return input }
function object(input: unknown, name: string) { if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`spec ${name} must be an object`); return input }
function optionalNumber(input: unknown, name: string) { if (input === undefined) return undefined; if (typeof input !== "number" || !Number.isSafeInteger(input)) throw new Error(`spec ${name} must be a safe integer`); return input }
