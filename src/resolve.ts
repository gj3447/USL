// Read-only endpoint services. KG access uses ontology_get, never raw Cypher.
import { Context, Data, Effect, Either, Layer } from "effect"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import { TOOL_VERSION, type FsLocator, type GitLocator, type GuaranteeLevel, type KgLocator, type Locator, type Resolution, type UrlLocator } from "./domain.js"
import { formatLocator, parseLocator, validLines } from "./locator.js"

export class ResolveError extends Data.TaggedError("ResolveError")<{
  readonly kind: Locator["kind"]
  readonly locator: string
  readonly reason: "ORPHAN" | "AMBIGUOUS" | "IO" | "DENIED"
  readonly detail: string
}> { get message() { return `${this.kind}:${this.reason}: ${this.detail}` } }

export const sha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex")
const now = () => new Date().toISOString()
const failure = (l: Locator, reason: ResolveError["reason"], detail: string) => new ResolveError({ kind: l.kind, locator: formatLocator(l), reason, detail })
const ioFailure = (l: Locator, e: unknown) => failure(l, ["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException)?.code ?? "") ? "ORPHAN" : "IO", String(e))

const contentAt = (buf: Buffer, l: FsLocator | GitLocator): Effect.Effect<Uint8Array | string, ResolveError> => {
  if (!validLines(l)) return Effect.fail(failure(l, "AMBIGUOUS", "invalid line range"))
  if (l.lineStart === undefined) return Effect.succeed(buf)
  const text = buf.toString("utf8")
  const lines = text.split("\n")
  if (text.endsWith("\n") || text === "") lines.pop()
  if (l.lineEnd! > lines.length) return Effect.fail(failure(l, "ORPHAN", `line range exceeds ${lines.length} lines`))
  return Effect.succeed(lines.slice(l.lineStart - 1, l.lineEnd).join("\n"))
}

export interface ResolverConfig {
  readonly hostname: string
  readonly gitRepos: Readonly<Record<string, string>>
  readonly kgMcpUrl: string // legacy canonical-neo4j fallback
  readonly kgSources?: Readonly<Record<string, string>> // explicit source -> ontology MCP URL
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
  // If supplied, resolution may read only these exact locator strings.  The
  // original request must be listed; filesystem realpaths and URL redirects
  // must be listed separately when they change the address.
  readonly allowedLocators?: ReadonlyArray<string>
  readonly fetchImpl: typeof fetch
}
export class Config extends Context.Tag("usl/Config")<Config, ResolverConfig>() {}
export interface ResolverOptions {
  readonly allowedLocators?: ReadonlyArray<string>
}
export class Resolvers extends Context.Tag("usl/Resolvers")<Resolvers, {
  readonly resolve: (l: Locator, options?: ResolverOptions) => Effect.Effect<Resolution, ResolveError>
}>() {}

const policyError = (l: Locator, detail: string) => failure(l, "IO", `invalid allowedLocators policy: ${detail}`)
// URL's URL parser is the resolver's canonical address representation (notably
// adding a root slash).  Other locator grammars already format canonically.
export const locatorKey = (l: Locator): string => l.kind === "url" ? new URL(l.href).href : formatLocator(l)
const normalizePolicy = (l: Locator, entries: ReadonlyArray<string> | undefined): ReadonlyArray<string> | ResolveError | undefined => {
  if (entries === undefined) return undefined
  if (!Array.isArray(entries)) return policyError(l, "expected an array")
  const normalized: string[] = []
  for (const entry of entries) {
    const parsed = typeof entry === "string" ? parseLocator(entry) : undefined
    if (parsed === undefined || Either.isLeft(parsed)) return policyError(l, `invalid locator entry ${JSON.stringify(entry)}`)
    normalized.push(locatorKey(parsed.right))
  }
  return normalized
}
const allowed = (l: Locator, cfg: ResolverConfig, locator = locatorKey(l)): ResolveError | undefined =>
  cfg.allowedLocators === undefined || cfg.allowedLocators.includes(locator)
    ? undefined
    : failure(l, "DENIED", `locator is not allowed: ${locator}`)

const resolveFs = (l: FsLocator, cfg: ResolverConfig): Effect.Effect<Resolution, ResolveError> => Effect.gen(function* () {
  if (l.host !== cfg.hostname) return yield* failure(l, "IO", `host ${l.host} != local ${cfg.hostname}; remote filesystem resolution is unsupported`)
  const real = yield* Effect.tryPromise({ try: () => fs.realpath(l.path), catch: (e) => ioFailure(l, e) })
  const canonicalLocator = locatorKey({ ...l, path: real })
  const denied = allowed(l, cfg, canonicalLocator)
  if (denied) return yield* denied
  if (Either.isLeft(parseLocator(formatLocator({ ...l, path: real })))) return yield* failure(l, "AMBIGUOUS", "resolved path cannot be represented by the current locator grammar")
  const stat = yield* Effect.tryPromise({ try: () => fs.stat(real), catch: (e) => ioFailure(l, e) })
  if (stat.isDirectory()) {
    if (l.lineStart !== undefined) return yield* failure(l, "AMBIGUOUS", "line ranges require a file")
    const entries = yield* Effect.tryPromise({ try: () => fs.readdir(real, { withFileTypes: true }), catch: (e) => ioFailure(l, e) })
    const listing = entries.map((e) => [e.name, e.isDirectory() ? "directory" : e.isFile() ? "file" : e.isSymbolicLink() ? "symlink" : "other"]).sort((a, b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0)
    return { locator: l, resolvedLocator: formatLocator({ ...l, path: real }), contentHash: sha256(JSON.stringify(listing)), resolvedAt: now(), guaranteeLevel: "trust_host", matchCount: 1 }
  }
  if (!stat.isFile()) return yield* failure(l, "AMBIGUOUS", "only regular files and directories are supported")
  const buf = yield* Effect.tryPromise({ try: () => fs.readFile(real), catch: (e) => ioFailure(l, e) })
  const content = yield* contentAt(buf, l)
  return { locator: l, resolvedLocator: formatLocator({ ...l, path: real }), contentHash: sha256(content), resolvedAt: now(), guaranteeLevel: "trust_host", matchCount: 1 }
})

const readBody = async (res: Response, cfg: ResolverConfig, signal: AbortSignal): Promise<Uint8Array> => {
  const limit = cfg.maxResponseBytes ?? 8 * 1024 * 1024
  if (!Number.isSafeInteger(limit) || limit <= 0) { await res.body?.cancel(); throw new Error("maxResponseBytes must be a positive safe integer") }
  if (Number(res.headers.get("content-length")) > limit) { await res.body?.cancel(); throw new Error(`response exceeds ${limit} bytes`) }
  if (!res.body) return new Uint8Array()
  const reader = res.body.getReader()
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener("abort", abort, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new Error(`response exceeds ${limit} bytes`)
      chunks.push(value)
    }
    signal.throwIfAborted()
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return bytes
  } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock() }
}

const redirectStatus = (status: number) => status === 301 || status === 302 || status === 303 || status === 307 || status === 308
const maxRedirects = 10
const resolveUrl = (l: UrlLocator, cfg: ResolverConfig): Effect.Effect<Resolution, ResolveError> => Effect.tryPromise({
  try: async (signal) => {
    let href = l.href
    let res: Response | undefined
    for (let hops = 0; hops <= maxRedirects; hops++) {
      res = await cfg.fetchImpl(href, { signal, redirect: "manual", headers: { "user-agent": TOOL_VERSION } })
      if (!redirectStatus(res.status)) break
      const location = res.headers.get("location")
      if (!location) break
      if (hops === maxRedirects) { await res.body?.cancel(); throw failure(l, "IO", `too many HTTP redirects (>${maxRedirects})`) }
      const target = new URL(location, href)
      // Keep the locator's client-side selector when a redirect does not set one.
      if (!target.hash) target.hash = new URL(l.href).hash
      const denied = allowed(l, cfg, target.href)
      if (denied) { await res.body?.cancel(); throw denied }
      await res.body?.cancel()
      href = target.href
    }
    if (!res) throw new Error("missing HTTP response")
    if (!res.ok) {
      await res.body?.cancel()
      throw failure(l, res.status === 404 || res.status === 410 ? "ORPHAN" : "IO", `HTTP ${res.status}`)
    }
    // A fragment selects client-side content; preserve it across ordinary HTTP responses.
    const resolved = new URL(res.url || href)
    if (!resolved.hash) resolved.hash = new URL(l.href).hash
    return { locator: l, resolvedLocator: resolved.href, contentHash: sha256(await readBody(res, cfg, signal)), resolvedAt: now(), guaranteeLevel: "trust_host" as const, matchCount: 1 }
  },
  catch: (e) => e instanceof ResolveError ? e : failure(l, "IO", String(e)),
})

const git = (cwd: string, args: ReadonlyArray<string>): Effect.Effect<Buffer, Error> => Effect.async((resume) => {
  const child = execFile("git", ["-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024, encoding: "buffer", timeout: 15_000 }, (err, stdout) => {
    resume(err ? Effect.fail(err) : Effect.succeed(stdout as Buffer))
  })
  return Effect.sync(() => { child.kill() })
})

const resolveGit = (l: GitLocator, cfg: ResolverConfig): Effect.Effect<Resolution, ResolveError> => Effect.gen(function* () {
  const local = Object.hasOwn(cfg.gitRepos, l.repo) ? cfg.gitRepos[l.repo] : undefined
  if (!local) return yield* failure(l, "IO", `no local checkout registered for ${l.repo} (USL_GIT_REPOS)`)
  yield* git(local, ["rev-parse", "--git-dir"]).pipe(Effect.mapError((e) => failure(l, "IO", `checkout unavailable: ${e.message.split("\n")[0]}`)))
  const full = (yield* git(local, ["rev-parse", "--verify", `${l.commit ?? "HEAD"}^{commit}`]).pipe(Effect.mapError((e) => failure(l, "ORPHAN", `commit: ${e.message.split("\n")[0]}`)))).toString("utf8").trim()
  if (l.path === undefined) return { locator: l, resolvedLocator: formatLocator({ ...l, commit: full }), contentHash: sha256(full), resolvedAt: now(), guaranteeLevel: "trust_host", matchCount: 1 }
  const objectType = (yield* git(local, ["cat-file", "-t", `${full}:${l.path}`]).pipe(Effect.mapError((e) => failure(l, "ORPHAN", `path at commit: ${e.message.split("\n")[0]}`)))).toString().trim()
  if (objectType !== "blob") return yield* failure(l, "AMBIGUOUS", `expected file blob, got ${objectType}`)
  if (l.symbol !== undefined) return yield* failure(l, "AMBIGUOUS", "symbol resolution requires a symbol adapter; file or line resolution cannot verify a symbol")
  const blob = yield* git(local, ["cat-file", "blob", `${full}:${l.path}`]).pipe(Effect.mapError((e) => failure(l, "IO", e.message.split("\n")[0]!)))
  const content = yield* contentAt(blob, l)
  // Reading Git objects is a host process, not a sandbox.
  return { locator: l, resolvedLocator: formatLocator({ ...l, commit: full }), contentHash: sha256(content), resolvedAt: now(), guaranteeLevel: "trust_host", matchCount: 1 }
})

type JsonObject = Record<string, unknown>
const isObject = (x: unknown): x is JsonObject => typeof x === "object" && x !== null && !Array.isArray(x)

// Toolbox can return ordinary JSON or an SSE message with optional heartbeat/event lines.
const parseRpc = (text: string): JsonObject => {
  const trimmed = text.trim()
  const candidates = trimmed.startsWith("{") ? [trimmed] : trimmed.replace(/\r\n/g, "\n").split(/\n\n+/).map((event) =>
    event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n"))
  for (const data of candidates) {
    if (!data || data === "[DONE]") continue
    let rpc: unknown
    try { rpc = JSON.parse(data) } catch { continue }
    if (isObject(rpc) && rpc.id === 1 && rpc.jsonrpc === "2.0") return rpc
  }
  throw new Error("missing matching JSON-RPC response")
}

const resolveKg = (l: KgLocator, cfg: ResolverConfig): Effect.Effect<Resolution, ResolveError> => Effect.tryPromise({
  try: async (signal) => {
    const endpoint = cfg.kgSources && Object.hasOwn(cfg.kgSources, l.source) ? cfg.kgSources[l.source] : l.source === "canonical-neo4j" ? cfg.kgMcpUrl : undefined
    if (!endpoint) throw failure(l, "IO", `unregistered KG source: ${l.source} (USL_KG_SOURCES)`)
    const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ontology_get", arguments: { uid: l.uid }, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "usl", version: TOOL_VERSION.slice(4) }, "io.modelcontextprotocol/clientCapabilities": {} } } }
    const res = await cfg.fetchImpl(endpoint, { signal, method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "ontology_get" }, body: JSON.stringify(body) })
    if (!res.ok) { await res.body?.cancel(); throw failure(l, "IO", `MCP HTTP ${res.status}`) }
    const rpc = parseRpc(new TextDecoder().decode(await readBody(res, cfg, signal)))
    if (rpc.error || !isObject(rpc.result) || rpc.result.isError === true) throw failure(l, "IO", "ontology_get returned a protocol/tool error")
    const content = rpc.result.content
    if (!Array.isArray(content)) throw failure(l, "IO", "missing MCP content")
    const blocks = content.filter((b: unknown) => isObject(b) && b.type === "text" && typeof b.text === "string") as Array<{ text: string }>
    if (blocks.length !== 1) throw failure(l, "IO", "expected one ontology_get text payload")
    const parsed: unknown = JSON.parse(blocks[0]!.text)
    if (parsed !== null && !Array.isArray(parsed)) throw failure(l, "IO", "expected ontology_get record array")
    if (parsed === null || parsed.length === 0) throw failure(l, "ORPHAN", "no visible record (missing or filtered by sensitivity policy)")
    if (parsed.length !== 1) throw failure(l, "AMBIGUOUS", "multiple ontology_get records")
    const rec: unknown = parsed[0]
    if (!isObject(rec)) throw failure(l, "IO", "invalid ontology record")
    if (rec.uid_collision === true || typeof rec.uid_match_count === "number" && rec.uid_match_count > 1) throw failure(l, "AMBIGUOUS", "UID collision")
    if (rec.uid !== l.uid || rec.uid_match_count !== undefined && rec.uid_match_count !== 1 || rec.uid_collision !== undefined && rec.uid_collision !== false) throw failure(l, "IO", "ontology_get identity/count mismatch")
    if (rec.legacy_labels !== undefined && (!Array.isArray(rec.legacy_labels) || !rec.legacy_labels.every((v: unknown) => typeof v === "string"))) throw failure(l, "IO", "invalid legacy_labels")
    // Preserve v0.1 fingerprint compatibility: bounded metadata + target version, not full graph content.
    const canonical = JSON.stringify({ uid: rec.uid, name: rec.name ?? null, title: rec.title ?? null, labels: [...((rec.legacy_labels ?? []) as string[])].sort(), target_version: rec.target_version ?? null, authority_class: rec.authority_class ?? null, canonical_scope: rec.canonical_scope ?? null })
    return { locator: l, resolvedLocator: formatLocator(l), contentHash: sha256(canonical), resolvedAt: now(), guaranteeLevel: "trust_host" as const, matchCount: 1 }
  },
  catch: (e) => e instanceof ResolveError ? e : failure(l, "IO", `bad MCP response/transport: ${String(e)}`),
})

export const resolveWith = (cfg: ResolverConfig) => (l: Locator): Effect.Effect<Resolution, ResolveError> => {
  if (Either.isLeft(parseLocator(formatLocator(l))) || (l.kind === "filesystem" || l.kind === "git_repo") && !validLines(l)) return Effect.fail(failure(l, "AMBIGUOUS", "invalid locator structure"))
  const policy = normalizePolicy(l, cfg.allowedLocators)
  if (policy instanceof ResolveError) return Effect.fail(policy)
  const configured = policy === undefined ? cfg : { ...cfg, allowedLocators: policy }
  const denied = allowed(l, configured)
  if (denied) return Effect.fail(denied)
  const effect = (() => {
    switch (l.kind) {
      case "filesystem": return resolveFs(l, configured)
      case "url": return resolveUrl(l, configured)
      case "git_repo": return resolveGit(l, configured)
      case "kg": return resolveKg(l, configured)
    }
  })()
  const timeoutMs = configured.timeoutMs ?? 15_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Effect.fail(failure(l, "IO", "timeoutMs must be positive and finite"))
  return effect.pipe(Effect.timeoutFail({ duration: timeoutMs, onTimeout: () => failure(l, "IO", `resolution timed out after ${timeoutMs}ms`) }))
}

const envMap = (name: string): Record<string, string> => {
  const text = process.env[name]
  if (!text) return {}
  const value: unknown = JSON.parse(text)
  if (!isObject(value) || !Object.values(value).every((v) => typeof v === "string" && v.length > 0)) throw new Error(`${name} must be a JSON object with non-empty string values`)
  return value as Record<string, string>
}
export const defaultConfig = (): ResolverConfig => ({
  hostname: process.env["USL_HOSTNAME"] ?? os.hostname(),
  gitRepos: envMap("USL_GIT_REPOS"),
  kgMcpUrl: process.env["USL_KG_MCP_URL"] ?? "http://127.0.0.1:5501/mcp",
  kgSources: envMap("USL_KG_SOURCES"),
  timeoutMs: Number(process.env["USL_TIMEOUT_MS"] ?? 15_000),
  maxResponseBytes: Number(process.env["USL_MAX_RESPONSE_BYTES"] ?? 8 * 1024 * 1024),
  fetchImpl: fetch,
})
const intersectPolicies = (base: ReadonlyArray<string> | undefined, requested: ReadonlyArray<string> | undefined): ReadonlyArray<string> | undefined => {
  if (base === undefined) return requested
  if (requested === undefined) return base
  return base.filter((locator) => requested.includes(locator))
}
export const ResolversLive: Layer.Layer<Resolvers, never, Config> = Layer.effect(Resolvers, Effect.map(Config, (cfg) => ({
  resolve: (l, options) => Effect.suspend(() => {
    // Validate both policies before intersecting them: an invalid entry must
    // never be hidden merely because the other policy excludes it.
    const base = normalizePolicy(l, cfg.allowedLocators)
    if (base instanceof ResolveError) return Effect.fail(base)
    const requested = normalizePolicy(l, options?.allowedLocators)
    if (requested instanceof ResolveError) return Effect.fail(requested)
    const policy = intersectPolicies(base, requested)
    return resolveWith(policy === undefined ? cfg : { ...cfg, allowedLocators: policy })(l)
  }),
})))
export const ConfigLive = (cfg: Partial<ResolverConfig> = {}): Layer.Layer<Config> => Layer.succeed(Config, { ...defaultConfig(), ...cfg })
export const weakest = (a: GuaranteeLevel, b: GuaranteeLevel): GuaranteeLevel => {
  const rank = { pure: 0, sandboxed: 1, trust_host: 2 } as const
  return rank[a] >= rank[b] ? a : b
}
