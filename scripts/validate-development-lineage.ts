#!/usr/bin/env node
/** Validate the generated development-lineage graph and portable bindings. */
import assert from "node:assert/strict"
import { cp, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Either } from "effect"
import { DEFAULT_USL_POLICY } from "../src/application.js"
import { connectUsl } from "../src/adapters.js"
import { parseDomainProfile } from "../src/domain-profile.js"
import { bindResourceGraph } from "../src/integrations/resource-bindings.js"
import { adaptResourceGraph, parseResourceGraph, resourceGraphJsonLd, type ResourceGraph } from "../src/integrations/resource-graph.js"
import { fileConnectionResolver, parseMcpConfig } from "../src/mcp-config.js"
import { parseResourceBindings, type ResourceBindings } from "../src/resource-bindings.js"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const BASE = join(ROOT, "research", "development-lineage")
const paths = {
  graph: join(BASE, "graph.json"), profile: join(BASE, "profile.json"), bindings: join(BASE, "bindings.json"),
  selections: join(BASE, "selections.json"), catalog: join(BASE, "catalog.json"), next: join(BASE, "next.graph.json"), philosophy: join(BASE, "philosophy.graph.json"), mcp: join(BASE, "mcp.json"),
} as const
const namespace = "usl.development.lineage"

const fail = (message: string): never => { throw new Error(`development-lineage validation failed: ${message}`) }
const unwrap = <A, E>(result: Either.Either<A, E>, label: string): A => Either.getOrThrowWith(result, error => fail(`${label}: ${String(error)}`))
const bytes = async (path: string, maxBytes = 1024 * 1024) => {
  const value = await readFile(path)
  if (value.byteLength > maxBytes) fail(`input exceeds ${maxBytes} byte budget: ${relative(ROOT, path)}`)
  return value
}
const json = async (path: string, maxBytes?: number): Promise<unknown> => {
  let value: unknown
  try { value = JSON.parse((await bytes(path, maxBytes)).toString("utf8")) } catch { fail(`invalid UTF-8 JSON: ${relative(ROOT, path)}`) }
  return value
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const rejected = (action: () => unknown, label: string) => {
  try { action() } catch { return }
  fail(`negative case accepted: ${label}`)
}
const beneath = (root: string, candidate: string) => {
  const value = relative(root, candidate)
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value))
}

const graphWithoutLocators = (graph: ResourceGraph) => ({ ...graph, resources: graph.resources.map(({ locator: _locator, ...resource }) => resource) })

const profileReversalMustReject = (raw: ResourceGraph, profile: ReturnType<typeof parseDomainProfile>) => {
  const rules = new Map(profile.meanings.map(meaning => [meaning.id, meaning]))
  const resources = new Map(raw.resources.map(resource => [resource.id, resource]))
  const accepts = (rule: { readonly types: readonly string[]; readonly metadata: readonly { readonly key: string; readonly equals: unknown }[] }, resource: ResourceGraph["resources"][number]) =>
    rule.types.every(type => resource.types.includes(type)) && rule.metadata.every(constraint => JSON.stringify(resource.metadata?.[constraint.key]) === JSON.stringify(constraint.equals))
  for (const link of raw.links) {
    const rule = rules.get(link.meaning)
    if (!rule || link.participants.length < 2) continue
    for (let i = 0; i < link.participants.length; i++) for (let j = i + 1; j < link.participants.length; j++) {
      const left = link.participants[i]!, right = link.participants[j]!
      const leftRule = rule.roles.find(candidate => candidate.role === left.role)
      const rightRule = rule.roles.find(candidate => candidate.role === right.role)
      const leftResource = resources.get(left.resource), rightResource = resources.get(right.resource)
      if (!leftRule || !rightRule || !leftResource || !rightResource || (accepts(leftRule, rightResource) && accepts(rightRule, leftResource))) continue
      const changed = copy(raw)
      const participants = changed.links.find(candidate => candidate.id === link.id)!.participants
      participants[i] = { role: left.role, resource: right.resource }
      participants[j] = { role: right.role, resource: left.resource }
      rejected(() => unwrap(adaptResourceGraph(JSON.stringify(changed), { namespace, profile }), "reversed graph"), "profile role reversal")
      return
    }
  }
  fail("profile has no asymmetric link roles for reversal negative case")
}

const graphNegatives = (raw: ResourceGraph, profile: ReturnType<typeof parseDomainProfile>) => {
  const duplicate = copy(raw)
  duplicate.resources.push(copy(duplicate.resources[0]!))
  rejected(() => unwrap(adaptResourceGraph(JSON.stringify(duplicate), { namespace, profile }), "duplicate graph"), "duplicate resource")
  const dangling = copy(raw)
  dangling.links[0]!.participants[0] = { role: dangling.links[0]!.participants[0]!.role, resource: "resource:missing" }
  rejected(() => unwrap(adaptResourceGraph(JSON.stringify(dangling), { namespace, profile }), "dangling graph"), "dangling participant")
  profileReversalMustReject(raw, profile)
}

