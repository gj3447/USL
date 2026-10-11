/** Bounded, allowlisted HTTP observation.  It grants neither authority nor freshness by clock. */
import { createHash } from "node:crypto"
import { contractDigest, contractSnapshot, freezeContract } from "../contract-core.js"

export interface NativeHttpInput {
  readonly url: string
  readonly scopeDigest: string
  /** Exact, normalized HTTP(S) URLs controlled by the caller. */
  readonly allowedUrls: readonly string[]
  readonly maxBytes?: number
  readonly timeoutMs?: number
  readonly accept?: string
  /** A process-local value returned by prepareNativeHttp. */
  readonly cache?: PreparedNativeHttp
}
export interface NativeHttpReport {
  readonly schema: "usl-native-http/v1"
  readonly status: "PASS" | "HOLD"
  readonly selection: Readonly<{ readonly kind: "http"; readonly requestedUrl: string; readonly scopeDigest: string; readonly contextDigest: string }>
  readonly requestedUrl: string
  readonly finalUrl: string | null
  readonly httpStatus: number | null
  readonly bodyDigest: string | null
  readonly bytes: number | null
  readonly etag: string | null
  readonly lastModified: string | null
  /** Bounded response directive text; it is not interpreted as clock freshness. */
  readonly cacheControl: string | null
  /** Cache headers/validators are reported; no wall-clock freshness is asserted. */
  readonly freshness: "EXPLICIT_CACHE_CONTROL" | "VALIDATOR_ONLY" | "UNKNOWN"
  readonly observedAt: string
  readonly capabilities: Readonly<{ readonly allowlistedHttpGet: true; readonly customHeaders: false; readonly authority: "NOT_GRANTED" }>
  readonly reasons: readonly string[]
  readonly consistency: "READ_ONLY_NON_ATOMIC"
  readonly digest: string
}
export interface PreparedNativeHttp {
  readonly schema: "usl-prepared-native-http/v1"
  readonly report: NativeHttpReport
  readonly preparedAt: string
  readonly limitation: "PROCESS_LOCAL_HANDLE;READ_ONLY_NON_ATOMIC"
}
interface Captured { readonly url: string; readonly scopeDigest: string; readonly allowedUrls: readonly string[]; readonly maxBytes: number; readonly timeoutMs: number; readonly accept: string | null; readonly contextDigest: string; readonly cache?: PreparedNativeHttp }
interface Stored { readonly captured: Captured; readonly report: NativeHttpReport; readonly body: Uint8Array | null }
const prepared = new WeakMap<object, Stored>()
/** Private response bytes are deliberately not part of the public immutable report. */
const reportBodies = new WeakMap<object, Uint8Array>()
const MAX_BYTES = 16 * 1024 * 1024, MAX_TIMEOUT = 60_000, DEFAULT_BYTES = 1024 * 1024, DEFAULT_TIMEOUT = 15_000, MAX_REDIRECTS = 5, MAX_CACHE_CONTROL_BYTES = 4096
const hash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`
const own = (value: unknown, name: string): Record<string, unknown> => { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`); return value as Record<string, unknown> }
const bounded = (value: unknown, fallback: number, label: string) => { const n = value === undefined ? fallback : value; if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || n > (label === "maxBytes" ? MAX_BYTES : MAX_TIMEOUT)) throw new Error(`${label} is out of range`); return n }
const url = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a URL`)
  const parsed = new URL(value)
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.hash || parsed.href !== value) throw new Error(`${label} must be a normalized credential-free HTTP(S) URL`)
  return parsed.href
}
const capture = (input: NativeHttpInput): Captured => {
  const candidate = own(input, "native HTTP input")
  if (Object.getPrototypeOf(candidate) !== Object.prototype && Object.getPrototypeOf(candidate) !== null) throw new Error("native HTTP input must be a plain object")
  const descriptors = Object.getOwnPropertyDescriptors(candidate), allowed = new Set(["url", "scopeDigest", "allowedUrls", "maxBytes", "timeoutMs", "accept", "cache"])
  for (const key of Reflect.ownKeys(candidate)) {
    if (typeof key !== "string" || !allowed.has(key)) throw new Error(`unknown native HTTP input field: ${String(key)}`)
    const descriptor = descriptors[key]
    if (descriptor === undefined) throw new Error(`native HTTP input field is missing: ${key}`)
    if (!descriptor.enumerable || !("value" in descriptor)) throw new Error(`native HTTP input field must be an enumerable data property: ${key}`)
  }
  // Snapshot serializable fields once, but retain the process-local cache handle by identity.
  const cache = descriptors.cache?.value
  const raw = contractSnapshot(Object.fromEntries(Object.entries(descriptors).filter(([key]) => key !== "cache").map(([key, descriptor]) => [key, descriptor.value]))) as Record<string, unknown>
  if (typeof raw.scopeDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(raw.scopeDigest)) throw new Error("scopeDigest must be sha256:<hex>")
  if (!Array.isArray(raw.allowedUrls) || raw.allowedUrls.length === 0 || raw.allowedUrls.length > 256) throw new Error("allowedUrls must be a nonempty bounded list")
  const allowedUrls = [...new Set(raw.allowedUrls.map(value => url(value, "allowedUrls entry")))].sort()
  const requested = url(raw.url, "url")
  if (!allowedUrls.includes(requested)) throw new Error("url is not in allowedUrls")
  if (raw.accept !== undefined && (typeof raw.accept !== "string" || raw.accept.length > 256 || /[\r\n]/u.test(raw.accept))) throw new Error("accept must be a bounded header value")
  const accept = typeof raw.accept === "string" ? raw.accept : null
  const contextDigest = contractDigest({ schema: "usl-native-http-context/v1", requestedUrl: requested, allowedUrls, scopeDigest: raw.scopeDigest, accept })
  const base = { url: requested, scopeDigest: raw.scopeDigest, allowedUrls, maxBytes: bounded(raw.maxBytes, DEFAULT_BYTES, "maxBytes"), timeoutMs: bounded(raw.timeoutMs, DEFAULT_TIMEOUT, "timeoutMs"), accept, contextDigest }
  return cache === undefined ? freezeContract(base) : freezeContract({ ...base, cache: cache as PreparedNativeHttp })
}
const redirect = (status: number) => [301, 302, 303, 307, 308].includes(status)
const stable = (value: Omit<NativeHttpReport, "observedAt" | "digest">) => contractDigest(value)
const report = (value: Omit<NativeHttpReport, "observedAt" | "digest">): NativeHttpReport => freezeContract({ ...value, observedAt: new Date().toISOString(), digest: stable(value) })
const base = (c: Captured, status: "PASS" | "HOLD", reasons: readonly string[], values: Partial<Omit<NativeHttpReport, "schema" | "status" | "selection" | "requestedUrl" | "observedAt" | "capabilities" | "reasons" | "consistency" | "digest">> = {}): NativeHttpReport => report({ schema: "usl-native-http/v1", status, selection: freezeContract({ kind: "http", requestedUrl: c.url, scopeDigest: c.scopeDigest, contextDigest: c.contextDigest }), requestedUrl: c.url, finalUrl: values.finalUrl ?? null, httpStatus: values.httpStatus ?? null, bodyDigest: values.bodyDigest ?? null, bytes: values.bytes ?? null, etag: values.etag ?? null, lastModified: values.lastModified ?? null, cacheControl: values.cacheControl ?? null, freshness: values.freshness ?? "UNKNOWN", capabilities: freezeContract({ allowlistedHttpGet: true, customHeaders: false, authority: "NOT_GRANTED" }), reasons: [...reasons], consistency: "READ_ONLY_NON_ATOMIC" })
const read = async (response: Response, remaining: { value: number }, signal: AbortSignal): Promise<Uint8Array> => {
  const length = response.headers.get("content-length")
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > remaining.value)) throw new Error("BODY_LIMIT")
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
  try { while (true) { signal.throwIfAborted(); const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > remaining.value) throw new Error("BODY_LIMIT"); chunks.push(next.value) }
    remaining.value -= size; const all = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength }; return all
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}
const cacheControl = (headers: Headers): string | null => {
  const value = headers.get("cache-control")
  if (value !== null && Buffer.byteLength(value, "utf8") > MAX_CACHE_CONTROL_BYTES) throw new Error("CACHE_CONTROL_LIMIT")
  return value
}
const freshness = (cache: string | null, etag: string | null, lastModified: string | null): NativeHttpReport["freshness"] => cache !== null ? "EXPLICIT_CACHE_CONTROL" : (etag || lastModified) ? "VALIDATOR_ONLY" : "UNKNOWN"
/** Identity of the selected representation, excluding transport status and observation time. */
const representationDigest = (report: NativeHttpReport): string | null => report.status === "PASS" && report.finalUrl !== null && report.bodyDigest !== null && report.bytes !== null
  ? contractDigest({ schema: "usl-native-http-representation/v1", selection: report.selection, finalUrl: report.finalUrl, bodyDigest: report.bodyDigest, bytes: report.bytes }) : null
const validCache = (c: Captured): Stored | undefined => {
  if (c.cache === undefined || c.cache === null || typeof c.cache !== "object") return undefined
  const value = prepared.get(c.cache); if (!value || value.captured.contextDigest !== c.contextDigest || value.report.status !== "PASS" || value.body === null) return undefined
  if (value.report.bodyDigest !== hash(value.body) || value.report.bytes !== value.body.byteLength) return undefined
  return value
}
/** Performs only a bounded GET. Redirect targets must each be independently allowlisted. */
const observeCaptured = async (c: Captured): Promise<NativeHttpReport> => {
  const cached = validCache(c), controller = new AbortController(), timer = setTimeout(() => controller.abort(), c.timeoutMs), remaining = { value: c.maxBytes }
  let current = c.url
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const headers: Record<string, string> = {}
      if (c.accept !== null) headers.accept = c.accept
      const matchingCache = cached?.report.finalUrl === current ? cached : undefined
      let sentConditional = false
      if (matchingCache?.report.etag) { headers["if-none-match"] = matchingCache.report.etag; sentConditional = true }
      else if (matchingCache?.report.lastModified) { headers["if-modified-since"] = matchingCache.report.lastModified; sentConditional = true }
      const response = await fetch(current, { method: "GET", redirect: "manual", headers, signal: controller.signal })
      if (redirect(response.status)) {
        await read(response, remaining, controller.signal)
        const location = response.headers.get("location"); if (!location) return base(c, "HOLD", ["REDIRECT_LOCATION_MISSING"], { finalUrl: current, httpStatus: response.status })
        if (hop === MAX_REDIRECTS) return base(c, "HOLD", ["REDIRECT_LIMIT"], { finalUrl: current, httpStatus: response.status })
        const next = url(new URL(location, current).href, "redirect location")
        if (!c.allowedUrls.includes(next)) return base(c, "HOLD", ["REDIRECT_NOT_ALLOWED"], { finalUrl: current, httpStatus: response.status })
        current = next; continue
      }
      const etag = response.headers.get("etag"), lastModified = response.headers.get("last-modified"), directive = cacheControl(response.headers), facts = { finalUrl: current, httpStatus: response.status, etag, lastModified, cacheControl: directive, freshness: freshness(directive, etag, lastModified) }
      if (response.status === 304) {
        await read(response, remaining, controller.signal)
        if (!matchingCache) return base(c, "HOLD", ["CACHE_HANDLE_REQUIRED"], facts)
        if (!sentConditional || (!matchingCache.report.etag && !matchingCache.report.lastModified)) return base(c, "HOLD", ["CACHE_VALIDATOR_REQUIRED"], facts)
        if (etag !== matchingCache.report.etag || lastModified !== matchingCache.report.lastModified) return base(c, "HOLD", ["CACHE_VALIDATOR_MISMATCH"], facts)
        const cachedBody = matchingCache.body
        if (cachedBody === null) return base(c, "HOLD", ["CACHE_HANDLE_REQUIRED"], facts)
        if (cachedBody.byteLength > remaining.value) return base(c, "HOLD", ["CACHE_BODY_LIMIT"], facts)
        remaining.value -= cachedBody.byteLength
        const result = base(c, "PASS", [], { ...facts, bodyDigest: matchingCache.report.bodyDigest, bytes: matchingCache.report.bytes })
        reportBodies.set(result, cachedBody)
        return result
      }
      if (!response.ok) { await read(response, remaining, controller.signal); return base(c, "HOLD", [`HTTP_${response.status}`], facts) }
      const body = await read(response, remaining, controller.signal)
      const result = base(c, "PASS", [], { ...facts, bodyDigest: hash(body), bytes: body.byteLength })
      reportBodies.set(result, body)
      return result
    }
    return base(c, "HOLD", ["REDIRECT_LIMIT"])
  } catch (error) { const reason = (error as Error).message; return base(c, "HOLD", [reason === "BODY_LIMIT" || reason === "CACHE_CONTROL_LIMIT" ? reason : controller.signal.aborted ? "TIMEOUT" : "HTTP_UNAVAILABLE"]) }
  finally { clearTimeout(timer) }
}
export const observeNativeHttp = async (input: NativeHttpInput): Promise<NativeHttpReport> => observeCaptured(capture(input))
/** Creates an opaque, process-local cache/recheck handle. Bodies never leave its private WeakMap entry. */
export const prepareNativeHttp = async (input: NativeHttpInput): Promise<PreparedNativeHttp> => {
  const c = capture(input), observed = await observeCaptured(c)
  const handle = freezeContract({ schema: "usl-prepared-native-http/v1" as const, report: observed, preparedAt: new Date().toISOString(), limitation: "PROCESS_LOCAL_HANDLE;READ_ONLY_NON_ATOMIC" as const })
  const body = observed.status === "PASS" ? reportBodies.get(observed) ?? null : null
  prepared.set(handle, { captured: c, report: observed, body }); return handle
}
/** Reobserves current bytes and validators; a held or changed prepared observation cannot pass. */
export const recheckNativeHttp = async (handle: PreparedNativeHttp): Promise<NativeHttpReport> => {
  const saved = handle !== null && typeof handle === "object" ? prepared.get(handle) : undefined
  if (!saved) throw new Error("native HTTP observation was not prepared by this process")
  if (saved.report.status !== "PASS" || saved.body === null) return base(saved.captured, "HOLD", ["PREPARED_OBSERVATION_UNAVAILABLE"])
  const { url, scopeDigest, allowedUrls, maxBytes, timeoutMs, accept } = saved.captured
  const fresh = await observeCaptured(freezeContract({ url, scopeDigest, allowedUrls, maxBytes, timeoutMs, accept, cache: handle, contextDigest: saved.captured.contextDigest }))
  if (fresh.status !== "PASS" || representationDigest(fresh) !== representationDigest(saved.report)) {
    const { observedAt: _at, digest: _digest, ...facts } = fresh
    return report({ ...facts, status: "HOLD", reasons: [...fresh.reasons, "PREPARED_OBSERVATION_STALE"] })
  }
  return fresh
}
