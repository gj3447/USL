import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { Either } from "effect"
import { checkResourceGraphProfile, parseDomainProfile } from "../src/domain-profile.js"
import { adaptResourceGraph, parseResourceGraph, resourceGraphJsonLd, type ResourceGraph } from "../src/integrations/resource-graph.js"
import { agentContext } from "../src/language/navigation.js"
import { fileConnectionResolver, readMcpConfig } from "../src/mcp-config.js"

const BASE = join("connections", "omc-internet")
const paths = { graph: join(BASE, "graph.json"), profile: join(BASE, "profile.json"), request: join(BASE, "request.json"), connection: join(BASE, "connection.json") }
const namespace = "omc.internet.design.v1"
const system = "sym:Character:입체운행구름", requestSource = "omc:source:internet-request", mobilitySource = "omc:source:mobility-request"
const requirement = "omc:requirement:web", work = "omc:work:web", httpEvidence = "omc:evidence:http"

const digest = (text: string | Buffer) => `sha256:${createHash("sha256").update(text).digest("hex")}`
const record = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return Object.fromEntries(Object.entries(value))
}
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const array = (value: unknown, label: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}
const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a nonempty string`)
  return value
}
const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"))
const graphFixture = async (): Promise<{ raw: string; graph: ResourceGraph; profile: ReturnType<typeof parseDomainProfile> }> => {
  const raw = await readFile(paths.graph, "utf8")
  return { raw, graph: Either.getOrThrowWith(parseResourceGraph(raw), error => error), profile: parseDomainProfile(await json(paths.profile)) }
}
const edges = (graph: ResourceGraph, name: string) => graph.links.filter(link => link.meaning === name)
const participant = (link: ResourceGraph["links"][number], role: string) => link.participants.find(value => value.role === role)?.resource
const linkIsAcyclic = (graph: ResourceGraph) => {
  const dependencies = new Map<string, readonly string[]>(edges(graph, "dependsOn").map(link => [participant(link, "work")!, [participant(link, "prerequisite")!]]))
  const active = new Set<string>(), complete = new Set<string>()
  const visit = (id: string): boolean => {
    if (active.has(id)) return false
    if (complete.has(id)) return true
    active.add(id)
    const valid = (dependencies.get(id) ?? []).every(visit)
    active.delete(id)
    if (valid) complete.add(id)
    return valid
  }
  return [...dependencies.keys()].every(visit)
}

test("OMC01: design graph answers the bounded HTTP and planned-work competency questions without asserting a live OMC endpoint", async () => {
  const { graph, raw, profile } = await graphFixture()
  const adapted = Either.getOrThrowWith(adaptResourceGraph(raw, { namespace, profile }), error => error)
  assert.equal(checkResourceGraphProfile(graph, profile).semanticTruth, "NOT_EVALUATED")
  const interprets = edges(graph, "interprets")
  assert.ok(interprets.some(link => participant(link, "source") === requestSource && participant(link, "requirement") === requirement && participant(link, "subject") === system))
  assert.ok(interprets.some(link => participant(link, "source") === mobilitySource && participant(link, "subject") === system))
  assert.ok(edges(graph, "addresses").some(link => participant(link, "work") === work && participant(link, "requirement") === requirement))
  assert.ok(edges(graph, "groundedIn").some(link => participant(link, "work") === work && participant(link, "evidence") === httpEvidence))
  const dependency = (item: string, prerequisite: string) => edges(graph, "dependsOn").some(link => participant(link, "work") === item && participant(link, "prerequisite") === prerequisite)
  assert.ok(dependency("omc:work:web", "omc:work:identity"))
  assert.ok(dependency("omc:work:actions", "omc:work:web"))
  assert.ok(dependency("omc:work:feedback", "omc:work:web"))
  assert.ok(dependency("omc:work:mobility", "omc:work:identity"))
  assert.ok(linkIsAcyclic(graph), "dependsOn work subgraph must be acyclic")
  const required = ["internal", "web", "actions", "feedback", "mobility"].map(id => `omc:requirement:${id}`)
  for (const id of required) assert.ok(edges(graph, "addresses").some(link => participant(link, "requirement") === id), `${id} has no planned work`)
  for (const link of graph.links) {
    assert.equal(link.metadata?.authorityClass, "SECONDARY_AI")
    assert.equal(link.metadata?.status, "PROPOSED")
  }
  const evidence = graph.resources.find(resource => resource.id === httpEvidence)
  assert.ok(evidence)
  assert.notEqual(evidence.metadata?.truth, "TRUE")
  assert.notEqual(evidence.metadata?.runtimeStatus, "CONNECTED")
  assert.equal(graph.resources.find(resource => resource.id === work)?.metadata?.runtimeStatus, "NOT_DEPLOYED_BY_THIS_PLAN")
  const nativeContext = Either.getOrThrowWith(agentContext(adapted.plan, { focus: adapted.identities.resources[system]!, target: adapted.identities.resources[httpEvidence]!, maxHops: 3 }), error => error)
  assert.equal(nativeContext.target?.status, "FOUND")
})

test("OMC02: request quotations retain their USER_PRIMARY bytes and graph source pins under the reused stable IDs", async () => {
  const { graph } = await graphFixture()
  const requestBytes = await readFile(paths.request), request = record(JSON.parse(requestBytes.toString("utf8")), "request")
  assert.equal(request.schema, "usl-omc-internet-request/v1")
  assert.equal(request.publication, "LOCAL_ONLY")
  const sources = array(request.sources, "request.sources")
  for (const [index, value] of sources.entries()) {
    const source = record(value, "request source"), id = text(source.id, "source.id"), quote = text(source.text, "source.text")
    assert.equal(source.authorityClass, "USER_PRIMARY")
    assert.equal(source.origin, "conversation")
    assert.equal(source.utteredAt, null)
    assert.equal(source.textDigest, digest(quote))
    const graphSource = graph.resources.find(resource => resource.id === id)
    assert.ok(graphSource, `request source ${id} is missing from graph`)
    assert.equal(graphSource.metadata?.textDigest, source.textDigest)
    assert.equal(graphSource.metadata?.documentDigest, digest(requestBytes))
    assert.equal(graphSource.metadata?.jsonPointer, `/sources/${index}`)
    assert.equal(graphSource.metadata?.selectorStatus, "OWNER_READ_REQUIRED")
    assert.equal(record(value, `request source at ${index}`).id, id)
  }
  assert.deepEqual(sources.map(value => text(record(value, "request source").id, "source.id")).sort(), [requestSource, mobilitySource].sort())
})

test("OMC03: the closed profile rejects a role reversal and promotion of a proposed requirement", async () => {
  const { graph, profile } = await graphFixture()
  const relation = graph.links.find(link => link.meaning === "interprets" && participant(link, "requirement") === requirement)
  assert.ok(relation)
  const swapped: ResourceGraph = { ...graph, links: graph.links.map(link => link.id !== relation.id ? link : {
    ...link, participants: link.participants.map(entry => entry.role === "source" ? { ...entry, resource: requirement } : entry.role === "requirement" ? { ...entry, resource: requestSource } : entry),
  }) }
  assert.ok(Either.isLeft(adaptResourceGraph(JSON.stringify(swapped), { namespace, profile })))
  const promoted: ResourceGraph = { ...graph, resources: graph.resources.map(resource => resource.id !== requirement ? resource : {
    ...resource, metadata: { ...resource.metadata, authorityClass: "USER_PRIMARY" },
  }) }
  assert.ok(Either.isLeft(adaptResourceGraph(JSON.stringify(promoted), { namespace, profile })))
  const deployed: ResourceGraph = { ...graph, resources: graph.resources.map(resource => resource.id !== work ? resource : {
    ...resource, metadata: { ...resource.metadata, runtimeStatus: "DEPLOYED" },
  }) }
  assert.ok(Either.isLeft(adaptResourceGraph(JSON.stringify(deployed), { namespace, profile })))
})

test("OMC04: JSON-LD exchange preserves declared native IDs and provenance without transforming this local design into an endpoint claim", async () => {
  const { raw, graph, profile } = await graphFixture()
  const document = Either.getOrThrowWith(resourceGraphJsonLd(raw, { namespace, profile }), error => error)
  const root = record(document, "JSON-LD document"), nodes = array(root["@graph"], "JSON-LD graph")
  const native = new Set(nodes.flatMap(value => {
    return isRecord(value) && typeof value["usl:nativeId"] === "string" ? [value["usl:nativeId"]] : []
  }))
  for (const resource of graph.resources) assert.ok(native.has(resource.id))
  for (const link of graph.links) assert.ok(native.has(link.id))
  assert.ok(nodes.some(value => value !== null && typeof value === "object" && !Array.isArray(value) && record(value, "JSON-LD node")["@type"] === "prov:Entity"))
  const sourceIds = [requestSource, mobilitySource].map(id => `urn:usl:${encodeURIComponent(namespace)}:resource:${encodeURIComponent(id)}`)
  for (const link of graph.links) {
    const node = nodes.find(value => isRecord(value) && value["usl:nativeId"] === link.id)
    assert.ok(node && isRecord(node), `missing JSON-LD link node: ${link.id}`)
    assert.equal(node["usl:status"], "DECLARED")
    const derived = array(node["prov:wasDerivedFrom"], `link provenance ${link.id}`).flatMap(value => isRecord(value) && typeof value["@id"] === "string" ? [value["@id"]] : [])
    for (const sourceId of sourceIds) assert.ok(derived.includes(sourceId), `link ${link.id} lacks declared source provenance`)
  }
})

test("OMC05: configured connection is local metadata with a fixed ID and deny-all locator policy", async () => {
  const parsed = await readMcpConfig(paths.connection, {})
  assert.deepEqual(parsed.policy.allowedLocators, [])
  assert.equal(parsed.policy.maxResources, 64)
  assert.equal(parsed.policy.maxInputBytes, 1024 * 1024)
  assert.equal(parsed.policy.maxOutputBytes, 1024 * 1024)
  const resolver = fileConnectionResolver(parsed.connections ?? {}, parsed.policy.maxInputBytes)
  const registered = await resolver("omc-internet-design-v1")
  const { raw, profile } = await graphFixture()
  const expected = Either.getOrThrowWith(adaptResourceGraph(raw, { namespace, profile }), error => error)
  assert.equal(registered.source.digest, expected.source.digest)
  await assert.rejects(resolver("unknown-connection"), /unknown connection/)
  const connection = record(await json(paths.connection), "connection")
  assert.deepEqual(connection.allowedLocators, [])
  assert.equal(connection.maxResources, 64)
  assert.equal(connection.maxInputBytes, 1024 * 1024)
  assert.equal(connection.maxOutputBytes, 1024 * 1024)
  const connections = record(connection.connections, "connection.connections")
  const configured = record(connections["omc-internet-design-v1"], "configured connection")
  assert.deepEqual(connection.allowedLocators, [])
  assert.equal(configured.graph, "graph.json")
  assert.equal(configured.profile, "profile.json")
  assert.equal(configured.namespace, namespace)
  assert.equal(configured.format, "resource-graph")
  for (const key of ["graph", "profile"] as const) {
    const value = text(configured[key], `connection.${key}`)
    assert.ok(!value.startsWith("/") && !value.includes("..") && !value.includes(":"), `connection.${key} must be a relative metadata path`)
  }
})
