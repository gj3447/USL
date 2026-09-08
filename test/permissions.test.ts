import { test } from "node:test"
import assert from "node:assert/strict"
import { Effect, Either, Layer } from "effect"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { parseLocator } from "../src/locator.js"
import { Config, Resolvers, ResolversLive, resolveWith, type ResolverConfig, type ResolverOptions } from "../src/resolve.js"

const locator = (value: string) => Either.getOrThrow(parseLocator(value))
const resolve = (cfg: ResolverConfig, value: string) => Effect.runPromise(Effect.either(resolveWith(cfg)(locator(value))))
const cfg = (fetchImpl: typeof fetch, allowedLocators?: ReadonlyArray<string>): ResolverConfig => ({ hostname: "permissions-test", gitRepos: {}, kgMcpUrl: "http://kg.test/mcp", fetchImpl, ...(allowedLocators === undefined ? {} : { allowedLocators }) })
const resolveLive = (config: ResolverConfig, value: string, options?: ResolverOptions) => Effect.runPromise(Effect.either(
  Effect.gen(function* () { return yield* (yield* Resolvers).resolve(locator(value), options) }).pipe(
    Effect.provide(ResolversLive.pipe(Layer.provide(Layer.succeed(Config, config)))),
  ),
))

test("exact locator policy permits selected reads and denies unselected reads before fetch", async () => {
  const seen: string[] = []
  const fetchImpl: typeof fetch = async (url) => { seen.push(String(url)); return new Response("ok") }
  const permitted = "https://allowed.test/reference"
  assert.ok(Either.isRight(await resolve(cfg(fetchImpl, [permitted]), permitted)))
  const denied = await resolve(cfg(fetchImpl, [permitted]), "https://other.test/reference")
  assert.ok(Either.isLeft(denied)); assert.equal(denied.left.reason, "DENIED")
  assert.deepEqual(seen, [permitted])
})

test("redirect targets need their own allowlist entry before a second request", async () => {
  const seen: string[] = []
  const start = "https://inside.test/start"
  const fetchImpl: typeof fetch = async (url) => {
    seen.push(String(url))
    return new Response(null, { status: 302, headers: { location: "https://outside.test/secret" } })
  }
  const result = await resolve(cfg(fetchImpl, [start]), start)
  assert.ok(Either.isLeft(result)); assert.equal(result.left.reason, "DENIED")
  assert.deepEqual(seen, [start])
})

test("filesystem symlink targets require separate canonical locator authorization", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "usl-permissions-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const target = path.join(dir, "outside.txt")
  const link = path.join(dir, "selected-link.txt")
  await fs.writeFile(target, "secret")
  await fs.symlink(target, link)
  const original = `file://permissions-test${link}`
  const canonical = `file://permissions-test${target}`
  const noTarget = await resolve(cfg(fetch, [original]), original)
  assert.ok(Either.isLeft(noTarget)); assert.equal(noTarget.left.reason, "DENIED")
  assert.ok(Either.isRight(await resolve(cfg(fetch, [original, canonical]), original)))
})

test("invalid policy entries fail before resolver I/O", async () => {
  let calls = 0
  const fetchImpl: typeof fetch = async () => { calls++; return new Response("ok") }
  const result = await resolve(cfg(fetchImpl, ["not a locator"]), "https://allowed.test/reference")
  assert.ok(Either.isLeft(result)); assert.equal(result.left.reason, "IO")
  assert.equal(calls, 0)
})

test("live request policy can narrow Config policy but cannot broaden it", async () => {
  const first = "https://allowed.test/one", second = "https://allowed.test/two"
  const fetchImpl: typeof fetch = async () => new Response("ok")
  assert.ok(Either.isRight(await resolveLive(cfg(fetchImpl, [first, second]), first, { allowedLocators: [first] })))
  const broaden = await resolveLive(cfg(fetchImpl, [first]), second, { allowedLocators: [second] })
  assert.ok(Either.isLeft(broaden)); assert.equal(broaden.left.reason, "DENIED")
})

test("malformed base policy is not hidden by a narrower request policy", async () => {
  let calls = 0
  const fetchImpl: typeof fetch = async () => { calls++; return new Response("ok") }
  const result = await resolveLive(cfg(fetchImpl, ["not a locator"]), "https://allowed.test/one", { allowedLocators: [] })
  assert.ok(Either.isLeft(result)); assert.equal(result.left.reason, "IO")
  assert.equal(calls, 0)
})

test("KG and Git denials happen before their endpoint access", async () => {
  let calls = 0
  const fetchImpl: typeof fetch = async () => { calls++; return new Response("ok") }
  const kg = await resolve(cfg(fetchImpl, []), "kg://canonical-neo4j/sym:Concept:private")
  assert.ok(Either.isLeft(kg)); assert.equal(kg.left.reason, "DENIED")
  const git = await resolve({ ...cfg(fetchImpl, []), gitRepos: { "fixture/repo": "/definitely-not-a-checkout" } }, "git://fixture/repo")
  assert.ok(Either.isLeft(git)); assert.equal(git.left.reason, "DENIED")
  assert.equal(calls, 0)
})

test("URL policy normalizes equivalent URL spellings", async () => {
  const fetchImpl: typeof fetch = async () => new Response("ok")
  assert.ok(Either.isRight(await resolve(cfg(fetchImpl, ["https://allowed.test"]), "https://allowed.test/")))
})
