/** Automatic per-file plan refresh. A failed edit never replaces the last valid snapshot. */
import { watch, type FSWatcher } from "node:fs"
import { open, stat } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import { Either } from "effect"
import { compileSource, digestSource, planDigest } from "./language/index.js"
import type { UslProgramSnapshot } from "./application.js"

export interface ProgramFileOptions { readonly maxSourceBytes?: number; readonly watch?: boolean; readonly debounceMs?: number }
export interface ProgramStatus {
  readonly path: string
  readonly revision: number
  readonly sourceDigest: string
  readonly planDigest: string
  readonly state: "CURRENT" | "INVALID_EDIT" | "CLOSED"
  readonly error: string | null
  readonly compilations: number
  readonly bytesRead: number
}
export interface ProgramUpdate { readonly changed: boolean; readonly status: ProgramStatus }
export interface ProgramFile {
  snapshot(): UslProgramSnapshot
  status(): ProgramStatus
  refresh(): Promise<ProgramUpdate>
  subscribe(listener: (update: ProgramUpdate) => void): () => void
  close(): void
}
const freeze = <A>(value: A): A => {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

export const openProgramFile = async (inputPath: string, inputOptions: ProgramFileOptions = {}): Promise<ProgramFile> => {
  const file = resolve(inputPath)
  const options = { maxSourceBytes: inputOptions.maxSourceBytes ?? 1024 * 1024, watch: inputOptions.watch ?? true, debounceMs: inputOptions.debounceMs ?? 30 }
  if (!Number.isSafeInteger(options.maxSourceBytes) || options.maxSourceBytes < 1 || !Number.isSafeInteger(options.debounceMs) || options.debounceMs < 0 || options.debounceMs > 1000 || typeof options.watch !== "boolean") throw new Error("invalid program-file options")
  let current: UslProgramSnapshot | undefined
  let revision = 0, compilations = 0, bytesRead = 0, signature = "", sourceHash = "", planHash = ""
  let error: string | null = null, closed = false, dirty = true, changeVersion = 0
  let pending: Promise<ProgramUpdate> | undefined, timer: ReturnType<typeof setTimeout> | undefined, watcher: FSWatcher | undefined
  const listeners = new Set<(update: ProgramUpdate) => void>()
  const status = (): ProgramStatus => Object.freeze({ path: file, revision, sourceDigest: sourceHash, planDigest: planHash,
    state: closed ? "CLOSED" : error === null ? "CURRENT" : "INVALID_EDIT", error, compilations, bytesRead })
  const publish = (changed: boolean): ProgramUpdate => {
    const update = Object.freeze({ changed, status: status() })
    for (const listener of listeners) { try { listener(update) } catch { /* Observers cannot break refresh or replace a valid plan. */ } }
    return update
  }
  const refresh = (): Promise<ProgramUpdate> => {
    if (closed) return Promise.reject(new Error("program file is closed"))
    if (pending) return pending
    const startedVersion = changeVersion
    pending = (async () => {
      try {
        const info = await stat(file, { bigint: true })
        if (!info.isFile()) throw new Error("program source must be a regular file")
        const nextSignature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
        if (!dirty && nextSignature === signature) return { changed: false, status: status() }
        dirty = false
        if (info.size > BigInt(options.maxSourceBytes)) throw new Error("program exceeds maxSourceBytes")
        const handle = await open(file, "r")
        let bytes: Buffer
        try {
          bytes = Buffer.alloc(options.maxSourceBytes + 1)
          let offset = 0
          while (offset < bytes.length) {
            const read = await handle.read(bytes, offset, bytes.length - offset, null)
            if (read.bytesRead === 0) break
            offset += read.bytesRead
          }
          bytes = bytes.subarray(0, offset)
        } finally { await handle.close() }
        bytesRead += bytes.length
        if (bytes.length > options.maxSourceBytes) throw new Error("program exceeds maxSourceBytes")
        const source = bytes.toString("utf8")
        const digest = digestSource(source)
        signature = nextSignature
        if (current && digest === sourceHash) {
          const recovered = error !== null; error = null
          return recovered ? publish(false) : { changed: false, status: status() }
        }
        compilations++
        const compiled = compileSource(source)
        if (Either.isLeft(compiled)) throw compiled.left
        const next = freeze({ source, plan: compiled.right })
        if (closed) return { changed: false, status: status() }
        // Both source and plan change in one synchronous assignment after validation.
        current = next; sourceHash = digest; planHash = planDigest(next.plan); revision++; error = null
        return publish(true)
      } catch (failure) {
        error = errorText(failure)
        const update = publish(false)
        if (!current) throw failure
        return update
      }
    })().finally(() => {
      pending = undefined
      if (!closed && startedVersion !== changeVersion) {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => { void refresh().catch(() => {}) }, options.debounceMs)
      }
    })
    return pending
  }
  if (options.watch) {
    watcher = watch(dirname(file), (_event, name) => {
      if (name !== null && String(name) !== basename(file)) return
      dirty = true; changeVersion++
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { void refresh().catch(() => {}) }, options.debounceMs)
    })
    watcher.on("error", (failure) => { error = errorText(failure); publish(false) })
  }
  try { await refresh() } catch (failure) { watcher?.close(); if (timer) clearTimeout(timer); throw failure }
  return {
    snapshot: () => { if (closed || !current) throw new Error("program is unavailable"); return current },
    status, refresh,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    close: () => { closed = true; watcher?.close(); if (timer) clearTimeout(timer); listeners.clear() },
  }
}

/** Named files are configured by the host. IDs cannot request arbitrary filesystem paths. */
export const openProgramRegistry = async (files: Readonly<Record<string, string>>, options: ProgramFileOptions = {}) => {
  const entries = structuredClone(files)
  const programs = new Map<string, ProgramFile>()
  try {
    for (const [id, file] of Object.entries(entries)) {
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(id) || typeof file !== "string" || !file.trim()) throw new Error("invalid registered program")
      programs.set(id, await openProgramFile(file, options))
    }
  } catch (failure) { for (const program of programs.values()) program.close(); throw failure }
  return {
    getProgram: async (id: string): Promise<UslProgramSnapshot> => {
      const program = programs.get(id)
      if (!program) throw new Error(`unknown registered program: ${id}`)
      const update = await program.refresh()
      if (update.status.state !== "CURRENT") throw new Error(`registered program ${id} has an invalid edit: ${update.status.error}`)
      return program.snapshot()
    },
    status: () => Object.fromEntries([...programs].map(([id, program]) => [id, program.status()])),
    close: () => { for (const program of programs.values()) program.close() },
  }
}
