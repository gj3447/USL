import { test } from "node:test"
import assert from "node:assert/strict"
import { Either } from "effect"
import { agentContext, compileSource, type NavigationQuery } from "../src/index.js"
import { planDigest } from "../src/language/digest.js"

const source = `usl "0.1"; namespace "test.navigation";
resource concept = "kg://canonical-neo4j/sym:Concept:engine";
resource repo = "git://example.test/org/repo";
resource checkout = "file://example-host/work/repo";
resource spec = "https://example.test/spec";
resource isolated = "https://example.test/isolated";
meaning implements(repository: git_repo, concept: kg, specification: url) = "저장소가 명시한 사양에 따라 개념을 구현한다";
meaning checkout_of(local: filesystem, repository: git_repo) = "경로는 저장소의 checkout이다";
link implementation = implements(repository: repo, concept: concept, specification: spec);
link working_copy = checkout_of(local: checkout, repository: repo);
`
const compile = (text = source) => Either.getOrThrowWith(compileSource(text), (e) => e)
const context = (query: NavigationQuery, plan = compile()) => Either.getOrThrowWith(agentContext(plan, query), (e) => e)

test("both ends traverse the same assertion with original roles and no invented inverse", () => {
  const forward = context({ focus: "repo", target: "concept" })
  const reverse = context({ focus: "concept", target: "repo" })
  assert.equal(forward.target?.status, "FOUND")
  assert.equal(reverse.target?.status, "FOUND")
  assert.deepEqual(forward.target?.path?.steps, [{ link: "implementation", meaning: "implements", from: "repo", enteredRole: "repository", to: "concept", exitedRole: "concept" }])
  assert.deepEqual(reverse.target?.path?.steps, [{ link: "implementation", meaning: "implements", from: "concept", enteredRole: "concept", to: "repo", exitedRole: "repository" }])
  assert.deepEqual(forward.links.find((l) => l.name === "implementation"), reverse.links.find((l) => l.name === "implementation"))
  assert.equal(forward.planDigest, reverse.planDigest)
  assert.equal(forward.planDigest, planDigest(compile()))
  assert.equal(reverse.interpretation.semanticTruth, "NOT_EVALUATED")
  assert.equal(reverse.interpretation.reachability, "NOT_OBSERVED")
  assert.equal(reverse.interpretation.execution, "NOT_PLANNED")
})

test("a multi-hop witness preserves the original n-ary claim and every participant", () => {
  const result = context({ focus: "concept", target: "checkout" })
  assert.deepEqual(result.target?.path?.steps.map((s) => [s.link, s.enteredRole, s.exitedRole]), [
    ["implementation", "concept", "repository"], ["working_copy", "repository", "local"],
  ])
  assert.equal(result.links.find((l) => l.name === "implementation")?.participants.length, 3)
  assert.ok(result.resources.some((r) => r.name === "spec"))
  assert.equal(result.meanings.find((m) => m.name === "implements")?.description, "저장소가 명시한 사양에 따라 개념을 구현한다")
  assert.equal(result.links.length, 2) // No new checkout-implements-concept assertion.
})

test("typed role routes constrain travel without deleting contextual participants", () => {
  const result = context({ focus: "concept", target: "spec", routes: [{ meaning: "implements", enter: "concept", exit: "repository" }] })
  assert.equal(result.resources.find((r) => r.name === "repo")?.distance, 1)
  assert.equal(result.resources.find((r) => r.name === "spec")?.distance, null)
  assert.equal(result.paths.some((p) => p.resource === "spec"), false)
  assert.equal(result.target?.status, "NOT_FOUND_IN_SCOPE")
  assert.equal(result.coverage.complete, true)
  assert.equal(result.links[0]?.participants.length, 3)
  assert.deepEqual(context({ focus: "concept", routes: [] }).links, [])
})

test("aliased roles and self links preserve all roles without duplicating or conflating resources", () => {
  const plan = compile(`usl "0.1"; namespace "alias";
    resource a = "https://example.test/same"; resource b = "https://example.test/same";
    meaning related(subject: any, context: any, evidence: any) = "関係";
    link relation = related(subject: a, context: a, evidence: b);
    link self = related(subject: a, context: a, evidence: a);`)
  const result = context({ focus: "a", target: "b", maxHops: 8 }, plan)
  assert.equal(result.resources.length, 2)
  assert.equal(result.paths.length, 2)
  assert.equal(result.links.length, 2)
  assert.deepEqual(result.links[0]?.participants.map((p) => p.role), ["subject", "context", "evidence"])
  assert.equal(result.target?.status, "FOUND")
  assert.equal(result.coverage.complete, true)
})

test("BFS terminates cycles and returns a deterministic shortest witness, not every walk", () => {
  const plan = compile(`usl "0.1"; namespace "cycles";
    resource a = "https://a.test"; resource b = "https://b.test"; resource c = "https://c.test";
    meaning related(left: url, right: url) = "関連";
    link ab = related(left: a, right: b); link bc = related(left: b, right: c); link ac = related(left: a, right: c);`)
  const query = { focus: "a", target: "c", maxHops: 32 }
  const result = context(query, plan)
  assert.deepEqual(result, context(query, plan))
  assert.equal(result.target?.path?.steps.length, 1)
  assert.equal(result.target?.path?.steps[0]?.link, "ac")
  assert.equal(result.paths.length, 3)
  assert.equal(result.links.length, 3)
  assert.equal(result.coverage.complete, true)
})

