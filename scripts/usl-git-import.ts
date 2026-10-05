#!/usr/bin/env node
/** CP02: import only explicitly pinned Git data; never execute restored programs. */
import { constants } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { importCleanGitTransfer } from "../src/addons/portable-transfer-git.js"

const usage = "usage: tsx scripts/usl-git-import.ts --spec FILE --destination-parent DIRECTORY --destination-name NAME"
const args = process.argv.slice(2)
if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  process.stdout.write(`${usage}\n`)
  process.exit(0)
}
if (args.length !== 6 || args[0] !== "--spec" || args[2] !== "--destination-parent" || args[4] !== "--destination-name") throw new Error(usage)
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
if (Object.hasOwn(spec, "destinationParent") || Object.hasOwn(spec, "destinationName")) throw new Error("destinationParent/destinationName must be selected by the caller flag")
if (typeof spec.bundlePath !== "string" || !isAbsolute(spec.bundlePath)) throw new Error("spec bundlePath must be absolute")
const result = await importCleanGitTransfer({ ...spec, destinationParent, destinationName: args[5] })
process.stdout.write(`${JSON.stringify(result)}\n`)
