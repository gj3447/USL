// Local JSON import/export storage. Compare-and-swap protects cooperative concurrent writers.
import { promises as fs } from "node:fs"
import { randomUUID } from "node:crypto"
import * as path from "node:path"
import type { UslRecord } from "./domain.js"
import { validateRecords } from "./validation.js"

export interface RecordSnapshot {
  readonly path: string
  readonly raw: string | null
  readonly records: ReadonlyArray<UslRecord>
}
const readOptional = async (file: string): Promise<string | null> => {
  try { return await fs.readFile(file, "utf8") }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e }
}
export const readRecords = async (file: string, allowMissing = false): Promise<RecordSnapshot> => {
  const absolute = path.resolve(file)
  const raw = await readOptional(absolute)
  if (raw === null && !allowMissing) throw new Error(`records file does not exist: ${absolute}`)
  return { path: absolute, raw, records: raw === null ? [] : validateRecords(JSON.parse(raw)) }
}
export const writeTextAtomic = async (file: string, text: string, expected?: string | null): Promise<void> => {
  const absolute = path.resolve(file)
  const lockPath = `${absolute}.lock`
  const lock = await fs.open(lockPath, "wx", 0o600).catch((e: NodeJS.ErrnoException) => { throw new Error(e.code === "EEXIST" ? `another writer holds ${lockPath}` : String(e)) })
  const temp = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${randomUUID()}.tmp`)
  let committed = false
  try {
    const stat = await fs.lstat(absolute).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e })
    if (stat && !stat.isFile()) throw new Error(`output must be a regular file: ${absolute}`)
    if (expected !== undefined && await readOptional(absolute) !== expected) throw new Error(`records changed during operation; retry: ${absolute}`)
    const handle = await fs.open(temp, "wx", stat ? stat.mode & 0o777 : 0o600)
    try { await handle.writeFile(text); await handle.sync() } finally { await handle.close() }
    await fs.rename(temp, absolute)
    committed = true
  } finally {
    const cleanup = await Promise.allSettled([fs.rm(temp, { force: true }), lock.close()])
    cleanup.push(await fs.unlink(lockPath).then(() => ({ status: "fulfilled" as const, value: undefined }), (reason: unknown) => ({ status: "rejected" as const, reason })))
    if (cleanup.some((r) => r.status === "rejected")) console.error(`USL: ${committed ? "write committed" : "write not committed"}; cleanup incomplete for ${absolute}; check temporary files and writer lock`)
  }
}
export const writeRecords = async (snapshot: RecordSnapshot, records: ReadonlyArray<UslRecord>): Promise<void> => {
  const validated = validateRecords(records)
  await writeTextAtomic(snapshot.path, JSON.stringify(validated, null, 2) + "\n", snapshot.raw)
}
