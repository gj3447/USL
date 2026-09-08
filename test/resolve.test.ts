import { test } from "node:test"
import assert from "node:assert/strict"
import { Effect, Either } from "effect"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { parseLocator } from "../src/locator.js"
import { resolveWith, type ResolverConfig } from "../src/resolve.js"
import { fixture, rpcResponse } from "./fixtures.js"

const cfg = (fetchImpl: typeof fetch, extra: Partial<ResolverConfig> = {}): ResolverConfig => ({ hostname: "test", gitRepos: {}, kgMcpUrl: "http://canonical.test/mcp", fetchImpl, ...extra })
const resolve = (config: ResolverConfig, locator = "kg://canonical-neo4j/sym:Concept:test") => Effect.runPromise(Effect.either(resolveWith(config)(Either.getOrThrow(parseLocator(locator)))))
const expectReason = (result: Awaited<ReturnType<typeof resolve>>, reason: string) => { assert.ok(Either.isLeft(result)); assert.equal(result.left.reason, reason) }

test("KG routes by source and never fetches an unregistered source", async () => {
  const seen: string[] = []
  const config = cfg(async (url) => { seen.push(String(url)); return rpcResponse([{ uid: "sym:Concept:test", uid_match_count: 1 }]) }, { kgSources: { second: "http://second.test/mcp" } })
  assert.ok(Either.isRight(await resolve(config)))
  assert.ok(Either.isRight(await resolve(config, "kg://second/sym:Concept:test")))
  expectReason(await resolve(config, "kg://unknown/sym:Concept:test"), "IO")
  assert.deepEqual(seen, ["http://canonical.test/mcp", "http://second.test/mcp"])
})

test("KG validates identity, cardinality, protocol errors and HTTP status", async () => {
  const cases: Array<[unknown, string]> = [ [[], "ORPHAN"], [null, "ORPHAN"], [[{ uid: "wrong" }], "IO"], [[{ uid: "sym:Concept:test", uid_match_count: 0 }], "IO"], [[{ uid: "sym:Concept:test", uid_collision: true }], "AMBIGUOUS"], [[{}, {}], "AMBIGUOUS"], [{ arbitrary: true }, "IO"] ]
  for (const [body, reason] of cases) expectReason(await resolve(cfg(async () => rpcResponse(body))), reason)
  expectReason(await resolve(cfg(async () => new Response("[]", { status: 503 }))), "IO")
  expectReason(await resolve(cfg(async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "[]" }] } })))), "IO")
  expectReason(await resolve(cfg(async () => new Response("malformed"))), "IO")
})

test("KG parses SSE messages after heartbeat/progress events", async () => {
  const body = await rpcResponse([{ uid: "sym:Concept:test", uid_match_count: 1 }]).text()
  const response = `: heartbeat\r\n\r\ndata: ping\r\n\r\nevent: message\r\ndata: {"jsonrpc":"2.0","id":2,"result":{}}\r\n\r\nevent: message\r\ndata: ${body}\r\n\r\n`
  assert.ok(Either.isRight(await resolve(cfg(async () => new Response(response)))))
})

for (const status of [401, 403, 404, 410, 429, 500, 503]) test(`HTTP ${status} classification`, async () => {
  expectReason(await resolve(cfg(async () => new Response("error", { status })), "https://fixture.test/doc"), status === 404 || status === 410 ? "ORPHAN" : "IO")
})

test("resolution deadline cancels fetch; body size limit fails with IO", async () => {
  let aborted = false
  const stalled: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")) }, { once: true })
  })
  expectReason(await resolve(cfg(stalled, { timeoutMs: 20 }), "https://fixture.test/doc"), "IO")
  assert.equal(aborted, true)
  expectReason(await resolve(cfg(async () => new Response("12345"), { maxResponseBytes: 4 }), "https://fixture.test/doc"), "IO")
})

test("line bounds, inaccessible checkout and unrepresentable realpath cannot resolve", async (t) => {
  const f = await fixture(t)
  expectReason(await resolve(f.cfg, `${f.loc.fs}#L2-L2`), "ORPHAN")
  expectReason(await resolve(f.cfg, `${f.loc.git}@L3-L3`), "ORPHAN")
  assert.ok(Either.isRight(await resolve(f.cfg, `${f.loc.git}@L1-L2`)))
  expectReason(await resolve({ ...f.cfg, gitRepos: { "fixture/repo": "/does-not-exist" } }, f.loc.git), "IO")
  const target = path.join(f.dir, "with space.txt"), link = path.join(f.dir, "link.txt")
  await fs.writeFile(target, "text"); await fs.symlink(target, link)
  expectReason(await resolve(f.cfg, `file://${f.cfg.hostname}${link}`), "AMBIGUOUS")
})

test("whole Git repository and filesystem directory are first-class resources", async (t) => {
  const f = await fixture(t)
  const root = await resolve(f.cfg, "git://fixture/repo")
  assert.ok(Either.isRight(root)); assert.equal(root.right.resolvedLocator, `git://fixture/repo@${f.commit}`)
  const pinned = await resolve(f.cfg, `git://fixture/repo@${f.commit}`)
  assert.ok(Either.isRight(pinned)); assert.equal(pinned.right.contentHash, root.right.contentHash)
  const dir = `file://${f.cfg.hostname}${f.dir}`
  const initial = await resolve(f.cfg, dir)
  assert.ok(Either.isRight(initial))
  await fs.writeFile(path.join(f.dir, "new-item.txt"), "new")
  const changed = await resolve(f.cfg, dir)
  assert.ok(Either.isRight(changed)); assert.notEqual(changed.right.contentHash, initial.right.contentHash)
  expectReason(await resolve(f.cfg, `${dir}#L1-L1`), "AMBIGUOUS")
})
