import { open } from "node:fs/promises"

const CHUNK_BYTES = 64 * 1024

/**
 * Read at most `maxBytes` UTF-8 source bytes from one opened file handle.
 * The extra byte read detects a file that is already over budget or grows
 * while it is being read; no path `stat()` result is trusted for that limit.
 */
export const readUtf8Bounded = async (path: string, maxBytes: number): Promise<string> => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("maxBytes must be a nonnegative safe integer")
  const handle = await open(path, "r")
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error("source must be a regular file")
    const chunks: Buffer[] = []
    let total = 0
    while (total <= maxBytes) {
      const remainingWithProbe = maxBytes + 1 - total
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, remainingWithProbe))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total)
      if (bytesRead === 0) break
      chunks.push(buffer.subarray(0, bytesRead))
      total += bytesRead
    }
    if (total > maxBytes) throw new Error("source exceeds maxInputBytes")
    // Decode once after byte accounting, so multibyte characters crossing a
    // read boundary are decoded exactly as Node's normal UTF-8 read does.
    return Buffer.concat(chunks, total).toString("utf8")
  } finally { await handle.close() }
}
