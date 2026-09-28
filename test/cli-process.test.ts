import assert from "node:assert/strict"
import { test } from "node:test"
import { access, readFile } from "node:fs/promises"
import { join } from "node:path"
import { runCliProcess } from "../src/cli-process.js"
import { temporary } from "./fixtures.js"

const run = (code: string, extra: Partial<Parameters<typeof runCliProcess>[0]> = {}) => runCliProcess({
  executable: process.execPath, args: ["-e", code], cwd: process.cwd(), env: {}, input: "{\"input\":true}", timeoutMs: 5_000, maxOutputBytes: 1_024, ...extra,
})
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const waitFor = async (predicate: () => Promise<boolean>, label: string, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { if (await predicate()) return; await pause(10) }
  throw new Error(`timed out waiting for ${label}`)
}
const waitForFile = (file: string) => waitFor(async () => access(file).then(() => true, () => false), file)

test("process runner captures a clean UTF-8 process with a fixed environment", async () => {
  const result = await run("process.stdout.write(process.env.PATH === undefined ? 'ok' : 'bad')")
  assert.deepEqual(result, { started: true, exitCode: 0, signal: null, stdout: "ok", stderr: "", outputBytes: 2, truncated: false, reason: null })
})

test("process runner applies one aggregate output budget at exact and overflowing boundaries", async () => {
  const exact = await run("process.stdout.write('ab'); process.stderr.write('cd')", { maxOutputBytes: 4 })
  assert.equal(exact.reason, null); assert.equal(exact.outputBytes, 4); assert.equal(exact.truncated, false)
  const over = await run("process.stdout.write('ab'); process.stderr.write('cde'); setTimeout(() => {}, 500)", { maxOutputBytes: 4 })
  assert.equal(over.reason, "OUTPUT_LIMIT"); assert.ok(over.outputBytes > 4); assert.equal(over.truncated, true)
  assert.ok(Buffer.byteLength(over.stdout) + Buffer.byteLength(over.stderr) <= 4)
})

test("process runner rejects malformed UTF-8 and nonzero exits", async () => {
  const invalid = await run("process.stdout.write(Buffer.from([0xc3, 0x28]))")
  assert.equal(invalid.reason, "INVALID_UTF8")
  const failed = await run("process.stderr.write('no'); process.exit(7)")
  assert.equal(failed.reason, "NONZERO_EXIT"); assert.equal(failed.exitCode, 7); assert.equal(failed.stderr, "no")
})

test("process runner terminates a timed-out child after its side effect", async t => {
  const dir = await temporary(t), marker = join(dir, "effect")
  const pending = run(`process.stdout.write('effect', () => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready')); setInterval(() => {}, 1000)`, { timeoutMs: 1_000 })
  await waitForFile(marker)
  const result = await pending
  assert.equal(result.started, true); assert.equal(result.reason, "TIMEOUT"); assert.equal(result.exitCode, null)
  assert.equal(result.stdout, "effect")
})

test("process runner does not spawn when already aborted", async () => {
  const controller = new AbortController(); controller.abort()
  const result = await run("process.stdout.write('should-not-run')", { signal: controller.signal })
  assert.deepEqual(result, { started: false, exitCode: null, signal: null, stdout: "", stderr: "", outputBytes: 0, truncated: false, reason: "ABORTED" })
})

test("process runner reports a missing executable without hanging", async () => {
  const result = await runCliProcess({ executable: "/definitely/not/a/usl-command", args: [], cwd: process.cwd(), env: {}, input: "", timeoutMs: 100, maxOutputBytes: 1 })
  assert.equal(result.started, false); assert.equal(result.reason, "SPAWN_ERROR")
})

test("process runner aborts a running child", async t => {
  const dir = await temporary(t), marker = join(dir, "ready")
  const controller = new AbortController()
  const pending = run(`process.stdout.write('effect', () => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready')); setInterval(() => {}, 1000)`, { signal: controller.signal })
  await waitForFile(marker)
  controller.abort()
  const result = await pending
  assert.equal(result.started, true); assert.equal(result.reason, "ABORTED"); assert.equal(result.stdout, "effect")
})

test("process runner kills a POSIX process group after abort", { skip: process.platform === "win32" }, async t => {
  const dir = await temporary(t), pidFile = join(dir, "grandchild.pid")
  const controller = new AbortController()
  const code = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(()=>{},1000)`
  const pending = run(code, { signal: controller.signal })
  await waitForFile(pidFile)
  const pid = Number(await readFile(pidFile, "utf8"))
  controller.abort()
  const result = await pending
  assert.equal(result.reason, "ABORTED"); assert.ok(Number.isSafeInteger(pid))
  await waitFor(async () => {
    try { process.kill(pid, 0) }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" }
    if (process.platform !== "linux") return false
    const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "")
    return /\) Z /.test(stat) // A zombie has exited and cannot retain work or stdio.
  }, "grandchild exit")
})
