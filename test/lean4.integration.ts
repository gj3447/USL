import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Either } from "effect"
import { readLean4Export, lean4ExportSchema } from "../src/integrations/lean4.js"
import { adaptResourceGraph, type ResourceGraph } from "../src/integrations/resource-graph.js"
import { agentContext } from "../src/language/navigation.js"
import { observeProgram } from "../src/language/runtime.js"
import { Resolvers } from "../src/resolve.js"
import { formatLocator } from "../src/locator.js"

const cwd = fileURLToPath(new URL("../lean/", import.meta.url))
const run = promisify(execFile)

test("real Lean elaborates model proofs and exports full names, types and axiom dependencies", async () => {
  const raw = await Effect.runPromise(readLean4Export({ cwd, file: "Examples/Connections.lean" }))
  const snapshot = lean4ExportSchema.parse(JSON.parse(raw))
  assert.equal(snapshot.check?.status, "PROCESS_EXIT_ZERO")
  assert.match(snapshot.check!.sourceDigest, /^sha256:/)
  assert.equal(snapshot.declarations.length, 12)
  assert.equal(snapshot.declarations.filter(declaration => declaration.name.startsWith("Usl.")).length, 10)
  assert.ok(snapshot.declarations.every(declaration => !declaration.axioms.includes("sorryAx")))
  assert.match(snapshot.declarations.find(declaration => declaration.name === "Demo.dash_requires_ground")!.type, /grounded/)
})

test("transitive sorry is retained; failed compilation and duplicate exports never yield a successful report", async t => {
  const dir = await mkdtemp(join(cwd, ".lake", "usl-test-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, "Proofs.lean")
  await writeFile(file, "import Usl\ntheorem unfinished : True := by sorry\ntheorem indirect : True := unfinished\n#usl_export [indirect]\n")
  const snapshot = JSON.parse(await Effect.runPromise(readLean4Export({ cwd, file })))
  assert.ok(snapshot.declarations[0].axioms.includes("sorryAx"))
  assert.ok(snapshot.check.warnings.length > 0)
  await writeFile(file, "import Usl\n#usl_export [True.intro]\nexample : False := by exact True.intro\n")
  await assert.rejects(Effect.runPromise(readLean4Export({ cwd, file })))
  await writeFile(file, "import Usl\n#usl_export [True.intro]\n#usl_export [True.intro]\n")
  await assert.rejects(Effect.runPromise(readLean4Export({ cwd, file })), /exactly one/)
  await assert.rejects(Effect.runPromise(readLean4Export({ cwd, file, maxSourceBytes: 1 })), /maxInputBytes/)
  await assert.rejects(Effect.runPromise(readLean4Export({ cwd, file, timeoutMs: 0 })), /execution limit/)
})

test("100 bounded paths and read-scope selection agree between Lean's model and the TS implementation", async () => {
  const { stdout } = await run("lake", ["env", "lean", "Examples/Conformance.lean"], { cwd, timeout: 30000, maxBuffer: 1024 * 1024 })
  const expected = JSON.parse(stdout)
  const input: ResourceGraph = {
    schema: "usl-resource-graph/v1",
    resources: ["a", "b", "c", "d", "isolated"].map(id => ({ id, types: ["urn:test:Resource"], locator: `file://fixture/${id}` })),
    meanings: ["implements", "supports", "references"].map(id => ({ id, description: id })),
    links: [
      { id: "ab", meaning: "implements", participants: [{ role: "implementation", resource: "a" }, { role: "specification", resource: "b" }] },
      { id: "bcd", meaning: "supports", participants: [{ role: "subject", resource: "b" }, { role: "proof", resource: "c" }, { role: "evidence", resource: "d" }] },
      { id: "ca", meaning: "references", participants: [{ role: "source", resource: "c" }, { role: "target", resource: "a" }] },
    ],
  }
  const graph = Either.getOrThrow(adaptResourceGraph(JSON.stringify(input), { namespace: "conformance" }))
  for (const path of expected.paths) {
    const context = Either.getOrThrow(agentContext(graph.plan, {
      focus: graph.identities.resources[path.start]!, target: graph.identities.resources[path.target]!, maxHops: path.hops,
    }))
    assert.equal(context.target?.status === "FOUND", path.found, JSON.stringify(path))
  }
  assert.equal(expected.paths.length, 100)
  const calls: string[] = []
  await Effect.runPromise(observeProgram(graph.plan, { allowedLocators: ["file://fixture/a", "file://fixture/c"] })
    .pipe(Effect.provideService(Resolvers, { resolve: locator => Effect.sync(() => {
      calls.push(formatLocator(locator))
      return { locator, resolvedLocator: formatLocator(locator), contentHash: "a".repeat(64),
        resolvedAt: "2026-09-14T00:00:00.000Z", guaranteeLevel: "pure" as const, matchCount: 1 }
    }) })))
  assert.deepEqual(calls.sort(), expected.reads.map((id: string) => `file://fixture/${id}`).sort())
})