const assertInducedSubset = (full: ResourceGraph, next: ResourceGraph) => {
  const sourceResources = new Map(full.resources.map(resource => [resource.id, resource]))
  const sourceLinks = new Map(full.links.map(link => [link.id, link]))
  const selected = new Set(next.resources.map(resource => resource.id))
  if (selected.size !== next.resources.length || selected.size === 0) fail("next graph resource IDs are not a nonempty set")
  for (const resource of next.resources) assert.deepEqual(resource, sourceResources.get(resource.id), `next graph rewrote resource ${resource.id}`)
  const expectedLinks = full.links.filter(link => link.participants.every(participant => selected.has(participant.resource)))
  assert.deepEqual(next.links, expectedLinks, "next graph is not the exact full-graph induced link subset")
  for (const link of next.links) assert.deepEqual(link, sourceLinks.get(link.id), `next graph rewrote link ${link.id}`)
  const sourceMeanings = new Map(full.meanings.map(meaning => [meaning.id, meaning]))
  for (const meaning of next.meanings) assert.deepEqual(meaning, sourceMeanings.get(meaning.id), `next graph rewrote meaning ${meaning.id}`)
  assert.deepEqual(next.provenance, full.provenance, "next graph rewrote provenance")
}

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`)
  return value as Record<string, unknown>
}
const philosophySemantics = (catalogValue: unknown, graph: ResourceGraph) => {
  const catalog = record(catalogValue, "catalog")
  const philosophy = record(catalog.philosophy, "catalog philosophy")
  assert.equal(philosophy.operationalReadinessIsScore, false, "operational readiness must not be a score")
  assert.equal(philosophy.numericScore, null, "unmeasured philosophical evaluation must have null score")
  assert.equal(philosophy.measurementStatus, "NOT_MEASURED")
  assert.equal(philosophy.optimalityStatus, "NOT_PROVEN")
  const comparison = record(philosophy.comparison, "philosophy comparison")
  assert.equal(comparison.status, "HYPOTHESIS_NOT_TESTED")
  assert.equal(comparison.score, null)
  assert.equal(comparison.winner, "UNDETERMINED")
  const boundaries = record(catalog.boundaries, "catalog boundaries")
  assert.equal(boundaries.hswmExecution, "NOT_READY")
  assert.notEqual(boundaries.hswmExecution, 0, "NOT_READY must not be coerced into a numerical score")
  assert.equal(boundaries.hswmExecutionScope, "SOFTWARE_INTEGRATION_ONLY")
  assert.equal(boundaries.philosophicalOptimizationStatus, "NOT_MEASURED")
  const byId = new Map(graph.resources.map(resource => [resource.id, resource]))
  const frame = byId.get("evaluation:hswm-philosophy:usl-v1") ?? fail("philosophy view omitted evaluation frame")
  const graphComparison = byId.get("comparison:hswm-philosophy:standards-vs-software") ?? fail("philosophy view omitted comparison")
  assert.deepEqual(frame.metadata, Object.fromEntries(Object.entries(philosophy).filter(([key]) => !["userStatements", "context", "candidates", "dimensions", "comparison"].includes(key))), "evaluation frame metadata drifted")
  assert.deepEqual(graphComparison.metadata, comparison, "comparison metadata drifted")
  const candidates = Array.isArray(philosophy.candidates) ? philosophy.candidates : fail("philosophy candidates must be an array")
  if (candidates.length !== 2) fail("philosophy candidates are incomplete")
  for (const candidate of candidates) {
    const item = record(candidate, "philosophy candidate")
    assert.equal(item.measurementStatus, "NOT_MEASURED")
    assert.equal(item.score, null)
  }
}

const contextMustContainNativeIds = async (raw: string, profile: ReturnType<typeof parseDomainProfile>, policy: typeof DEFAULT_USL_POLICY,
  focus = "lineage:usl-development-2026-10-07", target = "task:usl-remaining:coordinated-export") => {
  const connection = connectUsl({ read: () => Effect.succeed(raw), adapt: source => adaptResourceGraph(source, { namespace, profile }), policy })
  const result = await Effect.runPromise(connection.context(undefined, { focus, target, maxHops: 1, maxResources: 64 }, { compact: true }))
  const delivered = result.result as { context: { focus: string; target: { resource: string; status: string };
    resources: { name: string }[]; paths: { resource: string; steps: string[][] }[] } }
  const focusName = result.identities.resources[focus], targetName = result.identities.resources[target]
  assert.ok(focusName && targetName, "native identity map omitted query endpoints")
  assert.equal(delivered.context.focus, focusName)
  assert.deepEqual(delivered.context.target, { resource: targetName, status: "FOUND" })
  assert.ok(delivered.context.resources.some(resource => resource.name === targetName), "target missing from delivered context")
  assert.ok(delivered.context.paths.some(path => path.resource === targetName && path.steps.length > 0), "no actual path to the next task")
}

const fullConnectionProbe = async (raw: string, profile: ReturnType<typeof parseDomainProfile>) => {
  const encoded = (await bytes(paths.mcp)).toString("utf8")
  const config = parseMcpConfig(encoded, BASE, "development-lineage MCP config")
  assert.deepEqual(config.policy.allowedLocators, [], "lineage MCP policy must deny locator reads")
  assert.equal(config.policy.maxInputBytes, 16 * 1024 * 1024, "lineage MCP input budget must support the compiled full graph")
  assert.equal(config.policy.maxOutputBytes, 16 * 1024 * 1024, "lineage MCP output budget must support context")
  assert.equal(config.connections?.["usl-development-lineage"]?.graph, paths.graph, "MCP connection must select the full graph")
  // Exercise the host-owned registered resolver once, then the normal native
  // adapter path used by an in-process connection/context request.
  const resolved = await fileConnectionResolver(config.connections ?? {}, config.policy.maxInputBytes)("usl-development-lineage")
  assert.equal(resolved.source.digest, unwrap(adaptResourceGraph(raw, { namespace, profile }), "full graph").source.digest)
  await contextMustContainNativeIds(raw, profile, config.policy)
}

const workspaceSelections = (bindings: ResourceBindings, selections: readonly { readonly resource: string; readonly representation?: string }[]) => selections.flatMap(selection => {
  const resource = bindings.resources.find(candidate => candidate.id === selection.resource)
  const representation = resource?.representations.find(candidate => candidate.id === selection.representation)
  return representation?.kind === "workspace" ? [{ resource: selection.resource, representation }] : []
})

const probeBindings = async (rawText: string, raw: ResourceGraph, bindings: ResourceBindings,
  selections: readonly { readonly resource: string; readonly representation?: string }[]) => {
  const selected = workspaceSelections(bindings, selections)
  const workspaceNames = new Set(selected.map(value => value.representation.workspace))
  assert.deepEqual([...workspaceNames], ["usl"], "workspace bindings must use only the usl workspace alias")
  const localPaths = new Set(selected.map(value => value.representation.path))
  assert.equal(localPaths.size, 1, "workspace probe requires exactly one unique relative path")
  const sourceRelativePath = [...localPaths][0]!
  assert.equal(sourceRelativePath, "research/development-lineage/catalog.json", "workspace binding must point to the lineage catalog")
  const sourcePath = resolve(ROOT, sourceRelativePath)
  if (!beneath(ROOT, sourcePath) || !(await stat(sourcePath)).isFile()) fail("workspace source path is not a repository file")

  const parent = await mkdtemp(join(tmpdir(), "usl-development-lineage-"))
  const rootA = join(parent, "root-a"), rootB = join(parent, "root-b")
  try {
    for (const root of [rootA, rootB]) {
      const target = resolve(root, sourceRelativePath)
      if (!beneath(root, target)) fail("workspace representation escapes temporary root")
      await mkdir(dirname(target), { recursive: true })
      await cp(sourcePath, target, { recursive: false, force: false, errorOnExist: true })
    }
    const first = await bindResourceGraph(rawText, bindings, selections, { workspaces: { usl: rootA }, hostname: "lineage-probe" })
    const second = await bindResourceGraph(rawText, bindings, selections, { workspaces: { usl: rootB }, hostname: "lineage-probe" })
    assert.deepEqual(graphWithoutLocators(first.graph), graphWithoutLocators(second.graph), "relocation changed graph semantics")
    assert.deepEqual(graphWithoutLocators(first.graph), graphWithoutLocators(raw), "binding changed IDs, types, metadata, meanings, links, or provenance")
    for (const selectedValue of selected) {
      const a = first.graph.resources.find(resource => resource.id === selectedValue.resource)!
      const b = second.graph.resources.find(resource => resource.id === selectedValue.resource)!
      assert.equal(a.locator, `file://lineage-probe${resolve(rootA, sourceRelativePath)}`)
      assert.equal(b.locator, `file://lineage-probe${resolve(rootB, sourceRelativePath)}`)
    }
    for (const selection of selections) {
      const resource = bindings.resources.find(candidate => candidate.id === selection.resource)!
      const representation = resource.representations.find(candidate => candidate.id === selection.representation)!
      if (representation.kind !== "locator") continue
      const original = raw.resources.find(candidate => candidate.id === selection.resource)!
      assert.equal(first.graph.resources.find(candidate => candidate.id === selection.resource)!.locator, representation.locator, "locator representation changed during bind")
      assert.equal(representation.locator, original.locator, "immutable source locator replaced with workspace bytes")
    }
  } finally { await rm(parent, { recursive: true, force: true }) }
}

