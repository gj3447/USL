// Local integration demonstration. The imported draft graph is not an executed workflow.
import { readFile } from "node:fs/promises"
import { hostname } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Effect, Either } from "effect"
import {
  usl as semantic, compileSource, parseGraphEngineeringSource, toGraphEngineeringPlan,
  compactAgentContext, observeProgram, validateObservation, Resolvers, resolveWith,
  digestSource, planDigest, hswmDigest, prepareHswmAdapterArguments,
} from "../src/index.js"
import type { GraphNodeBinding, GraphEvidenceBinding, HswmObservationPolicyV2 } from "../src/index.js"

const local = (relative: string) => `file://${hostname()}${fileURLToPath(new URL(relative, import.meta.url))}`
export const runEngineeringWorkflow = async () => {
  const sourceText = await readFile(new URL("./fixtures/graph-engineering/graphspec.json", import.meta.url), "utf8")
  const source = Either.getOrThrow(parseGraphEngineeringSource(sourceText))
  const graph = Either.getOrThrow(toGraphEngineeringPlan(source, {
    source: { resource: "graphspec", locator: local("./fixtures/graph-engineering/graphspec.json"), text: sourceText },
    nodes: [
      { nodeId: "Seed", resource: "compiler_code", locator: local("../src/language/compiler.ts") },
      { nodeId: "Router", resource: "navigation_code", locator: local("../src/language/navigation.ts") },
    ] satisfies GraphNodeBinding[],
    evidence: [{ reference: "prov://graphspec-smoke/run-placeholder", resource: "example_receipt", locator: local("./fixtures/graph-engineering/validator-receipt.json") }] satisfies GraphEvidenceBinding[],
  }))
  const concept = semantic.resource("usl_concept", "kg://canonical-neo4j/sym:Concept:usl")
  const implementation = semantic.resource("compiler_code", `file://${hostname()}${fileURLToPath(new URL("../src/language/compiler.ts", import.meta.url))}`)
  const references = semantic.meaning("references_usl_implementation", {
    roles: { concept: "kg", implementation: "filesystem" },
    description: "USL 개념과 이 구현 모듈 사이의 참조를 선언한다",
  })
  const usl = semantic.link("compiler_reference", references, { concept, implementation })
  const compile = semantic.bind(compileSource, usl)
  const codePlan = Either.getOrThrow(semantic.compile("example.code", [compile.usl]))
  const plan = Either.getOrThrow(semantic.compose("example.engineering.integration", [codePlan, graph.usl]))
  const generatedSource = Either.getOrThrow(semantic.source(plan))
  // This exercises the original bound function, with no annotation wrapper around it.
  const recompiled = Either.getOrThrow(compile.run(generatedSource))
  if (planDigest(recompiled) !== planDigest(plan)) throw new Error("code binding did not preserve the generated plan")

  const links = graph.usl.links.map((link) => link.name)
  const selectedNames = new Set(graph.usl.links.flatMap((link) => link.participants.map((p) => p.resource)))
  const selected = graph.usl.resources.filter((r) => selectedNames.has(r.name))
  // An explicit local test policy. Expected bytes are read before observing, not copied from its report.
  // A production caller supplies its own trusted policy, resource pins and independent allowed_reads.
  const pins = await Promise.all(selected.map(async (resource) => {
    if (resource.locator.kind !== "filesystem") throw new Error("demo policy only permits local fixture files")
    const bytes = await readFile(resource.locator.path)
    return { name: resource.name, content_hash: digestSource(bytes.toString("utf8")).slice(7),
      resolved_locator: `file://${resource.locator.host}${resource.locator.path}` }
  }))
  if (links.length !== 2) throw new Error("demo policy expects exactly one structural edge and one evidence binding")
  const allowed_reads = [["graph_reference", "edge"], ["graph_reference", "evidence"]] as const
  const policy: HswmObservationPolicyV2 = {
    schema_version: "hswm-usl-observation-policy/v2", namespace: plan.namespace,
    plan_digest: hswmDigest(plan), usl_plan_digest: planDigest(plan), source_digest: digestSource(generatedSource),
    max_age_seconds: 60,
    bindings: links.map((link, index) => ({ link, role: allowed_reads[index]![0], field: allowed_reads[index]![1] })),
    resources: pins,
  }
  const allowedLocators = pins.map((pin) => pin.resolved_locator)
  const report = await Effect.runPromise(observeProgram(plan, { links, allowedLocators, maxResources: 4, sourceText: generatedSource })
    .pipe(Effect.provideService(Resolvers, { resolve: resolveWith({ hostname: hostname(), gitRepos: {},
      kgMcpUrl: "http://127.0.0.1:1/unused", allowedLocators,
      fetchImpl: async () => { throw new Error("local integration demo must not call external services") },
    }) })))
  Either.getOrThrow(validateObservation(report))
  const handoff = prepareHswmAdapterArguments({ plan, report, policy, allowed_reads, now: Date.now() / 1000, revision: "local-geip-example" })
  const query = { focus: concept.name, target: "example_receipt", maxHops: 4 }
  const context = Either.getOrThrow(compactAgentContext(plan, query, { maxBytes: 32768 }))
  const unchanged = Either.getOrThrow(compactAgentContext(plan, query, { maxBytes: 32768, knownContextDigest: context.contextDigest }))
  return { graph, plan, source: generatedSource, report, handoff, summary: {
    graphId: graph.graph.graphId, graphVersion: graph.graph.graphVersion,
    graphspecDigest: graph.graph.graphspecDigest, planDigest: report.planDigest, observationDigest: report.observationDigest,
    boundFunctionPreserved: compile.run === compileSource, selectedLinks: links,
    resolverCalls: report.metrics.resolverCalls, status: report.status, semanticTruth: report.semanticTruth,
    unboundNodes: graph.bindings.unboundNodeIds, geipExecution: graph.guarantees.execution,
    hswm: "ARGUMENTS_PREPARED_NOT_CONSUMED", context: context.stats, unchanged: unchanged.stats,
  } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify((await runEngineeringWorkflow()).summary, null, 2))
}
