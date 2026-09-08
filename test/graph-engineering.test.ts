import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Effect, Either, Layer } from "effect"
import { formatLocator } from "../src/locator.js"
import { Resolvers } from "../src/resolve.js"
import { observeProgram, validateObservation } from "../src/language/index.js"
import { digestJson } from "../src/language/digest.js"
import { graphEngineeringDigest, parseGraphEngineeringSource, toGraphEngineeringPlan } from "../src/integrations/graph-engineering.js"

const graph = () => {
  const value: any = {
    apiVersion: "symposium.graphspec/v0alpha1", kind: "GraphSpec",
    metadata: { graph_id: "fixture.integration", graph_version: "0.1" },
    authority: { source_class: "SECONDARY_AI", status: "DESIGN_PROPOSAL", limitations: ["DOCUMENT_VALIDATION_ONLY"] },
    identity: { canonicalizer: "jcs-like-json-v1;graphspec_sha256-omitted" },
    topology: { nodes: [{ id: "Seed" }, { id: "Check" }, { id: "Unbound" }], edges: [{ id: "data", source: "Seed", target: "Check", kind: "data", data_contract_ref: "schema://check", semantic_relation: null }, { id: "later", source: "Check", target: "Unbound", kind: "control", data_contract_ref: null, semantic_relation: null }] },
    lifecycle: { profile: "fixture", machine_sha256: "" }, loop: {}, effects: {},
    evidence: { cloudevents: { mapping_ref: "schema://event" }, prov_o: { bundle_ref: "prov://fixture/run" }, otel: { trace_ref: "otel://fixture/trace" } },
  }
  sign(value)
  return value
}
const source = (value: unknown) => JSON.stringify(value)
const sign = (value: any) => {
  value.identity.topology_sha256 = graphEngineeringDigest(value.topology ?? {})
  const machine = structuredClone(value.lifecycle); delete machine.machine_sha256
  value.lifecycle.machine_sha256 = graphEngineeringDigest(machine)
  value.identity.lifecycle_sha256 = graphEngineeringDigest(value.lifecycle ?? {})
  value.identity.loop_policy_sha256 = graphEngineeringDigest(value.loop ?? {})
  value.identity.effect_policy_sha256 = graphEngineeringDigest(value.effects ?? {})
  const graphCandidate = structuredClone(value); delete graphCandidate.identity.graphspec_sha256
  value.identity.graphspec_sha256 = graphEngineeringDigest(graphCandidate)
}

test("GraphSpec bindings preserve authority, exact source identity, topology and only emit explicitly bound edges", async () => {
  const input = graph(), parsed = Either.getOrThrow(parseGraphEngineeringSource(input))
  const imported = Either.getOrThrow(toGraphEngineeringPlan(parsed, {
    source: { resource: "graphspec", locator: "file://fixture/graphspec.json", text: source(input) },
    nodes: [{ nodeId: "Seed", resource: "seed", locator: "https://fixture.test/seed" }, { nodeId: "Check", resource: "check", locator: "https://fixture.test/check" }],
    evidence: [{ reference: "prov://fixture/run", resource: "receipt", locator: "https://fixture.test/receipt" }],
  }))
  assert.equal(imported.graph.graphId, "fixture.integration")
  assert.deepEqual(imported.graph.authority, input.authority)
  assert.equal(imported.graph.graphspecDigest, input.identity.graphspec_sha256)
  assert.equal(imported.usl.links.length, 2) // one bound edge + explicit receipt reference
  const edgeMeaning = imported.usl.meanings.find((meaning) => /geip_edge_meaning/.test(meaning.name))!
  assert.match(edgeMeaning.description, /"kind":"data"/)
  assert.match(edgeMeaning.contract!.scope, new RegExp(input.identity.graphspec_sha256))
  assert.deepEqual(imported.bindings.unboundNodeIds, ["Unbound"])
  assert.deepEqual(imported.bindings.unboundEdgeIds, ["later"])
  assert.equal(imported.guarantees.execution, "NOT_EXECUTED")
  const report = await Effect.runPromise(observeProgram(imported.usl).pipe(Effect.provide(Layer.succeed(Resolvers, { resolve: (locator) => Effect.succeed({ locator, resolvedLocator: formatLocator(locator), contentHash: "fixture", resolvedAt: "2026-09-08T00:00:00.000Z", guaranteeLevel: "pure" as const, matchCount: 1 }) }))))
  assert.equal(report.semanticTruth, "NOT_EVALUATED")
  assert.ok(Either.isRight(validateObservation(report)))
})

test("digest or exact source mismatches are rejected before a usable USL plan exists", () => {
  const input = graph(), broken = structuredClone(input)
  broken.topology.nodes.push({ id: "Changed" })
  assert.ok(Either.isLeft(parseGraphEngineeringSource(broken)))
  const parsed = Either.getOrThrow(parseGraphEngineeringSource(input))
  assert.ok(Either.isLeft(toGraphEngineeringPlan(parsed, { source: { resource: "graphspec", locator: "file://fixture/graphspec.json", text: source(broken) } })))
})

