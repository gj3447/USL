import { Effect, Either, pipe } from "effect"
import { fileURLToPath } from "node:url"
import { hostname } from "node:os"
import { usl as semantic, compactAgentContext, observeProgram, planDigest, Resolvers, resolveWith } from "../src/index.js"
import { canDash } from "./fixtures/game-workflow/dash-controller.js"

const local = (file: string) => `file://${hostname()}${fileURLToPath(new URL(file, import.meta.url))}` as const
const spec = semantic.resource("dash_spec", local("./fixtures/game-workflow/dash-spec.md"))
const implementation = semantic.resource("dash_code", local("./fixtures/game-workflow/dash-controller.ts"))
const evidence = semantic.resource("dash_test", local("./fixtures/game-workflow/dash-controller.test.ts"))
const rule = semantic.meaning("implements_dash_rule", {
  roles: { specification: "filesystem", implementation: "filesystem", evidence: "filesystem" },
  description: "구현은 명세의 지상 상태 전용 대시와 0.35초 쿨다운 규칙을 구현한다",
  contract: {
    scope: "플레이어 대시 능력의 지상 상태 판정과 쿨다운 동작",
    checks: [{ name: "dash_rule_test", evidenceRoles: ["evidence"], description: "dash-controller.test.ts의 지상 상태 및 쿨다운 검사를 확인한다" }],
  },
})

// A normal variable. The explicit link name, not this JS identifier, is its USL identity.
const usl = semantic.link("dash_behavior", rule, { specification: spec, implementation, evidence })
// Metadata can accompany a pure function, an Effect, or another value, without changing it.
const dash = semantic.bind(canDash, usl)
const ready = pipe({ grounded: true, cooldown: 0 }, (state) => dash.run(state.grounded, state.cooldown))
const plan = Either.getOrThrow(semantic.compile("example.game.dash.code", [dash.usl]))
const sourceText = Either.getOrThrow(semantic.source(plan))
const allowedLocators = [spec.locator, implementation.locator, evidence.locator]
const resolve = resolveWith({
  hostname: hostname(), gitRepos: {}, kgMcpUrl: "http://127.0.0.1:1/unused",
  timeoutMs: 1000, maxResponseBytes: 1024 * 1024,
  fetchImpl: async () => { throw new Error("This local example does not use network access") },
})
const report = await Effect.runPromise(observeProgram(plan, { links: [usl.name], allowedLocators, maxResources: 3, sourceText })
  .pipe(Effect.provideService(Resolvers, { resolve })))
const query = { focus: spec.name, target: implementation.name }
const context = Either.getOrThrow(compactAgentContext(plan, query))
const cached = Either.getOrThrow(compactAgentContext(plan, query, { knownContextDigest: context.contextDigest }))
console.log(JSON.stringify({ ready, planDigest: planDigest(plan), sourceDigest: report.sourceDigest,
  observationDigest: report.observationDigest, resolverCalls: report.metrics.resolverCalls,
  status: report.status, semanticTruth: report.semanticTruth, context: context.stats, cached: cached.stats }, null, 2))
