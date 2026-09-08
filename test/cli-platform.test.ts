import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { Effect, Either, Layer } from "effect"
import { temporary } from "./fixtures.js"
import { PlatformUsageError, runPlatformCommand } from "../src/cli-platform.js"
import { compileSource, observeProgram } from "../src/language/index.js"
import { Resolvers } from "../src/resolve.js"
import { formatLocator } from "../src/locator.js"
import { graphEngineeringDigest } from "../src/integrations/graph-engineering.js"

test("platform init refuses overwrite and watch once opens its generated USL", async (t) => {
  const dir = await temporary(t), source = path.join(dir, "game.usl")
  assert.equal(await runPlatformCommand(["init", "--out", source]), true)
  assert.match(await fs.readFile(source, "utf8"), /namespace "game.example"/)
  await assert.rejects(runPlatformCommand(["init", "--out", source]), PlatformUsageError)
  assert.equal(await runPlatformCommand(["watch", "--source", source, "--once"]), true)
  await assert.rejects(runPlatformCommand(["init", "--out", source, "--unknown"]), PlatformUsageError)
  assert.equal(await runPlatformCommand(["init", "--help"]), true)
  await assert.rejects(runPlatformCommand(["watch", "--source", source, "--out", path.join(dir, "no")]), PlatformUsageError)
})

test("platform output never aliases report inputs", async (t) => {
  const dir = await temporary(t), before = path.join(dir, "before.json"), after = path.join(dir, "after.json")
  const plan = Either.getOrThrow(compileSource('usl "0.1"; namespace "platform"; resource a = "https://example.test/a"; resource b = "https://example.test/b"; meaning relates(left: url, right: url) = "a relates to b"; link l = relates(left: a, right: b);'))
  const resolver = Layer.succeed(Resolvers, { resolve: (locator: any) => Effect.succeed({ locator, resolvedLocator: formatLocator(locator), contentHash: "a".repeat(64), resolvedAt: "2026-09-08T00:00:00.000Z", guaranteeLevel: "pure" as const, matchCount: 1 }) })
  const report = await Effect.runPromise(observeProgram(plan, { sourceText: 'usl "0.1"; namespace "platform"; resource a = "https://example.test/a"; resource b = "https://example.test/b"; meaning relates(left: url, right: url) = "a relates to b"; link l = relates(left: a, right: b);' }).pipe(Effect.provide(resolver)))
  const bytes = JSON.stringify(report) + "\n"; await fs.writeFile(before, bytes); await fs.writeFile(after, bytes)
  await assert.rejects(runPlatformCommand(["compare", "--before", before, "--after", after, "--out", before]))
  const alias = path.join(dir, "alias.json"); await fs.symlink(before, alias)
  await assert.rejects(runPlatformCommand(["compare", "--before", before, "--after", after, "--out", alias]))
  assert.equal(await fs.readFile(before, "utf8"), bytes)
})

test("graph import supplies exact graph text to bindings", async (t) => {
  const dir = await temporary(t), graph = path.join(dir, "g.json"), bindings = path.join(dir, "b.json")
  const value: any = { apiVersion: "symposium.graphspec/v0alpha1", kind: "GraphSpec", metadata: { graph_id: "p", graph_version: "1" }, authority: {}, identity: { canonicalizer: "jcs-like-json-v1;graphspec_sha256-omitted" }, topology: { nodes: [], edges: [] }, lifecycle: { machine_sha256: "" }, loop: {}, effects: {}, evidence: {} }
  value.identity.topology_sha256 = graphEngineeringDigest(value.topology); const machine = structuredClone(value.lifecycle); delete machine.machine_sha256; value.lifecycle.machine_sha256 = graphEngineeringDigest(machine); value.identity.lifecycle_sha256 = graphEngineeringDigest(value.lifecycle); value.identity.loop_policy_sha256 = graphEngineeringDigest(value.loop); value.identity.effect_policy_sha256 = graphEngineeringDigest(value.effects); const unsigned = structuredClone(value); delete unsigned.identity.graphspec_sha256; value.identity.graphspec_sha256 = graphEngineeringDigest(unsigned)
  const raw = JSON.stringify(value); await fs.writeFile(graph, raw); await fs.writeFile(bindings, JSON.stringify({ source: { resource: "graphspec", locator: "file://fixture/g.json" } }))
  assert.equal(await runPlatformCommand(["graph-import", "--graph", graph, "--bindings", bindings]), true)
  await fs.writeFile(bindings, JSON.stringify({ source: { resource: "graphspec", locator: "file://fixture/g.json", text: "wrong" } }))
  await assert.rejects(runPlatformCommand(["graph-import", "--graph", graph, "--bindings", bindings]), /must match/)
})
