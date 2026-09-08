/** Read-only post-fix I/O probes. Run: npx tsx audit/round2-io.ts */
import { execFile } from "node:child_process"
import { once } from "node:events"
import { createServer, type Server } from "node:http"
import { link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir, hostname } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Either } from "effect"
import { parseLocator } from "../src/locator.js"
import { resolveWith, type ResolverConfig } from "../src/resolve.js"
import { writeTextAtomic } from "../src/storage.js"

type Result = { id: string; severity: "medium" | "low" | "info"; outcome: "fixed" | "finding" | "known" | "safe_limit"; actual: string; prerequisite: string; source: string }
const results: Result[] = []
const root = fileURLToPath(new URL("..", import.meta.url))
const runCli = (args: string[]) => new Promise<{ code: number; stderr: string }>((resolve) => execFile(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: root, env: { ...process.env, USL_HOSTNAME: hostname(), USL_GIT_REPOS: "{}", USL_KG_SOURCES: "{}" } }, (error, _stdout, stderr) => resolve({ code: typeof error?.code === "number" ? error.code : error ? 1 : 0, stderr })))
const record = [{ link_id: "l1", semantic_relation: "DOCUMENTED_IN", from_endpoint_kind: "kg", from_locator: "kg://canonical-neo4j/sym:Concept:usl", to_endpoint_kind: "filesystem", to_locator: "file://host/tmp/doc", direction: "directed", resolved_at_from: "t", resolved_at_to: "t", resolved_locator_from: "kg://canonical-neo4j/sym:Concept:usl", resolved_locator_to: "file://host/tmp/doc", pierced_at: "t", drift_detected_at: null, drift_score: 0, content_hash_from: "a", content_hash_to: "b", confidence: "EXTRACTED", guarantee_level: "trust_host", status: "RESOLVES", provenance_actor: "audit", provenance_tool_version: "usl/0.3.0", provenance_command: "audit", provenance_date: "2026-09-08", hswm_owner_ref: null }]
const listen = async (server: Server) => { server.listen(0, "127.0.0.1"); await once(server, "listening"); return `http://127.0.0.1:${(server.address() as { port: number }).port}` }
const close = async (server: Server) => { server.close(); await once(server, "close") }

{
  const dir = await mkdtemp(join(tmpdir(), "usl-round2-"))
  try {
    const records = join(dir, "records.json"), utterance = join(dir, "utterance.txt"), anchors = join(dir, "anchors.json"), bundle = join(dir, "bundle.json")
    await writeFile(records, JSON.stringify(record)); await writeFile(utterance, "keep utterance\n"); await writeFile(anchors, "{}\n")
    const args = ["project", "--records", records, "--bundle-uid", "bundle:round2", "--utterance-file", utterance, "--anchors", anchors]
    const before = await Promise.all([readFile(records, "utf8"), readFile(utterance, "utf8"), readFile(anchors, "utf8")])
    const direct = await Promise.all([records, utterance, anchors].map((out) => runCli([...args, "--out", out])))
    const aliases: string[] = []
    for (const [name, input] of [["records-link", records], ["utterance-link", utterance], ["anchors-link", anchors]] as const) { const alias = join(dir, name); await symlink(input, alias); aliases.push(alias) }
    const symlinked = await Promise.all(aliases.map((out) => runCli([...args, "--out", out])))
    const parentAlias = join(dir, "parent-link")
    await symlink(dir, parentAlias)
    const throughParent = await runCli([...args, "--out", join(parentAlias, "utterance.txt")])
    const utteranceInputAlias = join(dir, "utterance-input-link")
    await symlink(utterance, utteranceInputAlias)
    const aliasedInput = await runCli(["project", "--records", records, "--bundle-uid", "bundle:round2", "--utterance-file", utteranceInputAlias, "--anchors", anchors, "--out", utterance])
    const ok = await runCli([...args, "--out", bundle])
    const unchanged = JSON.stringify(before) === JSON.stringify(await Promise.all([readFile(records, "utf8"), readFile(utterance, "utf8"), readFile(anchors, "utf8")]))
    results.push({ id: "R2-01-f06-direct-and-symlink-inputs", severity: "info", outcome: direct.every((r) => r.code === 64) && symlinked.every((r) => r.code === 64) && throughParent.code === 64 && aliasedInput.code === 64 && ok.code === 0 && unchanged ? "fixed" : "finding", actual: `direct=${direct.map((r) => r.code)} symlink=${symlinked.map((r) => r.code)} parentAlias=${throughParent.code} inputAlias=${aliasedInput.code} distinct=${ok.code} originalsUnchanged=${unchanged}.`, prerequisite: "None beyond invoking the legacy project CLI with existing local inputs.", source: "src/cli.ts:14-18,164-173" })
    const hardlink = join(dir, "utterance-hardlink")
    await link(utterance, hardlink)
    const hardResult = await runCli([...args, "--out", hardlink])
    const utteranceStill = await readFile(utterance, "utf8")
    results.push({ id: "R2-02-f06-hardlink-is-not-rejected-but-does-not-overwrite-input", severity: "low", outcome: hardResult.code === 0 && utteranceStill === "keep utterance\n" ? "safe_limit" : "finding", actual: `hardlink output exits=${hardResult.code}; original utterance preserved=${utteranceStill === "keep utterance\n"}. Atomic rename replaces only the output directory entry.`, prerequisite: "An actor able to create a same-filesystem hardlink to an input and choose --out; this is a local filesystem capability.", source: "src/cli.ts:14-18,167; src/storage.ts:30-35" })
  } finally { await rm(dir, { recursive: true, force: true }) }
}