test("rejects stale component hashes and forged snapshots even when the outer hash is refreshed", () => {
  const stale = graph()
  stale.topology.edges[0].semantic_relation = "reversed"
  const staleCandidate = structuredClone(stale); delete staleCandidate.identity.graphspec_sha256
  stale.identity.graphspec_sha256 = graphEngineeringDigest(staleCandidate)
  assert.ok(Either.isLeft(parseGraphEngineeringSource(stale)))

  const input = graph(), parsed = Either.getOrThrow(parseGraphEngineeringSource(input)) as any
  parsed.topology.edges[0].semantic_relation = "forged"
  assert.ok(Either.isLeft(toGraphEngineeringPlan(parsed, { source: { resource: "graphspec", locator: "file://fixture/graphspec.json", text: source(input) } })))
})

test("semantic edge changes with valid GEIP hashes change the compiled USL meanings digest", () => {
  const first = graph(), second = structuredClone(first)
  second.topology.edges[0].semantic_relation = "reversed"
  sign(second)
  const bindings = { source: { resource: "graphspec", locator: "file://fixture/graphspec.json", text: source(first) } }
  const a = Either.getOrThrow(toGraphEngineeringPlan(Either.getOrThrow(parseGraphEngineeringSource(first)), bindings))
  const b = Either.getOrThrow(toGraphEngineeringPlan(Either.getOrThrow(parseGraphEngineeringSource(second)), { source: { ...bindings.source, text: source(second) } }))
  assert.notEqual(digestJson(a.usl.meanings), digestJson(b.usl.meanings))
})

test("copied GraphSpec matches the pinned source-file digest and remains parseable", async () => {
  const graphPath = fileURLToPath(new URL("../examples/fixtures/graph-engineering/graphspec.json", import.meta.url))
  const receiptPath = fileURLToPath(new URL("../examples/fixtures/graph-engineering/validator-receipt.json", import.meta.url))
  const [graphText, receiptText] = await Promise.all([readFile(graphPath, "utf8"), readFile(receiptPath, "utf8")])
  const actual = createHash("sha256").update(graphText).digest("hex")
  const receipt = JSON.parse(receiptText)
  assert.equal(actual, receipt.subject.graphspec_sha256)
  const parsed = Either.getOrThrow(parseGraphEngineeringSource(graphText))
  const imported = Either.getOrThrow(toGraphEngineeringPlan(parsed, {
    source: { resource: "graphspec", locator: "file://fixture/graphspec.json", text: graphText },
    nodes: [{ nodeId: "Seed", resource: "seed", locator: "file://fixture/seed.ts" }, { nodeId: "Router", resource: "router", locator: "file://fixture/router.ts" }],
    evidence: [{ reference: "prov://graphspec-smoke/run-placeholder", resource: "receipt", locator: "file://fixture/validator-receipt.json" }],
  }))
  assert.equal(imported.usl.links.length, 2)
  assert.ok(Either.isLeft(parseGraphEngineeringSource(JSON.parse(graphText))), "object input must reject erased float lexemes")
})

test("raw integer, float and exponent spellings match independent Python canonical hash vectors", async () => {
  const raw = await readFile(new URL("../examples/fixtures/graph-engineering/graphspec.json", import.meta.url), "utf8")
  const vectors = JSON.parse(await readFile(new URL("../examples/fixtures/graph-engineering/numeric-vectors.json", import.meta.url), "utf8"))
  assert.equal(createHash("sha256").update(raw).digest("hex"), vectors.fixture_sha256)
  const original = JSON.parse(raw)
  for (const entry of vectors.cases) {
    const changed = raw.replace(/("max_cost"\s*:\s*)20\.0/, `$1${entry.raw}`)
      .replace(original.identity.loop_policy_sha256, entry.loop_digest)
      .replace(original.identity.graphspec_sha256, entry.graph_digest)
    const parsed = parseGraphEngineeringSource(changed)
    assert.ok(Either.isRight(parsed), Either.isLeft(parsed) ? parsed.left.message : entry.raw)
    assert.equal(parsed.right.graphspecDigest, entry.graph_digest)
  }
})

test("object-based imports cannot attach raw source with incompatible integer/float identity", () => {
  const input = graph()
  input.loop = { budgets: { max_cost: 20 } }
  sign(input)
  const parsed = Either.getOrThrow(parseGraphEngineeringSource(input))
  const wrongText = source(input).replace('"max_cost":20', '"max_cost":20.0')
  assert.deepEqual(JSON.parse(wrongText), input)
  const result = toGraphEngineeringPlan(parsed, { source: { resource: "graphspec", locator: "file://fixture/graphspec.json", text: wrongText } })
  assert.ok(Either.isLeft(result))
})

test("edge identifiers remain stable when a graph lists the same edges in a different order", () => {
  const first = graph(), second = structuredClone(first)
  second.topology.edges.reverse(); sign(second)
  const bind = (value: unknown) => Either.getOrThrow(toGraphEngineeringPlan(Either.getOrThrow(parseGraphEngineeringSource(value)), {
    source: { resource: "graphspec", locator: "file://fixture/graphspec.json", text: source(value) },
    nodes: [{ nodeId: "Seed", resource: "seed", locator: "https://fixture.test/seed" }, { nodeId: "Check", resource: "check", locator: "https://fixture.test/check" }],
  })).usl
  assert.deepEqual(bind(first).links.map((l) => l.name).sort(), bind(second).links.map((l) => l.name).sort())
})
