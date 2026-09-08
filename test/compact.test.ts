import { test } from "node:test"
import assert from "node:assert/strict"
import { Either } from "effect"
import { compileSource } from "../src/language/compiler.js"
import { compactAgentContext } from "../src/language/compact.js"
import { agentContext, type NavigationQuery } from "../src/language/navigation.js"

const source = `usl "0.1"; namespace "compact.test";
resource engine = "kg://canonical-neo4j/sym:Concept:engine";
resource repo = "git://example.test/org/repo";
resource spec = "https://example.test/specification";
resource checkout = "file://example-host/work/repo";
resource tests = "https://example.test/tests";
meaning implements(repository: git_repo, concept: kg, specification: url) = "repository implements the engine concept under the specification";
meaning checkout_of(local: filesystem, repository: git_repo, evidence: url) = "checkout belongs to repository with test evidence";
link implementation = implements(repository: repo, concept: engine, specification: spec);
link working_copy = checkout_of(local: checkout, repository: repo, evidence: tests);`
const plan = (text = source) => Either.getOrThrow(compileSource(text))
const query: NavigationQuery = { focus: "engine", target: "checkout", maxHops: 8, routes: [
  { meaning: "implements", enter: "concept", exit: "repository" },
  { meaning: "checkout_of", enter: "repository", exit: "local" },
] }
const compact = (input = plan(), q = query, options: any = {}) => Either.getOrThrow(compactAgentContext(input, q, options))
const bytes = (text: string) => Buffer.byteLength(text, "utf8")

const reconstructPaths = (wire: any, full: ReturnType<typeof agentContext> extends Either.Either<infer A, unknown> ? A : never) =>
  wire.paths.map((path: any) => {
    let at = full.focus
    return { resource: path.resource, steps: path.steps.map(([linkName, enteredRole, exitedRole]: [string, string, string]) => {
      const link = full.links.find((item) => item.name === linkName)!
      const to = link.participants.find((participant) => participant.role === exitedRole)!.resource
      const step = { link: linkName, meaning: link.meaning, from: at, enteredRole, to, exitedRole }
      at = to
      return step
    }) }
  })

test("FULL compact context preserves reconstructible paths, target, n-ary context, and route direction", () => {
  const expected = Either.getOrThrow(agentContext(plan(), query))
  const result = compact()
  assert.equal(result.mode, "FULL")
  assert.ok(result.text.endsWith("\n"))
  const wire = JSON.parse(result.text)
  assert.equal(wire.schema, "usl-agent-context-compact/v1")
  assert.equal(wire.mode, "FULL")
  assert.deepEqual(wire.pathStepFields, ["link", "enteredRole", "exitedRole"])
  assert.deepEqual(reconstructPaths(wire, expected), expected.paths)
  assert.deepEqual(wire.target, expected.target && { resource: expected.target.resource, status: expected.target.status })
  assert.equal(wire.links.find((link: any) => link.name === "implementation").participants.length, 3)
  assert.ok(wire.resources.some((resource: any) => resource.name === "spec" && resource.distance === null))
  const reverse = compact(plan(), { focus: "checkout", target: "engine", maxHops: 8 })
  const reverseWire = JSON.parse(reverse.text)
  assert.deepEqual(reconstructPaths(reverseWire, Either.getOrThrow(agentContext(plan(), { focus: "checkout", target: "engine", maxHops: 8 }))), Either.getOrThrow(agentContext(plan(), { focus: "checkout", target: "engine", maxHops: 8 })).paths)
})

test("cache returns the exact minimal unchanged envelope and invalidates for plan meaning or query changes", () => {
  const first = compact()
  const cached = compact(plan(), query, { knownContextDigest: first.contextDigest })
  assert.equal(cached.mode, "UNCHANGED")
  assert.equal(cached.text, `${JSON.stringify({ schema: "usl-agent-context-compact/v1", mode: "UNCHANGED", planDigest: Either.getOrThrow(agentContext(plan(), query)).planDigest, contextDigest: first.contextDigest })}\n`)
  assert.equal(compact(plan(source.replace("implements the engine", "does not implement the engine")), query, { knownContextDigest: first.contextDigest }).mode, "FULL")
  assert.equal(compact(plan(), { ...query, target: "spec" }, { knownContextDigest: first.contextDigest }).mode, "FULL")
})

test("byte and artificial token budgets include the newline and honor exact boundaries", () => {
  const expected = Either.getOrThrow(agentContext(plan(), query))
  const full = compact(plan(), query, { maxBytes: 100_000, tokenCounter: { id: "characters", count: (text: string) => text.length }, maxTokens: 100_000 })
  assert.equal(full.stats.baselineBytes, bytes(`${JSON.stringify(expected)}\n`))
  assert.equal(full.stats.deliveredBytes, bytes(full.text))
  assert.equal(full.stats.bytesSaved, full.stats.baselineBytes - full.stats.deliveredBytes)
  assert.deepEqual(full.stats.tokens, { counterId: "characters", baseline: JSON.stringify(expected).length + 1, delivered: full.text.length, saved: JSON.stringify(expected).length + 1 - full.text.length })
  assert.equal(compact(plan(), query, { maxBytes: full.stats.deliveredBytes }).text, full.text)
  assert.ok(Either.isLeft(compactAgentContext(plan(), query, { maxBytes: full.stats.deliveredBytes - 1 })))
  assert.equal(compact(plan(), query, { tokenCounter: { id: "characters", count: (text: string) => text.length }, maxTokens: full.stats.tokens!.delivered }).text, full.text)
  assert.ok(Either.isLeft(compactAgentContext(plan(), query, { tokenCounter: { id: "characters", count: (text: string) => text.length }, maxTokens: full.stats.tokens!.delivered - 1 })))
})

test("invalid compact options fail closed and output cannot mutate plan, query, or later output", () => {
  for (const options of [{ maxBytes: -1 }, { maxTokens: 1 }, { tokenCounter: { id: "", count: (text: string) => text.length }, maxTokens: 1 }, { tokenCounter: { id: "bad", count: 1 }, maxTokens: 1 }] as any[]) {
    assert.ok(Either.isLeft(compactAgentContext(plan(), query, options)), JSON.stringify(options))
  }
  const input = plan(), q = structuredClone(query)
  const beforePlan = JSON.stringify(input), beforeQuery = JSON.stringify(q)
  const first = compact(input, q)
  const wire = JSON.parse(first.text)
  wire.links[0].participants[0].resource = "forged"
  assert.equal(JSON.stringify(input), beforePlan)
  assert.equal(JSON.stringify(q), beforeQuery)
  assert.equal(compact(input, q).text, first.text)
})

test("compression lowers delivered bytes on a representative branching chain", () => {
  const graph = `usl "0.1"; namespace "compact.graph";
${Array.from({ length: 12 }, (_, i) => `resource r${i} = "https://example.test/resource-${i}-with-a-long-stable-name";`).join("\n")}
meaning related(left: url, right: url, context: url) = "a long contextual relation retained in every admitted assertion";
${Array.from({ length: 10 }, (_, i) => `link l${i} = related(left: r${i}, right: r${i + 1}, context: r${i + 2});`).join("\n")}`
  const result = compact(plan(graph), { focus: "r0", target: "r10", maxHops: 16 }, { maxBytes: 100_000 })
  assert.ok(result.stats.deliveredBytes < result.stats.baselineBytes, `${result.stats.deliveredBytes} >= ${result.stats.baselineBytes}`)
})
