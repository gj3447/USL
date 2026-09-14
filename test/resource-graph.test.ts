import { test } from "node:test"
import assert from "node:assert/strict"
import { Effect, Either } from "effect"
import { adaptResourceGraph, resourceGraphJsonLd, type ResourceGraph } from "../src/integrations/resource-graph.js"
import { connectUsl } from "../src/adapters.js"
import { planDigest, digestSource } from "../src/language/digest.js"
import { agentContext } from "../src/language/navigation.js"

export const graphFixture = (): ResourceGraph => ({ schema: "usl-resource-graph/v1",
  resources: ["a", "b", "c", "d", "isolated"].map((id, index) => ({ id, locator: `file://fixture/${id}`,
    types: [["urn:example:Code", "urn:example:Requirement", "urn:example:LeanTheorem", "urn:example:Run", "urn:example:Dataset"][index]!] })),
  meanings: [{ id: "implements", description: "Implementation corresponds to specification." },
    { id: "supports", description: "Proof and evidence support the subject." }, { id: "references", description: "Source references target." }],
  links: [
    { id: "ab", meaning: "implements", participants: [{ role: "implementation", resource: "a" }, { role: "specification", resource: "b" }] },
    { id: "bcd", meaning: "supports", participants: [{ role: "subject", resource: "b" }, { role: "proof", resource: "c" }, { role: "evidence", resource: "d" }] },
    { id: "ca", meaning: "references", participants: [{ role: "source", resource: "c" }, { role: "target", resource: "a" }] },
  ],
})
const adapt = (graph = graphFixture()) => Either.getOrThrow(adaptResourceGraph(JSON.stringify(graph), { namespace: "test.resources" }))

test("open domain types retain IDs, n-ary roles and isolated resources without new read transports", () => {
  const graph = adapt()
  const result = Either.getOrThrow(agentContext(graph.plan, { focus: graph.identities.resources.d!, target: graph.identities.resources.a! }))
  assert.equal(result.target?.status, "FOUND")
  assert.equal(result.interpretation.semanticTruth, "NOT_EVALUATED")
  assert.equal(result.links.find(link => link.name === graph.identities.links.bcd)?.participants.length, 3)
  const isolated = Either.getOrThrow(agentContext(graph.plan, { focus: graph.identities.resources.isolated!, target: graph.identities.resources.a! }))
  assert.notEqual(isolated.target?.status, "FOUND", "descriptors must not invent connections")
})

test("array order does not alter named-role semantics, while domain metadata and role bindings do", () => {
  const base = graphFixture(), reordered = structuredClone(base)
  reordered.resources.reverse(); reordered.links.reverse(); reordered.meanings.reverse()
  reordered.links.forEach(link => link.participants.reverse())
  assert.equal(planDigest(adapt(base).plan), planDigest(adapt(reordered).plan))
  assert.notEqual(adapt(base).source.digest, adapt(reordered).source.digest)
  const typeChange = structuredClone(base); typeChange.resources[0]!.types = ["urn:example:Other"]
  assert.notEqual(planDigest(adapt(base).plan), planDigest(adapt(typeChange).plan))
  const roleChange = structuredClone(base); roleChange.links[0]!.participants.reverse()
  roleChange.links[0]!.participants[0]!.resource = "a"; roleChange.links[0]!.participants[1]!.resource = "b"
  assert.notEqual(planDigest(adapt(base).plan), planDigest(adapt(roleChange).plan))
})

test("dangling roles, duplicate IDs, unknown meanings, invalid domain types and unsupported locators fail", () => {
  const mutations: Array<(graph: ResourceGraph) => void> = [
    graph => { graph.resources.push(graph.resources[0]!) },
    graph => { graph.links[0]!.participants[0]!.resource = "missing" },
    graph => { graph.links[0]!.participants[1]!.role = "implementation" },
    graph => { graph.links[0]!.meaning = "missing" },
    graph => { graph.resources[0]!.types = ["Code"] },
    graph => { graph.resources[0]!.types = ["urn:invalid:<type>"] },
    graph => { graph.resources[0]!.types = ["urn:invalid:%ZZ"] },
    graph => { graph.resources[0]!.locator = "sql://arbitrary-server/table" },
    graph => { graph.provenance = { sources: ["missing"] } },
  ]
  for (const mutate of mutations) {
    const graph = graphFixture(); mutate(graph)
    assert.ok(Either.isLeft(adaptResourceGraph(JSON.stringify(graph), { namespace: "test" })))
  }
})

test("resource adapter runs through existing connections with deny-all and exact source identity", async () => {
  const raw = JSON.stringify(graphFixture())
  const connection = connectUsl({ read: () => Effect.succeed(raw), adapt: source => adaptResourceGraph(source, { namespace: "test" }) })
  const result = await Effect.runPromise(connection.observe(undefined))
  assert.equal(result.receipt.sourceDigest, digestSource(raw))
  assert.equal(result.result.sourceDigest, null)
  assert.equal(result.result.metrics.resolverCalls, 0)
})

test("JSON-LD exports named link declarations, participant roles and PROV source identities", () => {
  const result: any = Either.getOrThrow(resourceGraphJsonLd(JSON.stringify(graphFixture()), { namespace: "test" }))
  const link = result["@graph"].find((node: any) => node["usl:nativeId"] === "bcd")
  assert.equal(link["usl:participant"].length, 3)
  assert.equal(link["usl:status"], "DECLARED")
  assert.match(link["prov:wasDerivedFrom"][0]["@id"], /^urn:usl:source:/)
  assert.equal(result["@graph"].filter((node: any) => node["@type"].includes("usl:Resource")).length, 5)
})
