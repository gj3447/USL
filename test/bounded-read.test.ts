import assert from "node:assert/strict"
import { test } from "node:test"
import { appendFile, open, readFile, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { readBytesBounded, readUtf8Bounded } from "../src/bounded-read.js"
import { temporary } from "./fixtures.js"

const root = fileURLToPath(new URL("..", import.meta.url))
const cli = (args: string[]) => new Promise<{ code: number; stderr: string }>((resolve) => {
  execFile(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: root, env: { ...process.env, USL_GIT_REPOS: "{}", USL_KG_SOURCES: "{}" } }, (error, _stdout, stderr) => {
    resolve({ code: typeof error?.code === "number" ? error.code : error ? 1 : 0, stderr })
  })
})

type FileHandlePrototype = {
  read: (...args: any[]) => Promise<{ bytesRead: number }>
  stat: (...args: any[]) => Promise<unknown>
  emit: (...args: any[]) => boolean
}

const fileHandlePrototype = async (path: string) => {
  const handle = await open(path, "r")
  const prototype = Object.getPrototypeOf(handle) as FileHandlePrototype
  await handle.close()
  return prototype
}

test("bounded reader accepts empty, exact-limit and UTF-8 boundary content", async (t) => {
  const dir = await temporary(t), empty = join(dir, "empty.json"), exact = join(dir, "exact.json"), utf8 = join(dir, "utf8.json")
  await writeFile(empty, "")
  await writeFile(exact, "abcd")
  // Force one multibyte character across the 64 KiB internal read boundary.
  const prefix = "a".repeat(64 * 1024 - 1), value = `${prefix}é`
  await writeFile(utf8, value, "utf8")
  assert.equal(await readUtf8Bounded(empty, 0), "")
  assert.equal(await readUtf8Bounded(exact, 4), "abcd")
  assert.equal(await readUtf8Bounded(utf8, Buffer.byteLength(value)), value)
})

test("bounded reader reads only a limit probe from a much larger file and closes after rejection", async (t) => {
  const dir = await temporary(t), input = join(dir, "over.json"), limit = 17
  await writeFile(input, Buffer.alloc(512 * 1024, "a"))
  const prototype = await fileHandlePrototype(input)
  const originalRead = prototype.read
  // FileHandle installs close as an own, bound method. Its documented close
  // completion emits the EventEmitter "close" event, which lets this isolated
  // test observe the handle created inside the reader without replacing fs.
  const eventPrototype = Object.getPrototypeOf(prototype) as FileHandlePrototype
  const originalEmit = eventPrototype.emit
  let bytesRead = 0, closeCalls = 0
  prototype.read = async function (this: unknown, ...args: any[]) {
    const result = await originalRead.apply(this, args)
    bytesRead += result.bytesRead
    return result
  }
  eventPrototype.emit = function (this: unknown, ...args: any[]) {
    if (args[0] === "close") closeCalls += 1
    return originalEmit.apply(this, args)
  }
  try {
    await assert.rejects(readUtf8Bounded(input, limit), /exceeds maxInputBytes/)
    assert.ok(bytesRead > 0)
    assert.ok(bytesRead <= limit + 1, `reader consumed ${bytesRead} bytes for a ${limit}-byte limit`)
    assert.equal(closeCalls, 1)
  } finally {
    prototype.read = originalRead
    eventPrototype.emit = originalEmit
  }
})

test("bounded reader rejects a file that grows after its handle stat without exceeding the probe", async (t) => {
  const dir = await temporary(t), input = join(dir, "growing.json"), limit = 4
  await writeFile(input, "okay")
  const prototype = await fileHandlePrototype(input)
  const originalRead = prototype.read, originalStat = prototype.stat
  let bytesRead = 0, grew = false
  prototype.read = async function (this: unknown, ...args: any[]) {
    const result = await originalRead.apply(this, args)
    bytesRead += result.bytesRead
    return result
  }
  prototype.stat = async function (this: unknown, ...args: any[]) {
    const result = await originalStat.apply(this, args)
    if (!grew) { grew = true; await appendFile(input, Buffer.alloc(512 * 1024, "b")) }
    return result
  }
  try {
    await assert.rejects(readUtf8Bounded(input, limit), /exceeds maxInputBytes/)
    assert.equal(grew, true)
    assert.ok(bytesRead <= limit + 1, `reader consumed ${bytesRead} bytes after growth`)
  } finally {
    prototype.read = originalRead
    prototype.stat = originalStat
  }
})

test("bounded reader rejects non-files and invalid budgets", async (t) => {
  const dir = await temporary(t)
  await assert.rejects(readUtf8Bounded(dir, 1), /regular file/)
  await assert.rejects(readUtf8Bounded(join(dir, "none"), -1), /nonnegative safe integer/)
})

test("bounded reader honors an aborted signal before opening or reading", async (t) => {
  const dir = await temporary(t), input = join(dir, "cancelled.json")
  await writeFile(input, "content")
  await assert.rejects(readBytesBounded(input, 7, { signal: AbortSignal.abort() }), { name: "AbortError" })
})

test("adapt CLI rejects an oversized valid graph before creating --out", async (t) => {
  const dir = await temporary(t), graph = join(dir, "large-graph.json"), out = join(dir, "result.json")
  // Whitespace keeps the JSON valid, so rejection proves the source-byte
  // limit rather than GraphSpec/property-graph validation.
  const source = `${JSON.stringify({ nodes: [], relations: [] })}${" ".repeat(1024 * 1024 + 1)}`
  await writeFile(graph, source, "utf8")
  const result = await cli(["adapt", "--graph", graph, "--namespace", "bounded.cli", "--operation", "check", "--out", out])
  assert.equal(result.code, 1, result.stderr)
  await assert.rejects(readFile(out, "utf8"), { code: "ENOENT" })
  assert.equal(await readFile(graph, "utf8"), source)
})
