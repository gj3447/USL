import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Either } from "effect"
import { readLean4Export, lean4ExportSchema } from "../src/integrations/lean4.js"
import { adaptResourceGraph, type ResourceGraph } from "../src/integrations/resource-graph.js"
import { agentContext } from "../src/language/navigation.js"
import { observeProgram } from "../src/language/runtime.js"
import { Resolvers } from "../src/resolve.js"
import { formatLocator } from "../src/locator.js"
import { initialAttemptState, transitionAttempt, type AttemptEvent } from "../src/attempt-state.js"
import { parseResourceBindings, resolveResourceRepresentation, selectResourceRepresentation } from "../src/resource-bindings.js"

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

test("all 54 public model theorems pass Lean with only the allowed foundational axioms", async () => {
  const raw = await Effect.runPromise(readLean4Export({ cwd, file: "Examples/ProofAudit.lean" }))
  const snapshot = lean4ExportSchema.parse(JSON.parse(raw))
  const sources = await Promise.all(["Core", "Verification", "Contracts", "Attempt", "Bindings"].map(name => readFile(join(cwd, "Usl", `${name}.lean`), "utf8")))
  const names = sources.flatMap(source => [...source.matchAll(/^theorem ([A-Za-z0-9_.]+)/gm)].map(match => `Usl.${match[1]}`))
  assert.equal(names.length, 54)
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

test("100 paths, 80 role routes, 192 read budgets, 11 graph cases, attempt and binding cases agree with TypeScript", async t => {
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
  const event = (text: string): AttemptEvent => {
    if (text === "INTENT_SAVED") return { type: text }
    if (text === "REJECT_BEFORE_START") return { type: text }
    const [type, first, second] = text.split(":")
    if (type === "AUTHORIZE_START") return { type, pinsMatch: first === "true" }
    if (type === "FINISH") return { type, started: first === "true", succeeded: second === "true" }
    throw new Error(`unknown Lean attempt event: ${text}`)
  }
  for (const fixture of expected.attempts) {
    const state = fixture.trace.reduce((current: ReturnType<typeof initialAttemptState>, encoded: string) => transitionAttempt(current, event(encoded)), initialAttemptState())
    assert.equal(state.phase, fixture.phase, JSON.stringify(fixture))
  }
  assert.equal(expected.attempts.length, 7)
  for (const fixture of expected.attemptMatrix) {
    let result = "INVALID"
    try { result = transitionAttempt({ phase: fixture.phase } as ReturnType<typeof initialAttemptState>, event(fixture.event)).phase } catch { /* Lean none maps to a rejected TS transition. */ }
    assert.equal(result, fixture.result, JSON.stringify(fixture))
  }
  assert.equal(expected.attemptMatrix.length, 48)
  for (const fixture of expected.bindings) {
    const document = parseResourceBindings({ schema: "usl-resource-bindings/v1", resources: [{ id: "node:portable", representations: fixture.representations.map((id: string) =>
      ({ id, relation: "working-copy", kind: "workspace", workspace: "portable", path: `representations/${id}` })) }] })
    if (fixture.found) {
      const selected = selectResourceRepresentation(document, { resource: "node:portable", ...(fixture.selected === null ? {} : { representation: fixture.selected }) })
      assert.equal(selected.resource.id, "node:portable", fixture.name)
      if (fixture.selected !== null) assert.equal(selected.representation.id, fixture.selected, fixture.name)
    } else {
      assert.throws(() => selectResourceRepresentation(document, { resource: "node:portable", ...(fixture.selected === null ? {} : { representation: fixture.selected }) }), /ambiguous|unknown representation/, fixture.name)
    }
    assert.equal(document.resources[0]!.id, fixture.resource, fixture.name)
    assert.deepEqual(document.resources[0]!.representations.map(representation => representation.id), fixture.representationIds, fixture.name)
  }
  assert.equal(expected.bindings.length, 5)
  const relocation = expected.relocation as { before: { resource: string; representationIds: string[]; addresses: string[] }; after: { resource: string; representationIds: string[]; addresses: string[] } }
  assert.equal(relocation.before.representationIds.length, 1); assert.equal(relocation.after.representationIds.length, 1)
  assert.equal(relocation.before.addresses.length, 1); assert.equal(relocation.after.addresses.length, 1)
  const root = await mkdtemp(join(cwd, ".lake", "usl-binding-relocation-")); t.after(() => rm(root, { recursive: true, force: true }))
  const beforePath = relocation.before.addresses[0]!, afterPath = relocation.after.addresses[0]!
  await mkdir(join(root, "before")); await mkdir(join(root, "after")); await writeFile(join(root, beforePath), "same-content")
  const binding = (state: typeof relocation.before) => parseResourceBindings({ schema: "usl-resource-bindings/v1", resources: [{ id: state.resource, representations: [{ id: state.representationIds[0]!, relation: "working-copy", kind: "workspace", workspace: "portable", path: state.addresses[0]! }] }] })
  const before = binding(relocation.before), after = binding(relocation.after)
  const beforeResolved = await resolveResourceRepresentation(before, { resource: relocation.before.resource, representation: relocation.before.representationIds[0]! }, { workspaces: { portable: root } })
  await rename(join(root, beforePath), join(root, afterPath))
  const afterResolved = await resolveResourceRepresentation(after, { resource: relocation.after.resource, representation: relocation.after.representationIds[0]! }, { workspaces: { portable: root } })
  assert.equal(beforeResolved.resource, relocation.before.resource)
  assert.equal(afterResolved.resource, relocation.after.resource)
  assert.equal(beforeResolved.representation, relocation.before.representationIds[0]!)
  assert.equal(afterResolved.representation, relocation.after.representationIds[0]!)
  assert.equal(beforeResolved.relativePath, relocation.before.addresses[0]!)
  assert.equal(afterResolved.relativePath, relocation.after.addresses[0]!)
  assert.notEqual(beforeResolved.locator, afterResolved.locator)
})
