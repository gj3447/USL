import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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

test("all 37 public model theorems pass Lean with only the allowed foundational axioms", async () => {
  const raw = await Effect.runPromise(readLean4Export({ cwd, file: "Examples/ProofAudit.lean" }))
  const snapshot = lean4ExportSchema.parse(JSON.parse(raw))
  const sources = await Promise.all(["Core", "Verification", "Contracts"].map(name => readFile(join(cwd, "Usl", `${name}.lean`), "utf8")))
  const names = sources.flatMap(source => [...source.matchAll(/^theorem ([A-Za-z0-9_.]+)/gm)].map(match => `Usl.${match[1]}`))
  assert.equal(names.length, 37)
  assert.deepEqual(snapshot.declarations.map(declaration => declaration.name).sort(), names.sort())
  const allowedAxioms = new Set(["propext", "Classical.choice", "Quot.sound"])
  for (const declaration of snapshot.declarations) {
    assert.equal(declaration.kind, "theorem", declaration.name)
    assert.equal(declaration.unsafe, false, declaration.name)
    assert.equal(declaration.partial, false, declaration.name)
    for (const axiom of declaration.axioms) assert.ok(allowedAxioms.has(axiom), `${declaration.name} depends on ${axiom}`)
  }
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

test("100 paths, 80 role routes, 192 read budgets and 11 graph cases agree with TypeScript", async () => {
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
  for (const route of expected.routes) {
    const routes = route.policy.map((policy: { meaning: string; enter: string; exit: string }) => {
      const original = input.links.find(link => link.meaning === policy.meaning)!
      const meaning = graph.plan.links.find(link => link.name === graph.identities.links[original.id])!.meaning
      return { ...policy, meaning }
    })
    const context = Either.getOrThrow(agentContext(graph.plan, {
      focus: graph.identities.resources[route.start]!, target: graph.identities.resources[route.target]!, maxHops: 1, routes,
    }))
    assert.equal(context.target?.status === "FOUND", route.found, JSON.stringify(route))
    if (route.found) {
      const step = context.target!.path!.steps[0]!
      assert.ok(routes.some((policy: { meaning: string; enter: string; exit: string }) =>
        policy.meaning === step.meaning && policy.enter === step.enteredRole && policy.exit === step.exitedRole))
    }
  }
  assert.equal(expected.routes.length, 80)
  for (const fixture of expected.validation) {
    assert.equal(Either.isRight(adaptResourceGraph(JSON.stringify(fixture.graph), { namespace: "validation" })), fixture.valid, fixture.name)
  }
  assert.equal(expected.validation.length, 11)
  for (const fixture of expected.budgets) {
    const reads: string[] = []
    const result = await Effect.runPromise(observeProgram(graph.plan, {
      maxResources: fixture.budget,
      allowedLocators: fixture.allowed.map((id: string) => `file://fixture/${id}`),
    }).pipe(Effect.provideService(Resolvers, { resolve: locator => Effect.sync(() => {
      reads.push(formatLocator(locator))
      return { locator, resolvedLocator: formatLocator(locator), contentHash: "a".repeat(64),
        resolvedAt: "2026-09-14T00:00:00.000Z", guaranteeLevel: "pure" as const, matchCount: 1 }
    }) }), Effect.either))
    if (fixture.output === null) {
      assert.ok(Either.isLeft(result), JSON.stringify(fixture))
      assert.match(result.left.detail, /exceeding maxResources/)
      assert.deepEqual(reads, [], "an excessive request must fail before resolver IO")
    } else {
      assert.ok(Either.isRight(result), JSON.stringify(fixture))
      assert.deepEqual(reads.sort(), fixture.output.map((id: string) => `file://fixture/${id}`).sort())
      assert.ok(reads.length <= fixture.budget)
    }
  }
  assert.equal(expected.budgets.length, 192)
})