{
  const dir = await mkdtemp(join(tmpdir(), "usl-round2-storage-"))
  try {
    const target = join(dir, "target.txt"), output = join(dir, "output-link")
    await writeFile(target, "original"); await symlink(target, output)
    let rejected = false; try { await writeTextAtomic(output, "replacement") } catch { rejected = true }
    results.push({ id: "R2-03-storage-refuses-output-symlink", severity: "info", outcome: rejected && await readFile(target, "utf8") === "original" ? "fixed" : "finding", actual: `rejected=${rejected}; targetPreserved=${await readFile(target, "utf8") === "original"}.`, prerequisite: "A local caller passes a symlink as the output path.", source: "src/storage.ts:30-35" })
  } finally { await rm(dir, { recursive: true, force: true }) }
}

{
  let targetHits = 0
  const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify([{ uid: "sym:Concept:round2", uid_match_count: 1 }]) }] } })
  const target = createServer((_req, res) => { targetHits++; res.end(rpc) }); const targetUrl = await listen(target)
  const start = createServer((_req, res) => { res.statusCode = 307; res.setHeader("location", targetUrl); res.end() }); const startUrl = await listen(start)
  const config: ResolverConfig = { hostname: "audit", gitRepos: {}, kgMcpUrl: "unused", kgSources: { local: startUrl }, allowedLocators: ["kg://local/sym:Concept:round2"], fetchImpl: fetch }
  const locator = Either.getOrThrow(parseLocator("kg://local/sym:Concept:round2"))
  const value = await Effect.runPromise(Effect.either(resolveWith(config)(locator)))
  results.push({ id: "R2-04-f08-mcp-307-remains-transport-redirect", severity: "medium", outcome: targetHits === 1 && Either.isRight(value) ? "known" : "fixed", actual: `unregistered loopback target hits=${targetHits}; resolution=${Either.isRight(value) ? "success" : "failure"}.`, prerequisite: "The configured MCP endpoint must issue a redirect. Impact is conditional on treating configured endpoint identity as a network permission boundary; logical allowedLocators does not express endpoint URLs.", source: "src/resolve.ts:194-199" })
  await close(start); await close(target)
}

{
  const config: ResolverConfig = { hostname: "audit", gitRepos: {}, kgMcpUrl: "unused", fetchImpl: fetch }
  let thrown = ""; try { (resolveWith(config) as (x: unknown) => unknown)(null) } catch (error) { thrown = error instanceof Error ? error.message : String(error) }
  results.push({ id: "R2-05-f10-null-resolver-input-remains-sync-throw", severity: "low", outcome: thrown ? "known" : "fixed", actual: `resolveWith(config)(null) ${thrown ? `throws ${JSON.stringify(thrown)}` : "does not throw"}.`, prerequisite: "A JavaScript or unsafe TypeScript caller invokes the exported resolver directly with malformed data; CLI/parser paths reject ordinary malformed locator text.", source: "src/resolve.ts:221-222; src/locator.ts:52-58" })
}

console.log(JSON.stringify({ isolation: "temporary local files, hardlinks/symlinks, and loopback HTTP only", results }, null, 2))