const main = async () => {
  if (process.argv.length !== 2) fail("this validator accepts no arguments")
  await Promise.all(Object.values(paths).map(async path => { if (!(await stat(path)).isFile()) fail(`missing input: ${relative(ROOT, path)}`) }))
  // Only the full graph follows the explicit MCP 16 MiB budget. Bindings keep
  // their independently enforced 1 MiB compact-input boundary below.
  const rawText = (await bytes(paths.graph, 16 * 1024 * 1024)).toString("utf8")
  const raw = unwrap(parseResourceGraph(rawText), "resource graph")
  const nextText = (await bytes(paths.next)).toString("utf8")
  const next = unwrap(parseResourceGraph(nextText), "next resource graph")
  const philosophyText = (await bytes(paths.philosophy)).toString("utf8")
  const philosophy = unwrap(parseResourceGraph(philosophyText), "philosophy resource graph")
  // Binding has a deliberate 1 MiB input cap; generated presentation whitespace
  // is not semantic graph data, so bind its compact parsed form.
  const bindText = JSON.stringify(raw)
  if (Buffer.byteLength(bindText, "utf8") > 1024 * 1024) fail("compact graph exceeds bindResourceGraph 1 MiB budget")
  const profile = parseDomainProfile(await json(paths.profile))
  const bindings = parseResourceBindings(await json(paths.bindings))
  const selectionsValue = await json(paths.selections)
  if (!Array.isArray(selectionsValue)) fail("selections must be an array")
  const selections = selectionsValue as readonly { readonly resource: string; readonly representation?: string }[]
  if (selections.length !== raw.resources.length) fail("every graph resource requires one selection")
  const selectedResources = new Set(selections.map(selection => selection.resource))
  if (selectedResources.size !== selections.length || selectedResources.size !== raw.resources.length || !raw.resources.every(resource => selectedResources.has(resource.id))) fail("selection coverage differs from graph resources")
  const bindingResources = new Set(bindings.resources.map(resource => resource.id))
  if (bindingResources.size !== raw.resources.length || !raw.resources.every(resource => bindingResources.has(resource.id))) fail("binding coverage differs from graph resources")
  for (const selection of selections) {
    const resource = bindings.resources.find(candidate => candidate.id === selection.resource)
    if (!resource || typeof selection.representation !== "string" || !resource.representations.some(candidate => candidate.id === selection.representation)) fail(`invalid default selection: ${selection.resource}`)
  }
  unwrap(adaptResourceGraph(rawText, { namespace, profile }), "adaptResourceGraph")
  unwrap(resourceGraphJsonLd(rawText, { namespace, profile }), "resourceGraphJsonLd")
  graphNegatives(raw, profile)
  assertInducedSubset(raw, next)
  assertInducedSubset(raw, philosophy)
  philosophySemantics(await json(paths.catalog), philosophy)
  unwrap(adaptResourceGraph(nextText, { namespace, profile }), "next adaptResourceGraph")
  unwrap(adaptResourceGraph(philosophyText, { namespace, profile }), "philosophy adaptResourceGraph")
  await fullConnectionProbe(rawText, profile)
  await contextMustContainNativeIds(nextText, profile, DEFAULT_USL_POLICY)
  await contextMustContainNativeIds(philosophyText, profile, DEFAULT_USL_POLICY,
    "evaluation:hswm-philosophy:usl-v1", "comparison:hswm-philosophy:standards-vs-software")
  const fullPolicy = parseMcpConfig((await bytes(paths.mcp)).toString("utf8"), BASE, "development-lineage MCP config").policy
  await contextMustContainNativeIds(rawText, profile, fullPolicy,
    "evaluation:hswm-philosophy:usl-v1", "candidate:hswm-philosophy:standards-stack")
  await contextMustContainNativeIds(philosophyText, profile, DEFAULT_USL_POLICY,
    "evaluation:hswm-philosophy:usl-v1", "candidate:hswm-philosophy:standards-stack")
  await probeBindings(bindText, raw, bindings, selections)
  process.stdout.write(`${JSON.stringify({ resources: raw.resources.length, meanings: raw.meanings.length, links: raw.links.length, nextResources: next.resources.length, nextLinks: next.links.length, philosophyResources: philosophy.resources.length, philosophyLinks: philosophy.links.length, selections: selections.length, negatives: 3, bindingProbe: "PASS", fullConnection: "PASS", defaultNextConnection: "PASS", philosophyContexts: "PASS", jsonld: "PASS" })}\n`)
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
