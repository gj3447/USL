import { test } from "node:test"
import assert from "node:assert/strict"
import { Effect, Either, Layer } from "effect"
import { LanguageError, agentContext, compileSource, observeProgram, planDigest, usl } from "../src/language/index.js"
import { Resolvers, type ResolveError } from "../src/resolve.js"
import type { Locator, Resolution } from "../src/domain.js"
import { formatLocator } from "../src/locator.js"

const concept = usl.resource("concept", "kg://canonical-neo4j/sym:Concept:game-loop")
const spec = usl.resource("spec", "file://dev-01/game/spec.md")
const code = usl.resource("code", "file://dev-01/game/loop.ts")
const implementsMeaning = usl.meaning("implements", { roles: { spec: "filesystem", implementation: "filesystem", concept: "kg" }, description: "코드가 명세의 게임 루프를 구현한다", grounded: "kg://canonical-neo4j/sym:Concept:implements", contract: { scope: "고정된 게임 빌드", checks: [{ name: "review", description: "명세와 코드를 대조한다", evidenceRoles: ["spec", "implementation"] }] } } as const)
const link = usl.link("gameLoop", implementsMeaning, { spec, implementation: code, concept })

test("code-native declarations close dependencies, preserve aliases, and never run bound code", async () => {
  let runs = 0
  const run = () => { runs++; return "ran" }
  const bound = usl.bind(run, link)
  assert.equal(bound.run, run); assert.equal(runs, 0); assert.ok(Object.isFrozen(bound) && Object.isFrozen(bound.usl))
  const plan = Either.getOrThrow(usl.compile("game.loop", [bound.usl]))
  assert.ok(Object.isFrozen(plan)); assert.deepEqual(plan.resources.map((r) => r.name).sort(), ["code", "concept", "spec"])
  const nav = Either.getOrThrow(agentContext(plan, { focus: "spec", target: "code" }))
  assert.equal(nav.target?.status, "FOUND")
  const resolver = Layer.succeed(Resolvers, { resolve: (locator: Locator): Effect.Effect<Resolution, ResolveError> => Effect.succeed({ locator, resolvedLocator: formatLocator(locator), contentHash: "x", resolvedAt: "2026-09-08T00:00:00.000Z", guaranteeLevel: "pure", matchCount: 1 }) })
  const observed = await Effect.runPromise(observeProgram(plan).pipe(Effect.provide(resolver)))
  assert.equal(observed.semanticTruth, "NOT_EVALUATED")
})

test("code declarations reject bad locators/conflicts and source round-trips", () => {
  assert.throws(() => usl.resource("bad", "not-a-locator"), LanguageError)
  const plan = Either.getOrThrow(usl.compile("game.loop", [link]))
  const source = Either.getOrThrow(usl.source(plan))
  assert.deepEqual(Either.getOrThrow(compileSource(source)), plan)
  assert.equal(planDigest(Either.getOrThrow(compileSource(source))), planDigest(plan))
  const changed = usl.resource("code", "file://dev-01/game/other.ts")
  const other = usl.link("other", implementsMeaning, { spec, implementation: changed, concept })
  assert.ok(Either.isLeft(usl.compile("game.loop", [link, other])))
  assert.ok(Either.isLeft(usl.compose("game.loop", [plan, Either.getOrThrow(usl.compile("game.loop", [other]))])))
})

test("constructors and compiled plans are detached snapshots", () => {
  const roles = { spec: "filesystem", implementation: "filesystem" } as const
  const meaning = usl.meaning("review", { roles, description: "review" })
  ;(roles as { spec: string }).spec = "kg"
  assert.equal(meaning.definition.roles.spec, "filesystem")
  const plan = Either.getOrThrow(usl.compile("snapshots", [link]))
  assert.throws(() => { (plan.resources[0] as { name: string }).name = "changed" }, TypeError)
})

test("binding preserves generic functions and Effect composition", async () => {
  const identity = <A>(value: A): A => value
  const generic = usl.bind(identity, link)
  const text: string = generic.run("same function")
  const number: number = generic.run(3)
  assert.equal(text, "same function"); assert.equal(number, 3)
  assert.equal(generic.run, identity)
  let runs = 0
  const increment = usl.bind((n: number) => Effect.sync(() => { runs++; return n + 1 }), link)
  const program = Effect.succeed(4).pipe(Effect.flatMap(increment.run))
  assert.equal(runs, 0)
  assert.equal(await Effect.runPromise(program), 5)
  assert.equal(runs, 1)
})

test("source emission cannot attach a different plan digest merely because JSON fields compare structurally equal", () => {
  const plan = Either.getOrThrow(usl.compile("source.identity", [link]))
  const reordered = structuredClone(plan)
  const contract = reordered.meanings[0]!.contract!
  const check = contract.checks[0]!
  ;(contract.checks as unknown[])[0] = { description: check.description, name: check.name, evidenceRoles: check.evidenceRoles }
  assert.deepEqual(reordered, plan)
  assert.notEqual(planDigest(reordered), planDigest(plan))
  assert.ok(Either.isLeft(usl.source(reordered)))
  const normalized = Either.getOrThrow(usl.compose(plan.namespace, [reordered]))
  const source = Either.getOrThrow(usl.source(normalized))
  assert.equal(planDigest(Either.getOrThrow(compileSource(source))), planDigest(normalized))
  assert.notEqual(planDigest(reordered), planDigest(normalized)) // original snapshot stays intact
})
