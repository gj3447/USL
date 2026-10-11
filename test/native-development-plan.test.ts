import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { Either } from "effect"
import { checkResourceGraphProfile, parseDomainProfile } from "../src/domain-profile.js"
import { bindResourceGraph } from "../src/integrations/resource-bindings.js"
import { adaptResourceGraph, parseResourceGraph, type ResourceGraph } from "../src/integrations/resource-graph.js"
import { fileConnectionResolver, readMcpConfig } from "../src/mcp-config.js"
import { inspectResourceBinding } from "../src/binding-inspection.js"
import type { AdaptedGraph } from "../src/adapters.js"
import { agentContext } from "../src/language/navigation.js"
import { parseResourceBindings } from "../src/resource-bindings.js"

const BASE = join("research", "native-development")
const paths = {
  graph: join(BASE, "graph.json"), profile: join(BASE, "profile.json"), bindings: join(BASE, "bindings.json"),
  selections: join(BASE, "selections.json"), host: join(BASE, "host.json"), connection: join("connections", "native-development", "connection.json"),
}
const namespace = "usl.native.development"
const type = (name: string) => `urn:usl:native-development:${name}`

const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"))
const graphFixture = async () => {
  const raw = await readFile(paths.graph, "utf8")
  const graph = Either.getOrThrowWith(parseResourceGraph(raw), error => error)
  const profile = parseDomainProfile(await json(paths.profile))
  return { raw, graph, profile }
}
const bindingFixture = async () => ({
  bindings: parseResourceBindings(await json(paths.bindings)),
  selections: await json(paths.selections) as readonly { resource: string; representation: string }[],
})
const edges = (graph: ResourceGraph, meaning: string) => graph.links.filter(link => link.meaning === meaning)
const role = (link: ResourceGraph["links"][number], name: string) => link.participants.find(participant => participant.role === name)?.resource
const resource = (graph: ResourceGraph, id: string) => {
  const found = graph.resources.find(candidate => candidate.id === id)
  assert.ok(found, `missing resource ${id}`)
  return found
}
const has = (graph: ResourceGraph, meaning: string, roles: Readonly<Record<string, string>>) => edges(graph, meaning).some(link => Object.entries(roles).every(([name, id]) => role(link, name) === id))
const witness = (graph: ResourceGraph, adapted: AdaptedGraph, meaning: string, participants: Readonly<Record<string, string>>) => {
  const edge = edges(graph, meaning).find(link => Object.entries(participants).every(([name, id]) => role(link, name) === id))
  assert.ok(edge, `missing ${meaning} witness: ${JSON.stringify(participants)}`)
  const name = adapted.identities.links[edge.id]
  assert.ok(name, `missing compiled identity for ${edge.id}`)
  const link = adapted.plan.links.find(candidate => candidate.name === name)
  assert.ok(link, `missing compiled link ${name}`)
  return { edge, name, meaning: link.meaning }
}
const compiledResource = (adapted: AdaptedGraph, native: string) => {
  const name = adapted.identities.resources[native]
  assert.ok(name, `missing compiled resource ${native}`)
  return name
}
const tmpfsRoot = async (t: TestContext) => {
  const root = await mkdtemp("/dev/shm/usl-native-development-")
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
const copyBindingSources = async (root: string) => {
  for (const name of ["request.json", "plan.json", "references.json"]) {
    const destination = join(root, "research", "native-development", name)
    await mkdir(join(root, "research", "native-development"), { recursive: true })
    await writeFile(destination, await readFile(join(BASE, name)))
  }
}
const acyclic = (graph: ResourceGraph) => {
  const prerequisites = new Map<string, string[]>()
  for (const meaning of ["dependsOn", "conditionallyDependsOn"]) for (const link of edges(graph, meaning)) {
    const work = role(link, "work"), prerequisite = role(link, "prerequisite")
    assert.ok(work && prerequisite, `${meaning} requires work and prerequisite`)
    prerequisites.set(work, [...(prerequisites.get(work) ?? []), prerequisite])
  }
  const active = new Set<string>(), complete = new Set<string>()
  const visit = (id: string): boolean => {
    if (active.has(id)) return false
    if (complete.has(id)) return true
    active.add(id)
    const valid = (prerequisites.get(id) ?? []).every(visit)
    active.delete(id)
    if (valid) complete.add(id)
    return valid
  }
  return [...prerequisites.keys()].every(visit)
}

test("native development graph has complete requirement → work → acceptance/evidence paths and a closed planned-state profile", async () => {
  const { raw, graph, profile } = await graphFixture()
  const adapted = Either.getOrThrowWith(adaptResourceGraph(raw, { namespace, profile }), error => error)
  const count = (name: string) => graph.resources.filter(item => item.types.includes(type(name))).length
  assert.equal(count("Requirement"), 10)
  assert.equal(count("WorkItem"), 12)
  assert.equal(count("AcceptanceTest"), 24)
  assert.equal(checkResourceGraphProfile(graph, profile).status, "CONFORMS")
  assert.equal(checkResourceGraphProfile(graph, profile).semanticTruth, "NOT_EVALUATED")
  assert.equal(Object.keys(adapted.identities.resources).length, graph.resources.length)

  const requirements = graph.resources.filter(item => item.types.includes(type("Requirement")))
  const works = graph.resources.filter(item => item.types.includes(type("WorkItem")))
  for (const requirement of requirements) {
    assert.equal(requirement.metadata?.authorityClass, "SECONDARY_AI")
    const sources = edges(graph, "derivedFrom").filter(link => role(link, "requirement") === requirement.id).map(link => role(link, "source"))
    assert.ok(sources.length > 0, `${requirement.id} lacks user source`)
    for (const source of sources) assert.equal(resource(graph, source!).metadata?.authorityClass, "USER_PRIMARY")
    assert.ok(works.some(work => has(graph, "realizes", { work: work.id, requirement: requirement.id })), `${requirement.id} lacks planned work`)
  }
  for (const work of works) {
    assert.equal(work.metadata?.status, "PLANNED")
    const realized = edges(graph, "realizes").filter(link => role(link, "work") === work.id).map(link => role(link, "requirement"))
    const tests = edges(graph, "verifiedBy").filter(link => role(link, "work") === work.id).map(link => role(link, "test"))
    const evidence = edges(graph, "groundedIn").filter(link => role(link, "work") === work.id).map(link => role(link, "artifact"))
    assert.ok(realized.length > 0 && tests.length > 0 && evidence.length > 0, `${work.id} must connect requirement, test, and evidence`)
    for (const id of realized) assert.ok(edges(graph, "derivedFrom").some(link => role(link, "requirement") === id), `${work.id} requirement lacks source`)
    for (const id of tests) assert.equal(resource(graph, id!).metadata?.status, "SPECIFIED_NOT_RUN")
    for (const id of evidence) assert.ok(resource(graph, id!).types.includes(type("Artifact")))
  }
  for (const link of edges(graph, "conditionallyDependsOn")) assert.equal(typeof link.metadata?.condition, "string")
  assert.ok(acyclic(graph), "mandatory and conditional prerequisite graph must be acyclic")
})

test("native development profile rejects role, type, authority, and planned-status promotion errors", async () => {
  const { graph, profile } = await graphFixture()
  const realizes = edges(graph, "realizes")[0]!
  const roleReversed: ResourceGraph = { ...graph, links: graph.links.map(link => link.id !== realizes.id ? link : {
    ...link, participants: link.participants.map(value => value.role === "work" ? { ...value, resource: role(realizes, "requirement")! } : value.role === "requirement" ? { ...value, resource: role(realizes, "work")! } : value),
  }) }
  const wrongType: ResourceGraph = { ...graph, resources: graph.resources.map(item => item.id !== "urn:usl:dev:work:P01" ? item : { ...item, types: [type("Requirement")] }) }
  const wrongAuthority: ResourceGraph = { ...graph, resources: graph.resources.map(item => item.id !== "urn:usl:dev:req:R01" ? item : { ...item, metadata: { ...item.metadata, authorityClass: "USER_PRIMARY" } }) }
  const wrongStatus: ResourceGraph = { ...graph, resources: graph.resources.map(item => item.id !== "urn:usl:dev:test:P01-positive" ? item : { ...item, metadata: { ...item.metadata, status: "SUCCEEDED" } }) }
  for (const invalid of [roleReversed, wrongType, wrongAuthority, wrongStatus]) assert.ok(Either.isLeft(adaptResourceGraph(JSON.stringify(invalid), { namespace, profile })))
})

test("native development competency queries return bounded SDK witnesses for six planned relationships", async () => {
  const { raw, graph, profile } = await graphFixture()
  const adapted = Either.getOrThrowWith(adaptResourceGraph(raw, { namespace, profile }), error => error)
  const scenarios = [
    {
      focus: "wig:native:source:user", target: "urn:usl:dev:work:P08",
      edges: [
        witness(graph, adapted, "derivedFrom", { source: "wig:native:source:user", requirement: "urn:usl:dev:req:R06" }),
        witness(graph, adapted, "realizes", { requirement: "urn:usl:dev:req:R06", work: "urn:usl:dev:work:P08" }),
      ],
      roles: [["source", "requirement"], ["requirement", "work"]],
      subjects: ["wig:native:source:user", "urn:usl:dev:req:R06", "urn:usl:dev:work:P08"],
    },
    {
      focus: "urn:usl:dev:work:P05", target: "urn:usl:dev:artifact:root-switch",
      edges: [witness(graph, adapted, "groundedIn", { work: "urn:usl:dev:work:P05", artifact: "urn:usl:dev:artifact:root-switch" })],
      roles: [["work", "artifact"]], subjects: ["urn:usl:dev:work:P05", "urn:usl:dev:artifact:root-switch"],
    },
    {
      focus: "urn:usl:dev:work:P09", target: "urn:usl:dev:work:P02",
      edges: [
        witness(graph, adapted, "dependsOn", { work: "urn:usl:dev:work:P09", prerequisite: "urn:usl:dev:work:P05" }),
        witness(graph, adapted, "dependsOn", { work: "urn:usl:dev:work:P05", prerequisite: "urn:usl:dev:work:P02" }),
      ],
      roles: [["work", "prerequisite"], ["work", "prerequisite"]],
      subjects: ["urn:usl:dev:work:P09", "urn:usl:dev:work:P05", "urn:usl:dev:work:P02"],
    },
    {
      focus: "urn:usl:dev:work:P11", target: "urn:usl:dev:constraint:C03",
      edges: [witness(graph, adapted, "constrainedBy", { work: "urn:usl:dev:work:P11", constraint: "urn:usl:dev:constraint:C03" })],
      roles: [["work", "constraint"]], subjects: ["urn:usl:dev:work:P11", "urn:usl:dev:constraint:C03"],
    },
    {
      focus: "urn:usl:dev:work:P04", target: "urn:usl:dev:test:P04-adversarial",
      edges: [witness(graph, adapted, "verifiedBy", { work: "urn:usl:dev:work:P04", test: "urn:usl:dev:test:P04-adversarial" })],
      roles: [["work", "test"]], subjects: ["urn:usl:dev:work:P04", "urn:usl:dev:test:P04-adversarial"],
    },
    {
      focus: "wig:native:work:N1", target: "urn:usl:dev:artifact:prior-graph",
      edges: [witness(graph, adapted, "originallyDeclaredIn", { prior: "wig:native:work:N1", artifact: "urn:usl:dev:artifact:prior-graph" })],
      roles: [["prior", "artifact"]], subjects: ["wig:native:work:N1", "urn:usl:dev:artifact:prior-graph"],
    },
  ] as const
  for (const scenario of scenarios) {
    const context = Either.getOrThrowWith(agentContext(adapted.plan, {
      focus: compiledResource(adapted, scenario.focus), target: compiledResource(adapted, scenario.target),
      routes: scenario.edges.map((edge, index) => {
        const [enter, exit] = scenario.roles[index]!
        return { meaning: edge.meaning, enter, exit }
      }),
      maxHops: 2, maxResources: 128, maxLinks: 256, maxVisits: 2048,
    }), error => error)
    assert.equal(context.target?.status, "FOUND", `${scenario.focus} → ${scenario.target}`)
    const steps = context.target?.path?.steps
    assert.ok(steps)
    assert.deepEqual(steps.map(step => step.link), scenario.edges.map(edge => edge.name))
    assert.deepEqual(steps.map(step => [step.enteredRole, step.exitedRole]), scenario.roles)
    assert.deepEqual([context.focus, ...steps.map(step => step.to)], scenario.subjects.map(subject => compiledResource(adapted, subject)))
    assert.deepEqual(steps.map(step => step.meaning), scenario.edges.map(edge => edge.meaning))
  }
})

test("native development connection stays deny-all and its host is binding-only with no executable action", async () => {
  const connection = await readMcpConfig(paths.connection, {})
  assert.deepEqual(connection.policy.allowedLocators, [])
  assert.equal(connection.policy.maxResources, 128)
  assert.equal(connection.policy.maxInputBytes, 4 * 1024 * 1024)
  assert.equal(connection.policy.maxOutputBytes, 4 * 1024 * 1024)
  const resolver = fileConnectionResolver(connection.connections ?? {}, connection.policy.maxInputBytes)
  const resolved = await resolver("usl-native-development-v1")
  const { raw, profile } = await graphFixture()
  const expected = Either.getOrThrowWith(adaptResourceGraph(raw, { namespace, profile }), error => error)
  assert.equal(resolved.source.digest, expected.source.digest)
  await assert.rejects(resolver("unknown-connection"), /unknown connection/)
  const host = await json(paths.host) as { actions?: unknown; workspaces?: Record<string, unknown> }
  assert.deepEqual(host.actions, [])
  assert.equal(host.workspaces?.usl, "../..")
})

test("switching only the registered USL root changes selected file locators while preserving graph IDs, roles, and file pins", async t => {
  const { raw, graph } = await graphFixture(), { bindings, selections } = await bindingFixture()
  const a = await tmpfsRoot(t), b = await tmpfsRoot(t)
  await Promise.all([copyBindingSources(a), copyBindingSources(b)])
  const [first, second] = await Promise.all([
    bindResourceGraph(raw, bindings, selections, { workspaces: { usl: a }, hostname: "native-development-test" }),
    bindResourceGraph(raw, bindings, selections, { workspaces: { usl: b }, hostname: "native-development-test" }),
  ])
  assert.deepEqual(first.graph.resources.map(item => item.id), graph.resources.map(item => item.id))
  assert.deepEqual(second.graph.resources.map(item => item.id), graph.resources.map(item => item.id))
  assert.deepEqual(first.graph.links, graph.links)
  assert.deepEqual(second.graph.links, graph.links)
  assert.deepEqual(first.graph.meanings, graph.meanings)
  assert.deepEqual(second.graph.meanings, graph.meanings)
  assert.deepEqual(first.graph.provenance, graph.provenance)
  assert.deepEqual(second.graph.provenance, graph.provenance)
  for (const original of graph.resources) {
    const firstResource = resource(first.graph, original.id), secondResource = resource(second.graph, original.id)
    assert.deepEqual(firstResource.types, original.types)
    assert.deepEqual(secondResource.types, original.types)
    assert.deepEqual(firstResource.metadata, original.metadata)
    assert.deepEqual(secondResource.metadata, original.metadata)
  }
  assert.equal(first.bindingReceipt.bindingsDigest, second.bindingReceipt.bindingsDigest)
  assert.notEqual(first.bindingReceipt.resultDigest, second.bindingReceipt.resultDigest)
  assert.deepEqual(first.bindingReceipt.selections.map(item => item.expectedDigest), second.bindingReceipt.selections.map(item => item.expectedDigest))
  assert.deepEqual(first.bindingReceipt.selections.map(item => [item.resource, item.representation]), selections.map(item => [item.resource, item.representation]))
  assert.deepEqual(second.bindingReceipt.selections.map(item => [item.resource, item.representation]), selections.map(item => [item.resource, item.representation]))
  for (const selection of selections) {
    const aLocator = resource(first.graph, selection.resource).locator
    const bLocator = resource(second.graph, selection.resource).locator
    assert.notEqual(aLocator, bLocator, `${selection.resource} locator must follow only its host root`)
  }
  for (const selection of [selections[0]!, selections.find(item => item.resource === "urn:usl:dev:req:R01")!, selections.find(item => item.resource === "urn:usl:dev:artifact:bindings")!]) {
    const report = await inspectResourceBinding(bindings, selection, { workspaces: { usl: a }, hostname: "native-development-test", maxBytes: 128 * 1024, timeoutMs: 2000 })
    assert.equal(report.content.pinStatus, "MATCH")
    assert.equal(report.git?.state, "NO_REPOSITORY")
  }
})
