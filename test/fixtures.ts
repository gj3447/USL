import type { TestContext } from "node:test"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { Effect, Layer } from "effect"
import { Config, ResolversLive, type ResolverConfig } from "../src/resolve.js"

export const temporary = async (t: TestContext) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "usl-test-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}
export const rpcResponse = (records: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(records) }] } }), { status: 200 })
export const fixture = async (t: TestContext) => {
  const dir = await temporary(t)
  const repo = path.join(dir, "repo")
  await fs.mkdir(repo)
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim()
  git("init", "-q")
  await fs.writeFile(path.join(repo, "source.txt"), "first\nsecond\n")
  git("add", "source.txt")
  git("-c", "user.name=USL Test", "-c", "user.email=usl-test@example.invalid", "commit", "-qm", "fixture")
  const commit = git("rev-parse", "HEAD")
  const file = path.join(dir, "target.txt")
  await fs.writeFile(file, "baseline\n")
  const state = { kgVersion: "v1", urlBody: "url baseline", urlStatus: 200, kgMissing: false }
  const fetchImpl: typeof fetch = async (url, init) => {
    if (init?.method === "POST") {
      const uid = (JSON.parse(String(init.body)) as { params: { arguments: { uid: string } } }).params.arguments.uid
      return rpcResponse(state.kgMissing ? [] : [{ uid, uid_match_count: 1, name: "USL fixture", title: state.kgVersion, legacy_labels: ["Concept"] }])
    }
    return new Response(state.urlBody, { status: state.urlStatus })
  }
  const cfg: ResolverConfig = { hostname: os.hostname(), gitRepos: { "fixture/repo": repo }, kgMcpUrl: "http://kg.test/mcp", fetchImpl }
  const run = <A, E>(effect: Effect.Effect<A, E, import("../src/resolve.js").Resolvers>, override: Partial<ResolverConfig> = {}) => Effect.runPromise(effect.pipe(Effect.provide(ResolversLive.pipe(Layer.provide(Layer.succeed(Config, { ...cfg, ...override }))))))
  return { dir, repo, file, commit, git, cfg, run, state, loc: { kg: "kg://canonical-neo4j/sym:Concept:test", url: "https://fixture.test/doc", git: `git://fixture/repo@${commit}:source.txt`, fs: `file://${cfg.hostname}${file}` } }
}
