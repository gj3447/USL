import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { test, type TestContext } from "node:test"
import { observeNativeHttp, prepareNativeHttp, recheckNativeHttp } from "../src/addons/native-http.js"
import { contractDigest } from "../src/contract-core.js"

const scope = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const server = async (t: TestContext): Promise<{ readonly base: string; readonly accepts: readonly (string | undefined)[]; readonly close: () => Promise<void> }> => {
  const sockets = new Set<import("node:net").Socket>()
  const accepts: (string | undefined)[] = []
  const value: Server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname
    if (path === "/ok") { response.writeHead(200, { ETag: '"one"', "Last-Modified": "Wed, 21 Oct 2015 07:28:00 GMT", "Cache-Control": "max-age=60" }); response.end("native body"); return }
    if (path === "/redirect") { response.writeHead(302, { Location: "/ok" }); response.end(); return }
    if (path === "/escape") { response.writeHead(302, { Location: "/outside" }); response.end(); return }
    if (path === "/large") { response.writeHead(200, { "Content-Length": "1000" }); response.end("x".repeat(1000)); return }
    if (path === "/slow") { setTimeout(() => { response.writeHead(200); response.end("slow") }, 100); return }
    if (path === "/conditional") { if (request.headers["if-none-match"] === '"one"') { response.writeHead(304, { ETag: '"one"' }); response.end(); return }; response.writeHead(200, { ETag: '"one"' }); response.end("native body"); return }
    if (path === "/accept-conditional") { accepts.push(request.headers.accept); if (request.headers["if-none-match"] === '"one"') { response.writeHead(304, { ETag: '"one"' }); response.end(); return }; response.writeHead(200, { ETag: '"one"' }); response.end("native body"); return }
    if (path === "/redirect-conditional") { response.writeHead(302, { Location: "/conditional" }); response.end(); return }
    if (path === "/missing-validator") { if (request.headers["if-none-match"] === '"one"') { response.writeHead(304); response.end(); return }; response.writeHead(200, { ETag: '"one"' }); response.end("native body"); return }
    if (path === "/changed-validator") { if (request.headers["if-none-match"] === '"one"') { response.writeHead(304, { ETag: '"two"' }); response.end(); return }; response.writeHead(200, { ETag: '"one"' }); response.end("native body"); return }
    if (path === "/unconditional-304") { response.writeHead(304, { ETag: '"one"' }); response.end(); return }
    if (path === "/always304") { response.writeHead(304); response.end(); return }
    response.writeHead(404); response.end()
  })
  value.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)) })
  await new Promise<void>((resolve, reject) => { value.once("error", reject); value.listen({ port: 0, host: "127.0.0.1" }, () => { value.off("error", reject); resolve() }) })
  const address = value.address(); if (address === null || typeof address === "string") throw new Error("missing address")
  const close = async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => value.close(() => resolve())) }
  t.after(close); return { base: `http://127.0.0.1:${address.port}`, accepts, close }
}
const input = (base: string, path: string, allowed = [path]) => ({ url: `${base}${path}`, scopeDigest: scope, allowedUrls: allowed.map(value => `${base}${value}`) })

