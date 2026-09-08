import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { Either } from "effect"
import { planDigest } from "../src/language/digest.js"
import { adaptPropertyGraph } from "../src/integrations/property-graph.js"

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

test("adapts a read-only property-graph snapshot with stable hashed identities and n-ary roles", () => {
  const raw = graph(), result = Either.getOrThrow(adapt(raw))
  assert.equal(result.source.adapter, "property-graph/v1")
  assert.equal(result.source.digest, digest(raw))
  assert.equal(result.plan.resources.length, 3)
  assert.equal(result.plan.resources.find((resource) => resource.locator.kind === "kg")?.locator.kind, "kg")
  assert.equal(result.plan.links.length, 1)
  assert.equal(result.plan.links[0]!.participants.length, 3)
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
  assert.equal(result.plan.meanings[0]!.description, "Declared KG relation: REFERENCES")
  assert.equal(result.plan.links[0]!.participants.length, 2)
  assert.ok(Object.keys(result.identities.links)[0]!.startsWith("derived:"))
})

test("binds raw source and semantic descriptions and contracts to the compiled plan identity", () => {
  const first = graph(), descriptionChanged = graph({ description: "dashboard implements player code" })
  const changedContract = graph({ contract: { scope: "game build 43", checks: [{ name: "review", description: "compare acceptance behavior", evidenceRoles: ["code", "requirement", "evidence"] }] } })
  const a = Either.getOrThrow(adapt(first)), b = Either.getOrThrow(adapt(descriptionChanged)), c = Either.getOrThrow(adapt(changedContract))
  assert.notEqual(a.source.digest, b.source.digest)
  assert.notEqual(planDigest(a.plan), planDigest(b.plan))
  assert.notEqual(planDigest(a.plan), planDigest(c.plan))
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
})

test("requires explicit n-ary participants to retain both relation endpoints", () => {
  const raw = graph({ participants: [{ role: "code", uid: "player" }, { role: "evidence", uid: "acceptance" }] })
  assert.ok(Either.isLeft(adapt(raw)))
})
