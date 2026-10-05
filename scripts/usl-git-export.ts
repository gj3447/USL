#!/usr/bin/env node
/** CP01: explicit owner-selected clean Git export, with no restore or execution hook. */
import { constants } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { exportCleanGitTransfer } from "../src/addons/portable-transfer-git.js"

const usage = "usage: tsx scripts/usl-git-export.ts --spec FILE --destination-parent DIRECTORY"
const args = process.argv.slice(2)
if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  process.stdout.write(`${usage}\n`)
  process.exit(0)
}
if (args.length !== 4 || args[0] !== "--spec" || args[2] !== "--destination-parent") throw new Error(usage)
const path = resolve(args[1]!), destinationParent = resolve(args[3]!)
const before = await lstat(path)
if (!before.isFile() || before.isSymbolicLink() || before.size > 2 * 1024 * 1024) throw new Error("spec must be a regular non-symlink file of at most 2 MiB")
const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
let bytes: Buffer
try {
  const opened = await handle.stat()
  if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error("spec changed before reading")
  const buffer = Buffer.alloc(before.size + 1)
  let length = 0
  while (length < buffer.length) {
    const result = await handle.read(buffer, length, buffer.length - length, null)
    if (result.bytesRead === 0) break
    length += result.bytesRead
  }
  const after = await handle.stat()
  if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("spec changed during reading")
  bytes = buffer.subarray(0, length)
} finally {
  await handle.close()
}
const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("spec must be an object")
const spec = input as Record<string, unknown>
if (Object.hasOwn(spec, "destinationParent")) throw new Error("destinationParent must be selected by the caller flag")
if (typeof spec.sourceRoot !== "string" || !isAbsolute(spec.sourceRoot)) throw new Error("spec sourceRoot must be absolute")
const result = await exportCleanGitTransfer({ ...spec, destinationParent })
process.stdout.write(`${JSON.stringify(result)}\n`)