test("P06 allowlisted HTTP GET reports bounded stable facts without clock freshness", async t => {
  const s = await server(t), report = await observeNativeHttp(input(s.base, "/ok"))
  assert.equal(report.status, "PASS", JSON.stringify(report)); assert.equal(report.bytes, 11); assert.equal(report.freshness, "EXPLICIT_CACHE_CONTROL")
  const { observedAt: _at, digest: _digest, ...facts } = report; assert.equal(report.digest, contractDigest(facts))
})
test("P06 redirects require every normalized target to be allowlisted", async t => {
  const s = await server(t)
  assert.equal((await observeNativeHttp(input(s.base, "/redirect", ["/redirect", "/ok"]))).status, "PASS")
  const denied = await observeNativeHttp(input(s.base, "/escape", ["/escape"])); assert.equal(denied.status, "HOLD"); assert.ok(denied.reasons.includes("REDIRECT_NOT_ALLOWED"))
})
test("P06 shares byte and time bounds across the request", async t => {
  const s = await server(t)
  assert.ok((await observeNativeHttp({ ...input(s.base, "/large"), maxBytes: 8 })).reasons.includes("BODY_LIMIT"))
  assert.ok((await observeNativeHttp({ ...input(s.base, "/slow"), timeoutMs: 10 })).reasons.includes("TIMEOUT"))
})
test("P06 conditional 304 only reuses an exact opaque process-local cache handle", async t => {
  const s = await server(t), prepared = await prepareNativeHttp(input(s.base, "/conditional"))
  assert.equal(prepared.report.status, "PASS", JSON.stringify(prepared.report))
  const reused = await observeNativeHttp({ ...input(s.base, "/conditional"), cache: prepared }); assert.equal(reused.status, "PASS", JSON.stringify(reused)); assert.equal(reused.httpStatus, 304)
  const absent = await observeNativeHttp(input(s.base, "/always304")); assert.equal(absent.status, "HOLD"); assert.ok(absent.reasons.includes("CACHE_HANDLE_REQUIRED"))
  await assert.rejects(recheckNativeHttp(structuredClone(prepared)), /not prepared by this process/)
})
test("P06 recheck accepts a conditional 304 only when representation identity is unchanged", async t => {
  const s = await server(t), prepared = await prepareNativeHttp(input(s.base, "/conditional")), result = await recheckNativeHttp(prepared)
  assert.equal(result.status, "PASS", JSON.stringify(result)); assert.equal(result.httpStatus, 304)
})
test("P06 recheck preserves absent and explicit Accept header semantics", async t => {
  const defaults = await server(t), defaultPrepared = await prepareNativeHttp(input(defaults.base, "/accept-conditional"))
  await recheckNativeHttp(defaultPrepared)
  assert.equal(defaults.accepts.length, 2); assert.equal(defaults.accepts[0], defaults.accepts[1]); assert.notEqual(defaults.accepts[1], "undefined")
  const explicit = await server(t), explicitPrepared = await prepareNativeHttp({ ...input(explicit.base, "/accept-conditional"), accept: "application/usl+json" })
  await recheckNativeHttp(explicitPrepared)
  assert.deepEqual(explicit.accepts, ["application/usl+json", "application/usl+json"])
})
test("P06 sends conditional validation at the cached final redirect target", async t => {
  const s = await server(t), initial = input(s.base, "/redirect-conditional", ["/redirect-conditional", "/conditional"]), prepared = await prepareNativeHttp(initial)
  assert.equal(prepared.report.finalUrl, `${s.base}/conditional`)
  const rechecked = await recheckNativeHttp(prepared)
  assert.equal(rechecked.status, "PASS", JSON.stringify(rechecked)); assert.equal(rechecked.httpStatus, 304)
})
test("P06 rejects a 304 without an exact, requested cache validator", async t => {
  const s = await server(t)
  for (const path of ["/missing-validator", "/changed-validator"]) {
    const prepared = await prepareNativeHttp(input(s.base, path)), reused = await observeNativeHttp({ ...input(s.base, path), cache: prepared })
    assert.equal(reused.status, "HOLD", JSON.stringify(reused)); assert.ok(reused.reasons.includes("CACHE_VALIDATOR_MISMATCH"))
  }
  const prepared = await prepareNativeHttp(input(s.base, "/conditional"))
  const unexpected = await observeNativeHttp({ ...input(s.base, "/unconditional-304"), cache: prepared })
  assert.equal(unexpected.status, "HOLD"); assert.ok(unexpected.reasons.includes("CACHE_HANDLE_REQUIRED"))
})
test("P06 enforces the current body budget when reusing a cached body", async t => {
  const s = await server(t), prepared = await prepareNativeHttp(input(s.base, "/conditional"))
  const limited = await observeNativeHttp({ ...input(s.base, "/conditional"), maxBytes: 1, cache: prepared })
  assert.equal(limited.status, "HOLD", JSON.stringify(limited)); assert.ok(limited.reasons.includes("CACHE_BODY_LIMIT"))
})
test("P06 snapshots data descriptors once and rejects input accessors", async t => {
  const s = await server(t), value = input(s.base, "/ok")
  let reads = 0
  Object.defineProperty(value, "url", { enumerable: true, get: () => { reads++; return `${s.base}/ok` } })
  await assert.rejects(observeNativeHttp(value), /enumerable data property/)
  assert.equal(reads, 0)
})
