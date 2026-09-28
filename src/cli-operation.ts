/** Optional, host-owned reservations for logical operations. No remote exactly-once claim. */
import { constants } from "node:fs"
import { mkdir, open, realpath, lstat } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { contractDigest, contractHash, contractSnapshot, contractText, freezeContract } from "./contract-core.js"

export const cliOperationStoreSchema = z.strictObject({ namespace: contractText, directory: contractText })
export const cliOperationKeySchema = z.string().min(1).max(256).regex(/\S/u).regex(/^[^\u0000-\u001f\u007f]+$/u)
export const cliOperationBindingSchema = z.strictObject({ namespace: contractText, key: cliOperationKeySchema, semanticDigest: contractHash })
export type CliOperationBinding = z.infer<typeof cliOperationBindingSchema>
const reservationSchema = z.strictObject({
  schema: z.literal("usl-cli-operation-reservation/v1"), operation: cliOperationBindingSchema,
  attempt: contractText, intentDigest: contractHash, planDigest: contractHash,
  receiptDirectory: contractText, createdAt: z.string().datetime(), reservationDigest: contractHash,
})
type AttemptReference = Pick<z.infer<typeof reservationSchema>, "attempt" | "intentDigest" | "planDigest" | "receiptDirectory" | "createdAt">
const syncDirectory = async (directory: string) => {
  if (process.platform === "win32") return
  const handle = await open(directory, "r")
  try { await handle.sync() } finally { await handle.close() }
}

const readReservation = async (directory: string) => {
  if (!(await lstat(directory)).isDirectory()) throw new Error("operation reservation must be a real directory")
  const file = await open(join(directory, "reservation.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!(await file.stat()).isFile()) throw new Error("operation reservation must be a regular file")
    const buffer = Buffer.alloc(64 * 1024 + 1)
    let used = 0
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, used)
      if (!bytesRead) break
      used += bytesRead
    }
    if (used > 64 * 1024) throw new Error("operation reservation exceeds byte limit")
    const value = reservationSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, used))))
    const { reservationDigest, ...body } = value
    if (contractDigest(body) !== reservationDigest) throw new Error("operation reservation digest mismatch")
    return freezeContract(value)
  } finally { await file.close() }
}

/** A crashed/incomplete reservation blocks repeats. Reservations are never automatically released. */
export const reserveCliOperation = async (storeDirectory: string, input: CliOperationBinding, reference: AttemptReference) => {
  const operation = freezeContract(cliOperationBindingSchema.parse(contractSnapshot(input)))
  const captured = contractSnapshot(reference)
  const body = { schema: "usl-cli-operation-reservation/v1" as const, operation, ...captured }
  const reservation = reservationSchema.parse({ ...body, reservationDigest: contractDigest(body) })
  await mkdir(storeDirectory, { recursive: true, mode: 0o700 })
  const store = await realpath(storeDirectory)
  const id = contractDigest({ namespace: operation.namespace, key: operation.key }).slice(7)
  const directory = join(store, id)
  try { await mkdir(directory, { mode: 0o700 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    try {
      const existing = await readReservation(directory)
      const same = existing.operation.namespace === operation.namespace && existing.operation.key === operation.key && existing.operation.semanticDigest === operation.semanticDigest
      return freezeContract({ status: "REJECTED" as const, reason: same ? "OPERATION_ALREADY_RESERVED" as const : "OPERATION_KEY_CONFLICT" as const,
        previous: { attempt: existing.attempt, intentDigest: existing.intentDigest, planDigest: existing.planDigest, reservationDigest: existing.reservationDigest } })
    } catch {
      return freezeContract({ status: "REJECTED" as const, reason: "OPERATION_RESERVATION_UNKNOWN" as const })
    }
  }
  // Persist the directory entry before its contents, so a crash leaves a blocker.
  await syncDirectory(store)
  const file = await open(join(directory, "reservation.json"), "wx", 0o600)
  try { await file.writeFile(JSON.stringify(reservation, null, 2) + "\n"); await file.sync() } finally { await file.close() }
  await syncDirectory(directory)
  return freezeContract({ status: "RESERVED" as const, reservationDigest: reservation.reservationDigest })
}
