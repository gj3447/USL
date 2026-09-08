import { Either } from "effect"
import { compileSource } from "../src/language/compiler.js"
import { compactAgentContext } from "../src/language/compact.js"
import { agentContext } from "../src/language/navigation.js"

const source = `usl "0.1"; namespace "audit.context";
resource a = "https://a.test"; resource b = "https://b.test";
meaning related(left: url, right: url) = "a declared relationship";
link ab = related(left: a, right: b);`
const plan = Either.getOrThrow(compileSource(source))
const forward = [{ meaning: "related", enter: "left", exit: "right" }]
const reverse = [{ meaning: "related", enter: "right", exit: "left" }]

const routeSwitch: { focus: string; target: string; readonly routes: typeof forward } = {
  focus: "a", target: "b",
  get routes() {
    // Calls 1--3 validate the reverse-only query. Calls 4--5 authorize a traversal;
    // the remaining reads again claim that the route was reverse-only.
    routeReads++
    return routeReads === 4 || routeReads === 5 ? forward : reverse
  },
}
let routeReads = 0
const switched = Either.getOrThrow(agentContext(plan, routeSwitch))

let focusReads = 0
const focusSwitch: { readonly focus: string; target: string } = {
  get focus() {
    // Validation and traversal use a; the final report read is changed to b.
    focusReads++
    return focusReads === 7 ? "b" : "a"
  },
  target: "b",
}
const switchedFocus = Either.getOrThrow(agentContext(plan, focusSwitch))

const first = Either.getOrThrow(compactAgentContext(plan, { focus: "a", target: "b" }, { maxBytes: 100_000 }))
const cache = Either.getOrThrow(compactAgentContext(plan, { focus: "a", target: "b" }, { maxBytes: 100_000, knownContextDigest: first.contextDigest }))
const tokenFailure = compactAgentContext(plan, { focus: "a", target: "b" }, {
  maxBytes: 100_000, maxTokens: 1,
  tokenCounter: { id: "probe", count: () => 2 },
})

const largeSource = `usl "0.1"; namespace "audit.large";
resource focus = "https://focus.test"; resource other = "https://other.test";
meaning rel(left: url, right: url) = "r";
${Array.from({ length: 5_000 }, (_, i) => `link l${i} = rel(left: focus, right: other);`).join("\n")}`
const largePlan = Either.getOrThrow(compileSource(largeSource))
const start = process.hrtime.bigint()
const bounded = Either.getOrThrow(agentContext(largePlan, { focus: "focus", maxVisits: 1, maxLinks: 1, maxResources: 2 }))
const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000

const result = {
  routeSwitch: {
    routeReads,
    emittedRoutes: switched.routes,
    path: switched.target?.path,
    disallowedByEmittedRoute: switched.target?.path?.steps[0]?.enteredRole === "left" && switched.routes?.[0]?.enter === "right",
  },
  focusSwitch: {
    focusReads,
    emittedFocus: switchedFocus.focus,
    zeroStepPathResource: switchedFocus.paths[0]?.resource,
    targetPath: switchedFocus.target?.path,
    inconsistent: switchedFocus.focus !== switchedFocus.paths[0]?.resource,
  },
  compact: {
    cacheMode: cache.mode,
    unchangedBytes: cache.stats.deliveredBytes,
    tokenBudgetRejected: Either.isLeft(tokenFailure) && tokenFailure.left.reason === "BUDGET_EXCEEDED",
  },
  traversalLimit: {
    linksInPlan: largePlan.links.length,
    reportedVisits: bounded.coverage.visits,
    limitsReached: bounded.coverage.limitsReached,
    elapsedMs: Number(elapsedMs.toFixed(2)),
  },
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