test("a hop limit distinguishes unknown beyond the boundary from scoped absence", () => {
  const partial = context({ focus: "concept", target: "checkout", maxHops: 1 })
  assert.equal(partial.target?.status, "NOT_FOUND_WITHIN_LIMITS")
  assert.deepEqual(partial.coverage.limitsReached, ["maxHops"])
  const complete = context({ focus: "concept", target: "isolated", maxHops: 10 })
  assert.equal(complete.target?.status, "NOT_FOUND_IN_SCOPE")
  assert.equal(complete.coverage.scope, "SUPPLIED_PLAN_AND_ROUTES")
  assert.equal(complete.coverage.complete, true)
  const zero = context({ focus: "concept", target: "concept", maxHops: 0 })
  assert.equal(zero.target?.status, "FOUND")
  assert.deepEqual(zero.target?.path?.steps, [])
  assert.equal(zero.resources.length, 1)
  assert.equal(zero.links.length, 0)
})

test("resource budget admits whole hyperedges or reports truncation without partial assertions", () => {
  const result = context({ focus: "concept", target: "repo", maxResources: 2 })
  assert.equal(result.links.length, 0)
  assert.equal(result.resources.length, 1)
  assert.equal(result.target?.status, "NOT_FOUND_WITHIN_LIMITS")
  assert.deepEqual(result.coverage.limitsReached, ["maxResources"])
})

test("link and incidence-visit budgets are bounded and do not hide truncation", () => {
  const links = context({ focus: "concept", target: "checkout", maxLinks: 1, maxHops: 10 })
  assert.equal(links.links.length, 1)
  assert.equal(links.target?.status, "NOT_FOUND_WITHIN_LIMITS")
  assert.deepEqual(links.coverage.limitsReached, ["maxLinks"])
  const visits = context({ focus: "concept", maxVisits: 1 })
  assert.equal(visits.coverage.visits, 1)
  assert.equal(visits.coverage.complete, false)
  assert.deepEqual(visits.coverage.limitsReached, ["maxVisits"])
})

test("invalid names, role routes and budgets fail instead of silently broadening the query", () => {
  const queries: NavigationQuery[] = [
    { focus: "missing" }, { focus: "concept", target: "missing" },
    ...[-1, 0.5, NaN, Infinity, 33, null].map((maxHops) => ({ focus: "concept", maxHops } as NavigationQuery)),
    { focus: "concept", maxResources: 0 }, { focus: "concept", maxLinks: 2001 }, { focus: "concept", maxVisits: 20001 },
    { focus: "concept", routes: [{ meaning: "missing", enter: "concept", exit: "repository" }] },
    { focus: "concept", routes: [{ meaning: "implements", enter: "concept", exit: "typo" }] },
    { focus: "concept", routes: [{ meaning: "implements", enter: "concept", exit: "concept" }] },
  ]
  for (const query of queries) assert.ok(Either.isLeft(agentContext(compile(), query)), JSON.stringify(query))
})

test("navigation neither mutates the supplied plan nor requires reachable external endpoints", () => {
  const plan = compile()
  const before = JSON.stringify(plan)
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  }
  freeze(plan)
  const result = context({ focus: "checkout", target: "concept" }, plan)
  assert.equal(result.target?.status, "FOUND")
  assert.equal(result.interpretation.reachability, "NOT_OBSERVED")
  assert.equal(JSON.stringify(plan), before)
  const revised = context({ focus: "concept" }, compile(source.replace("명시한 사양", "개정된 사양")))
  assert.notEqual(revised.planDigest, result.planDigest)
})

test("every emitted path is reconstructible from retained original roles and closed link context", () => {
  const plan = compile()
  for (const focus of plan.resources.map((r) => r.name)) for (const maxHops of [0, 1, 2, 5]) {
    const result = context({ focus, maxHops }, plan)
    const names = new Set(result.resources.map((r) => r.name))
    for (const link of result.links) for (const participant of link.participants) assert.ok(names.has(participant.resource))
    for (const path of result.paths) {
      let at = focus
      for (const step of path.steps) {
        assert.equal(step.from, at)
        const original = result.links.find((l) => l.name === step.link)!
        assert.ok(original.participants.some((p) => p.role === step.enteredRole && p.resource === step.from))
        assert.ok(original.participants.some((p) => p.role === step.exitedRole && p.resource === step.to))
        assert.equal(original.meaning, step.meaning)
        at = step.to
      }
      assert.equal(at, path.resource)
      assert.ok(path.steps.length <= maxHops)
    }
  }
})

test("annotating an agent context cannot mutate the source plan, query or later contexts", () => {
  const plan = compile()
  const query: NavigationQuery = { focus: "concept", routes: [{ meaning: "implements", enter: "concept", exit: "repository" }] }
  const beforePlan = JSON.stringify(plan), beforeQuery = JSON.stringify(query)
  const result = context(query, plan), beforeContext = JSON.stringify(result)
  ;(result.links[0]!.participants[0]! as { resource: string }).resource = "changed"
  ;(result.meanings[0]!.roles[0]! as { name: string }).name = "changed"
  ;(result.resources[0]!.locator as { uid: string }).uid = "changed"
  ;(result.routes![0]! as { exit: string }).exit = "changed"
  assert.equal(JSON.stringify(plan), beforePlan)
  assert.equal(JSON.stringify(query), beforeQuery)
  assert.equal(JSON.stringify(context(query, plan)), beforeContext)
})
