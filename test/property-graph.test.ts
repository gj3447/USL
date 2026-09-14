import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { Effect, Either } from "effect"
import { DEFAULT_USL_POLICY, executeUslOperation } from "../src/application.js"
import { digestJson, planDigest } from "../src/language/digest.js"
import { adaptPropertyGraph, type PropertyGraphAdaptation } from "../src/integrations/property-graph.js"
import { compareObservations } from "../src/language/comparison.js"
import { formatLocator } from "../src/locator.js"

const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`
const graph = (changes: Record<string, unknown> = {}) => JSON.stringify({
  nodes: [
    { uid: "player", properties: { locator: "file://game/src/player.ts" } },
    { uid: "dashboard", properties: {} },
    { uid: "acceptance", properties: { locator: "https://example.test/acceptance" } },
  ],
  relations: [{ uid: "implements-dashboard", from_uid: "player", to_uid: "dashboard", type: "IMPLEMENTS", properties: {
    description: "player code implements the dashboard",
    contract: { scope: "game build 42", checks: [{ name: "review", description: "compare acceptance behavior", evidenceRoles: ["code", "requirement", "evidence"] }] },
    participants: [{ role: "code", uid: "player" }, { role: "requirement", uid: "dashboard" }, { role: "evidence", uid: "acceptance" }],
    ...changes,
  }}],
})
const adapt = (raw = graph()) => adaptPropertyGraph(raw, { namespace: "game.property-graph", kgSource: "game-kg" })
const observe = async (adapted: PropertyGraphAdaptation) => await executeUslOperation("observe", {
  connection: "property-graph", options: { links: ["implements-dashboard"] },
}, {
  ...DEFAULT_USL_POLICY,
  getConnection: async () => adapted,
  allowedLocators: adapted.plan.resources.map((resource) => formatLocator(resource.locator)),
  resolvers: { resolve: (locator) => Effect.succeed({ locator, resolvedLocator: formatLocator(locator), contentHash: "a".repeat(64),
    resolvedAt: "2026-09-08T00:00:00.000Z", guaranteeLevel: "pure" as const, matchCount: 1 }) },
}) as { readonly source: { readonly digest: string }; readonly result: import("../src/language/runtime.js").ProgramObservation }

test("adapts a read-only property-graph snapshot with stable hashed identities and n-ary roles", () => {
  const raw = graph(), result = Either.getOrThrow(adapt(raw))
  assert.equal(result.source.adapter, "property-graph/v2")
  assert.equal(result.source.digest, digest(raw))
  assert.equal(result.plan.resources.length, 3)
  assert.equal(result.plan.resources.find((resource) => resource.locator.kind === "kg")?.locator.kind, "kg")
  assert.equal(result.plan.links.length, 1)
  assert.equal(result.plan.links[0]!.participants.length, 3)
  assert.deepEqual(result.plan.links[0]!.participants.map((participant) => participant.role), ["code", "evidence", "requirement"])
  assert.ok(result.plan.meanings[0]!.name.startsWith("pg_meaning_"))
  assert.ok(result.identities.resources.player!.startsWith("pg_resource_"))
  assert.ok(result.identities.links["implements-dashboard"]!.startsWith("pg_link_"))
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.plan)); assert.ok(Object.isFrozen(result.identities.resources))
  const again = Either.getOrThrow(adapt(raw))
  assert.deepEqual(result.identities, again.identities)
})

test("uses KG fallback only for nodes without a locator and declares missing descriptions explicitly", () => {
  const raw = JSON.stringify({ nodes: [{ uid: "a" }, { uid: "b" }], relations: [{ from_uid: "a", to_uid: "b", type: "REFERENCES" }] })
  const result = Either.getOrThrow(adaptPropertyGraph(raw, { namespace: "fallback", kgSource: "canonical" }))
  assert.deepEqual(result.plan.resources.map((resource) => resource.locator), [{ kind: "kg", source: "canonical", uid: "a" }, { kind: "kg", source: "canonical", uid: "b" }])
  assert.deepEqual(JSON.parse(result.plan.meanings[0]!.description), {
    schema: "property-graph-meaning/v2", type: "REFERENCES", direction: { from_uid: "a", to_uid: "b" }, description: null,
  })
  assert.equal(result.plan.links[0]!.participants.length, 2)
  assert.ok(Object.keys(result.identities.links)[0]!.startsWith("derived:"))
})

test("binds raw source and semantic descriptions and contracts to the compiled plan identity", () => {
  const first = graph(), descriptionChanged = graph({ description: "dashboard implements player code" })
  const typeChanged = first.replace('"type":"IMPLEMENTS"', '"type":"DOCUMENTS"')
  const changedContract = graph({ contract: { scope: "game build 43", checks: [{ name: "review", description: "compare acceptance behavior", evidenceRoles: ["code", "requirement", "evidence"] }] } })
  const a = Either.getOrThrow(adapt(first)), b = Either.getOrThrow(adapt(descriptionChanged)), c = Either.getOrThrow(adapt(changedContract)), d = Either.getOrThrow(adapt(typeChanged))
  assert.notEqual(a.source.digest, b.source.digest)
  assert.notEqual(planDigest(a.plan), planDigest(b.plan))
  assert.notEqual(planDigest(a.plan), planDigest(c.plan))
  assert.notEqual(planDigest(a.plan), planDigest(d.plan))
})

test("binds directed endpoints and description presence even with an explicit n-ary participant view", () => {
  const forward = graph()
  const reversed = forward.replace('"from_uid":"player","to_uid":"dashboard"', '"from_uid":"dashboard","to_uid":"player"')
  const absent = graph({ description: undefined })
  const literalObject = JSON.parse(absent) as { relations: Array<{ type: string }> }
  literalObject.relations[0]!.type = JSON.stringify({ type: "IMPLEMENTS", description: "player code implements the dashboard" })
  const literal = JSON.stringify(literalObject)
  const a = Either.getOrThrow(adapt(forward)), b = Either.getOrThrow(adapt(reversed))
  const c = Either.getOrThrow(adapt(absent)), d = Either.getOrThrow(adapt(literal))
  assert.notEqual(planDigest(a.plan), planDigest(b.plan))
  assert.notEqual(digestJson(a.plan.meanings), digestJson(b.plan.meanings))
  assert.notEqual(planDigest(a.plan), planDigest(c.plan))
  assert.notEqual(planDigest(c.plan), planDigest(d.plan))
  assert.notEqual(planDigest(a.plan), planDigest(d.plan))
  assert.equal(JSON.parse(a.plan.meanings[0]!.description).direction.from_uid, "player")
  assert.equal(JSON.parse(b.plan.meanings[0]!.description).direction.from_uid, "dashboard")
  assert.equal(JSON.parse(c.plan.meanings[0]!.description).description, null)
})

test("canonicalizes orderless n-ary role bindings while retaining every role and UID", () => {
  const first = graph()
  const reordered = graph({ participants: [{ role: "evidence", uid: "acceptance" }, { role: "requirement", uid: "dashboard" }, { role: "code", uid: "player" }] })
  const a = Either.getOrThrow(adapt(first)), b = Either.getOrThrow(adapt(reordered))
  assert.notEqual(a.source.digest, b.source.digest)
  assert.equal(planDigest(a.plan), planDigest(b.plan))
  assert.equal(digestJson(a.plan.meanings), digestJson(b.plan.meanings))
  assert.deepEqual(a.plan.links[0]!.participants, b.plan.links[0]!.participants)
})

test("RESOLVES observations classify directed reversal as semantic and order-only n-ary changes as unchanged", async () => {
  const forwardRaw = graph()
  const reversedRaw = forwardRaw.replace('"from_uid":"player","to_uid":"dashboard"', '"from_uid":"dashboard","to_uid":"player"')
  const reorderedRaw = graph({ participants: [{ role: "evidence", uid: "acceptance" }, { role: "requirement", uid: "dashboard" }, { role: "code", uid: "player" }] })
  const forward = Either.getOrThrow(adapt(forwardRaw)), reversed = Either.getOrThrow(adapt(reversedRaw)), reordered = Either.getOrThrow(adapt(reorderedRaw))
  const before = await observe(forward), directionAfter = await observe(reversed), orderAfter = await observe(reordered)
  assert.equal(before.result.status, "RESOLVES"); assert.equal(directionAfter.result.status, "RESOLVES"); assert.equal(orderAfter.result.status, "RESOLVES")
  assert.notEqual(before.source.digest, directionAfter.source.digest)
  assert.notEqual(before.result.planDigest, directionAfter.result.planDigest)
  assert.notEqual(before.result.meaningsDigest, directionAfter.result.meaningsDigest)
  const direction = Either.getOrThrow(compareObservations(before.result, directionAfter.result)).links[0]!
  assert.equal(direction.semanticContractChanged, true)
  assert.deepEqual(direction.actions, ["REVIEW_SEMANTIC_CONTRACT"])
  assert.notEqual(before.source.digest, orderAfter.source.digest)
  assert.equal(before.result.planDigest, orderAfter.result.planDigest)
  assert.equal(before.result.meaningsDigest, orderAfter.result.meaningsDigest)
  const order = Either.getOrThrow(compareObservations(before.result, orderAfter.result)).links[0]!
  assert.equal(order.semanticContractChanged, false)
  assert.deepEqual(order.actions, [])
})

test("rejects ambiguous or malformed graph inputs before compiling a plan", () => {
  const missingLocator = JSON.stringify({ nodes: [{ uid: "a" }, { uid: "b" }], relations: [] })
  assert.ok(Either.isLeft(adaptPropertyGraph(missingLocator, { namespace: "x" })))
  const missingEndpoint = JSON.stringify({ nodes: [{ uid: "a" }], relations: [{ from_uid: "a", to_uid: "gone", type: "REL" }] })
  assert.ok(Either.isLeft(adaptPropertyGraph(missingEndpoint, { namespace: "x", kgSource: "kg" })))
  const duplicateNode = JSON.stringify({ nodes: [{ uid: "a" }, { uid: "a" }], relations: [] })
  assert.ok(Either.isLeft(adaptPropertyGraph(duplicateNode, { namespace: "x", kgSource: "kg" })))
  const duplicateRelation = JSON.stringify({ nodes: [{ uid: "a" }, { uid: "b" }], relations: [{ uid: "r", from_uid: "a", to_uid: "b", type: "REL" }, { uid: "r", from_uid: "a", to_uid: "b", type: "REL" }] })
  assert.ok(Either.isLeft(adaptPropertyGraph(duplicateRelation, { namespace: "x", kgSource: "kg" })))
  const parallelWithoutUid = JSON.stringify({ nodes: [{ uid: "a" }, { uid: "b" }], relations: [{ from_uid: "a", to_uid: "b", type: "REL" }, { from_uid: "a", to_uid: "b", type: "REL" }] })
  assert.ok(Either.isLeft(adaptPropertyGraph(parallelWithoutUid, { namespace: "x", kgSource: "kg" })))
  const nullField = JSON.stringify({ nodes: [{ uid: null }], relations: [] })
  assert.ok(Either.isLeft(adaptPropertyGraph(nullField, { namespace: "x", kgSource: "kg" })))
  const invalidRole = graph({ participants: [{ role: "not a usl role", uid: "player" }, { role: "requirement", uid: "dashboard" }, { role: "evidence", uid: "acceptance" }] })
  assert.ok(Either.isLeft(adapt(invalidRole)))
})

test("requires explicit n-ary participants to retain both relation endpoints", () => {
  const raw = graph({ participants: [{ role: "code", uid: "player" }, { role: "evidence", uid: "acceptance" }] })
  assert.ok(Either.isLeft(adapt(raw)))
})

test("preserves a hostile-but-valid original relation UID as a data key", () => {
  const raw = JSON.stringify({ nodes: [{ uid: "a" }, { uid: "b" }], relations: [{ uid: "__proto__", from_uid: "a", to_uid: "b", type: "REL" }] })
  const result = Either.getOrThrow(adaptPropertyGraph(raw, { namespace: "prototype-key", kgSource: "kg" }))
  assert.ok(Object.hasOwn(result.identities.links, "__proto__"))
  assert.ok(result.identities.links["__proto__"]!.startsWith("pg_link_"))
})
