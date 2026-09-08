/**
 * Read-only resolver adversarial probes.
 *
 * Run with: npx tsx audit/io-probes.ts
 * It creates only loopback HTTP servers and temporary files; production source
 * and external services are never touched.
 */
import { createServer, type Server } from "node:http"
import { once } from "node:events"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Either } from "effect"
import { parseLocator } from "../src/locator.js"
import { resolveWith, type ResolverConfig } from "../src/resolve.js"

type Probe = { id: string; severity?: "medium" | "low"; outcome: "finding" | "resisted" | "documented_limit"; actual: string; expected: string; source: string }
const probes: Probe[] = []
const cfg = (overrides: Partial<ResolverConfig> = {}): ResolverConfig => ({
  hostname: "audit-host", gitRepos: {}, kgMcpUrl: "http://127.0.0.1/unused", fetchImpl: fetch, ...overrides,
})
const loc = (value: string) => Either.getOrThrow(parseLocator(value))
const run = (config: ResolverConfig, value: string) => Effect.runPromise(Effect.either(resolveWith(config)(loc(value))))
const listen = async (server: Server) => { server.listen(0, "127.0.0.1"); await once(server, "listening"); return `http://127.0.0.1:${(server.address() as { port: number }).port}` }
const close = async (server: Server) => { server.close(); await once(server, "close") }
const rpc = (uid: string) => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify([{ uid, uid_match_count: 1 }]) }] } })

// The KG resolver does not set redirect: "manual" and cannot authorize a
// redirect endpoint because allowedLocators contains logical locators, not MCP URLs.
{
  let redirectedTargetHits = 0
  let forwardedMethod = "", forwardedUid = "", forwardedTool = ""
  const target = createServer(async (req, res) => {
    redirectedTargetHits++
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { params?: { name?: string; arguments?: { uid?: string } } }
    forwardedMethod = req.method ?? ""; forwardedUid = body.params?.arguments?.uid ?? ""; forwardedTool = body.params?.name ?? ""
    res.setHeader("content-type", "application/json"); res.end(rpc("sym:Concept:audit"))
  })
  const targetUrl = await listen(target)
  const start = createServer((_req, res) => { res.statusCode = 307; res.setHeader("location", `${targetUrl}/unlisted`); res.end() })
  const startUrl = await listen(start)
  const result = await run(cfg({ kgSources: { local: `${startUrl}/mcp` }, allowedLocators: ["kg://local/sym:Concept:audit"] }), "kg://local/sym:Concept:audit")
  probes.push({
    id: "IO-01-mcp-redirect-forwards-request-to-unregistered-transport", severity: "medium", outcome: redirectedTargetHits === 1 && forwardedMethod === "POST" && forwardedUid === "sym:Concept:audit" && forwardedTool === "ontology_get" && Either.isRight(result) ? "finding" : "resisted",
    actual: `A permitted kg:// locator caused native fetch to follow a 307 to ${targetUrl}/unlisted; target hits=${redirectedTargetHits}; forwarded=${forwardedMethod} ${forwardedTool} uid=${forwardedUid}; result=${Either.isRight(result) ? "success" : "failure"}.`,
    expected: "If the deployment treats MCP endpoint selection as a network permission boundary, a selected logical KG locator must not forward its ontology_get request to a redirect target unless that transport endpoint is explicitly authorized. Current allowedLocators only expresses logical KG source/UID policy.",
    source: "src/resolve.ts:194-199",
  })
  await close(start); await close(target)
}

// Public JS callers can bypass TypeScript and hand a malformed locator to the
// exported resolver. This should produce ResolveError, not throw before an Effect exists.
{
  let thrown = "none"
  try { (resolveWith(cfg()) as (x: unknown) => unknown)(null) } catch (error) { thrown = error instanceof Error ? error.message : String(error) }
  probes.push({
    id: "IO-02-malformed-runtime-locator-throws", severity: "low", outcome: thrown !== "none" ? "finding" : "resisted",
    actual: `resolveWith(cfg)(null) throws synchronously: ${JSON.stringify(thrown)}.`,
    expected: "Malformed public runtime input should fail as a typed ResolveError/Effect without crashing the caller.",
    source: "src/resolve.ts:19,221-222; src/locator.ts:52-58",
  })
}

// ResolverConfig is TypeScript-readonly but not snapshot/frozen at runtime. This
// is an observation-integrity limit, not a policy bypass: callers must not share
// a mutable config object when they require a stable observation configuration.
{
  let release: (() => void) | undefined
  const bodyReady = new Promise<void>((resolve) => { release = resolve })
  const mutable = cfg({ maxResponseBytes: 100, fetchImpl: async () => { await bodyReady; return new Response("12345") } }) as { maxResponseBytes?: number; fetchImpl: typeof fetch; hostname: string; gitRepos: Record<string, string>; kgMcpUrl: string }
  const pending = run(mutable, "https://mutable.invalid/doc")
  mutable.maxResponseBytes = 4
  release!()
  const result = await pending
  probes.push({ id: "IO-L01-mutable-config-is-not-runtime-snapshot", outcome: Either.isLeft(result) && result.left.reason === "IO" ? "documented_limit" : "resisted", actual: `maxResponseBytes changed from 100 to 4 after fetch began; result=${Either.isLeft(result) ? result.left.reason : "success"}.`, expected: "A caller that needs a fixed observation contract must freeze/copy ResolverConfig before execution; this resolver does not promise that runtime immutability.", source: "src/resolve.ts:93-96,221-238" })
}

// These confirm two advertised boundaries held under hostile local fixtures.
{
  let requests = 0
  const result = await run(cfg({ allowedLocators: ["https://allowed.invalid/start"], fetchImpl: async () => {
    requests++; return new Response(null, { status: 302, headers: { location: "https://outside.invalid/secret" } })
  } }), "https://allowed.invalid/start")
  probes.push({ id: "IO-R01-http-redirect-is-checked-before-second-request", outcome: Either.isLeft(result) && requests === 1 ? "resisted" : "finding", actual: `redirect result=${Either.isLeft(result) ? result.left.reason : "success"}; requests=${requests}.`, expected: "An unlisted HTTP redirect must stop before a second request.", source: "src/resolve.ts:126-138" })
}

{
  const dir = await mkdtemp(join(tmpdir(), "usl-audit-"))
  try {
    const secret = join(dir, "secret.txt"), selected = join(dir, "selected.txt")
    await writeFile(secret, "private\n"); await symlink(secret, selected)
    const original = `file://audit-host${selected}#L1-L1`
    const result = await run(cfg({ allowedLocators: [original] }), original)
    probes.push({ id: "IO-R02-filesystem-realpath-needs-canonical-authorization", outcome: Either.isLeft(result) && result.left.reason === "DENIED" ? "resisted" : "finding", actual: `symlink result=${Either.isLeft(result) ? result.left.reason : "success"}.`, expected: "Authorizing only the symlink locator must not authorize its realpath target.", source: "src/resolve.ts:75-79" })
  } finally { await rm(dir, { recursive: true, force: true }) }
}

console.log(JSON.stringify({ generatedAt: new Date().toISOString(), isolation: "loopback HTTP, fake fetch, and temporary local files only", probes }, null, 2))
