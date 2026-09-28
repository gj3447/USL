import { spawn } from "node:child_process"

export type CliProcessReason = "TIMEOUT" | "OUTPUT_LIMIT" | "ABORTED" | "SPAWN_ERROR" | "NONZERO_EXIT" | "INVALID_UTF8"

export interface CliProcessOptions {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  /** The child receives only these variables; it never inherits the caller's environment. */
  readonly env: Readonly<Record<string, string>>
  readonly input: string
  readonly timeoutMs: number
  /** Combined stdout and stderr byte budget. */
  readonly maxOutputBytes: number
  readonly signal?: AbortSignal
}

export interface CliProcessResult {
  readonly started: boolean
  readonly exitCode: number | null
  readonly signal: string | null
  /** Captured prefixes, decoded only when their bytes are valid UTF-8. */
  readonly stdout: string
  readonly stderr: string
  /** Raw bytes observed across stdout and stderr, including uncaptured bytes. */
  readonly outputBytes: number
  readonly truncated: boolean
  readonly reason: CliProcessReason | null
}

const GRACE_MS = 100
const empty = (reason: CliProcessReason): CliProcessResult => ({
  started: false, exitCode: null, signal: null, stdout: "", stderr: "", outputBytes: 0, truncated: false, reason,
})

const valid = (value: number, minimum: number): boolean => Number.isSafeInteger(value) && value >= minimum
const decode = (chunks: readonly Buffer[]): string => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))

/**
 * Execute one host-selected CLI process. This is a transport boundary only:
 * it does not treat a zero exit status as a validated capability result.
 */
export const runCliProcess = (options: CliProcessOptions): Promise<CliProcessResult> => {
  if (!valid(options.timeoutMs, 1)) return Promise.reject(new Error("timeoutMs must be a positive safe integer"))
  if (!valid(options.maxOutputBytes, 0)) return Promise.reject(new Error("maxOutputBytes must be a nonnegative safe integer"))
  if (options.signal?.aborted) return Promise.resolve(empty("ABORTED"))

  return new Promise(resolve => {
    const child = spawn(options.executable, [...options.args], {
      cwd: options.cwd,
      env: { ...options.env },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      // A POSIX group lets timeout/cancellation terminate a command's direct
      // descendants too. Windows retains the direct-child fallback below.
      detached: process.platform !== "win32",
    })
    let settled = false
    let started = false
    let exitCode: number | null = null
    let exitSignal: string | null = null
    let reason: CliProcessReason | null = null
    let outputBytes = 0
    let capturedBytes = 0
    let truncated = false
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    let timeout: NodeJS.Timeout | undefined
    let forceKill: NodeJS.Timeout | undefined
    let forceSettle: NodeJS.Timeout | undefined

    const kill = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return
      try {
        if (process.platform !== "win32") process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch {
        // The process may have exited between its close event and this kill.
      }
    }
    const terminate = (cause: CliProcessReason) => {
      if (reason !== null) return
      reason = cause
      kill("SIGTERM")
      forceKill = setTimeout(() => {
        kill("SIGKILL")
        // A descendant can retain inherited stdio after the direct child has
        // gone away. Destroy our pipe ends and settle shortly after SIGKILL so
        // a caller never waits forever for that descendant's close event.
        child.stdin?.destroy()
        child.stdout?.destroy()
        child.stderr?.destroy()
        forceSettle = setTimeout(() => finish(true), GRACE_MS)
      }, GRACE_MS)
      forceKill.unref()
    }
    const capture = (target: Buffer[]) => (chunk: Buffer | Uint8Array) => {
      const bytes = Buffer.from(chunk)
      outputBytes += bytes.byteLength
      const remaining = options.maxOutputBytes - capturedBytes
      if (remaining > 0) {
        const part = bytes.byteLength <= remaining ? bytes : bytes.subarray(0, remaining)
        target.push(part)
        capturedBytes += part.byteLength
      }
      if (outputBytes > options.maxOutputBytes) {
        truncated = true
        terminate("OUTPUT_LIMIT")
      }
    }
    const onStdout = capture(stdout), onStderr = capture(stderr)
    const onAbort = () => terminate("ABORTED")
    const onStdinError = () => { /* EPIPE is an ordinary outcome for a rejecting child. */ }
    const onStreamError = () => { /* Destroyed pipes must not surface as uncaught errors. */ }
    const cleanup = (forced: boolean) => {
      if (timeout) clearTimeout(timeout)
      if (forceKill) clearTimeout(forceKill)
      if (forceSettle) clearTimeout(forceSettle)
      options.signal?.removeEventListener("abort", onAbort)
      child.stdout?.removeListener("data", onStdout)
      child.stderr?.removeListener("data", onStderr)
      if (!forced) {
        child.stdin?.removeListener("error", onStdinError)
        child.stdout?.removeListener("error", onStreamError)
        child.stderr?.removeListener("error", onStreamError)
        child.removeListener("error", onError)
        child.removeListener("spawn", onSpawn)
        child.removeListener("close", onClose)
      }
    }
    const finish = (forced = false) => {
      if (settled) return
      settled = true
      // `close` can arrive when the direct child accepted SIGTERM while a
      // process it spawned survives. A final group kill prevents that child
      // from escaping merely because it closed its inherited stdio promptly.
      if (reason !== null && started) kill("SIGKILL")
      cleanup(forced)
      let decodedStdout = "", decodedStderr = ""
      try { decodedStdout = decode(stdout); decodedStderr = decode(stderr) }
      catch { if (reason === null) reason = "INVALID_UTF8" }
      if (reason === null && exitCode !== 0) reason = "NONZERO_EXIT"
      resolve({ started, exitCode, signal: exitSignal, stdout: decodedStdout, stderr: decodedStderr, outputBytes, truncated, reason })
    }
    const onError = () => {
      reason = reason ?? "SPAWN_ERROR"
      finish()
    }
    const onSpawn = () => { started = true }
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      exitCode = code
      exitSignal = signal
      finish()
    }

    child.once("error", onError)
    child.once("spawn", onSpawn)
    child.once("close", onClose)
    child.stdout?.on("data", onStdout)
    child.stderr?.on("data", onStderr)
    child.stdin?.on("error", onStdinError)
    child.stdout?.on("error", onStreamError)
    child.stderr?.on("error", onStreamError)
    options.signal?.addEventListener("abort", onAbort, { once: true })
    timeout = setTimeout(() => terminate("TIMEOUT"), options.timeoutMs)
    timeout.unref()
    // Stream error is consumed above; it must not become an uncaught EPIPE.
    child.stdin?.end(options.input, "utf8")
    if (options.signal?.aborted) terminate("ABORTED")
  })
}
