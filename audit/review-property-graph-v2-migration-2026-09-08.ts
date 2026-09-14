// Read-only migration comparison: no endpoint IO, observation or authority creation.
// The historical v1 plan is reconstructed, then checked against its recorded digest.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { Either } from "effect"
import { adaptPropertyGraph } from "../src/integrations/property-graph.js"
import { digestJson, digestSource, planDigest } from "../src/language/digest.js"
import { composePlans } from "../src/language/code.js"
import { hswmDigest, prepareHswmAdapterArguments } from "../src/integrations/hswm.js"
import { compileSource } from "../src/language/compiler.js"
import { validateObservation } from "../src/language/comparison.js"

const sourcePath = "examples/fixtures/native-graph.json"
const source = await readFile(sourcePath, "utf8"), native = JSON.parse(source)
const priorPath = "audit/native-adapter-smoke-2026-09-08.json"
const currentPath = "audit/native-adapter-fixes-smoke-2026-09-08.json"
const priorText = await readFile(priorPath, "utf8"), currentText = await readFile(currentPath, "utf8")
const prior = JSON.parse(priorText), current = JSON.parse(currentText)
const adapted = Either.getOrThrow(adaptPropertyGraph(source, { namespace: "game.adapter" }))
assert.equal(adapted.source.digest, prior.mcp.source.digest)
assert.equal(adapted.source.digest, current.mcp.source.digest)
assert.equal(planDigest(adapted.plan), current.mcp.planDigest)

const previousPlan = structuredClone(adapted.plan)
for (const relation of native.relations) {
  const link = previousPlan.links.find(link => link.name === adapted.identities.links[relation.uid])!
  const meaning = previousPlan.meanings.find(meaning => meaning.name === link.meaning)!
  const participants = relation.properties?.participants ?? [{ role: "source", uid: relation.from_uid }, { role: "target", uid: relation.to_uid }]
  const originalRoles = participants.map((entry: { role: string }) => entry.role)
  ;(meaning as any).roles = originalRoles.map((role: string) => meaning.roles.find(entry => entry.name === role)!)
  ;(link as any).participants = originalRoles.map((role: string) => link.participants.find(entry => entry.role === role)!)
  ;(meaning as any).description = relation.properties?.description === undefined
    ? `Declared KG relation: ${relation.type}`
    : `Declared KG relation: ${JSON.stringify({ type: relation.type, description: relation.properties.description })}`
}
Either.getOrThrow(composePlans(previousPlan.namespace, [previousPlan]))
assert.equal(planDigest(previousPlan), prior.mcp.planDigest, "v1 reconstruction must match historical digest")
assert.deepEqual(previousPlan.resources, adapted.plan.resources)
const bindings = (participants: typeof adapted.plan.links[number]["participants"]) =>
  Object.fromEntries([...participants].sort((a, b) => a.role < b.role ? -1 : a.role > b.role ? 1 : 0).map(entry => [entry.role, entry.resource]))
const relations = native.relations.map((relation: any) => {
  const beforeLink = previousPlan.links.find(link => link.name === adapted.identities.links[relation.uid])!
  const afterLink = adapted.plan.links.find(link => link.name === beforeLink.name)!
  const beforeMeaning = previousPlan.meanings.find(meaning => meaning.name === beforeLink.meaning)!
  const afterMeaning = adapted.plan.meanings.find(meaning => meaning.name === afterLink.meaning)!
  assert.deepEqual(bindings(beforeLink.participants), bindings(afterLink.participants))
  assert.deepEqual(beforeMeaning.contract, afterMeaning.contract)
  const definition = JSON.parse(afterMeaning.description)
  assert.deepEqual(definition.direction, { from_uid: relation.from_uid, to_uid: relation.to_uid })
  assert.equal(definition.type, relation.type)
  assert.equal(definition.description, relation.properties?.description ?? null)
  return { nativeRelationshipUid: relation.uid, direction: definition.direction, type: definition.type,
    descriptionBefore: beforeMeaning.description, definitionAfter: definition,
    roleBindingsUnchanged: true, contractUnchanged: true,
    rolesBefore: beforeMeaning.roles.map(role => role.name), rolesAfter: afterMeaning.roles.map(role => role.name),
    meaningDigestBefore: digestJson(beforeMeaning), meaningDigestAfter: digestJson(afterMeaning) }
})
const unaffectedSnapshots = []
for (const [directory, sourceName, reportName, hasPolicy] of [
  ["observations/2026-09-08T05-05-11-342Z", "game-workflow.usl", "dash-observation.json", false],
  ["observations/engineering-2026-09-08T05-35-28-534Z", "source.usl", "observation.json", true],
  ["observations/engineering-2026-09-08T05-42-29-113Z", "source.usl", "observation.json", true],
] as const) {
  const text = await readFile(`${directory}/${sourceName}`, "utf8")
  const compiled = Either.getOrThrow(compileSource(text))
  const savedPlan = JSON.parse(await readFile(`${directory}/plan.json`, "utf8"))
  const observation = Either.getOrThrow(validateObservation(JSON.parse(await readFile(`${directory}/${reportName}`, "utf8"))))
  assert.equal(planDigest(savedPlan), planDigest(compiled))
  assert.equal(observation.planDigest, planDigest(compiled))
  assert.equal(observation.sourceDigest, digestSource(text))
  const receipt = JSON.parse(await readFile(`${directory}/receipt.json`, "utf8"))
  for (const artifact of receipt.artifacts) assert.equal(digestSource(await readFile(`${directory}/${artifact.file}`, "utf8")), artifact.digest)
  const policy = hasPolicy ? prepareHswmAdapterArguments(JSON.parse(await readFile(`${directory}/hswm-input.json`, "utf8"))).policy : null
  if (policy) { assert.equal(policy.usl_plan_digest, observation.planDigest); assert.equal(policy.plan_digest, hswmDigest(compiled)); assert.equal(policy.source_digest, observation.sourceDigest) }
  unaffectedSnapshots.push({ directory, frontend: hasPolicy ? "USL_SOURCE_AND_GEIP" : "USL_SOURCE",
    sourceDigest: observation.sourceDigest, planDigest: observation.planDigest, observationDigest: observation.observationDigest,
    receiptArtifactsVerified: receipt.artifacts.length, hswmPolicy: policy === null ? null : { plan_digest: policy.plan_digest, usl_plan_digest: policy.usl_plan_digest, source_digest: policy.source_digest },
    verdict: "NO_PROPERTY_GRAPH_MIGRATION_REQUIRED", liveFreshness: "NOT_REOBSERVED" })
}
const hswmNativeSnapshots = []
for (const attempt of ["01", "04"]) {
  const path = `/home/lagyeongjun/CD/HSWM/results/raw/hswm_usl_relation_synthesis_2026-09-08/attempt-${attempt}.json`
  const text = await readFile(path, "utf8"), record = JSON.parse(text)
  const snapshot = record.snapshot_probe.first_snapshot
  const prepared = prepareHswmAdapterArguments(snapshot.prepared)
  assert.equal(snapshot.native.receipt.planDigest, planDigest(prepared.plan))
  assert.equal(snapshot.native.receipt.resultDigest, digestJson(snapshot.prepared))
  const observed = new Map([...prepared.report.resources.map(row => [row.name, row] as const), ...prepared.report.groundings.map(row => [`meaning:${row.name}`, row] as const)])
  for (const pin of prepared.policy.resources) {
    assert.equal(pin.content_hash, observed.get(pin.name)?.resolution?.contentHash)
    assert.equal(pin.resolved_locator, observed.get(pin.name)?.resolution?.resolvedLocator)
  }
  hswmNativeSnapshots.push({ path, artifactDigest: digestSource(text), status: record.status,
    sourcePinsManifestHash: record.source_pins_sha256, adapter: snapshot.native.adapter,
    nativeSourceDigest: snapshot.native.sourceDigest, namespace: prepared.plan.namespace,
    uslPlanDigest: prepared.policy.usl_plan_digest, hswmPlanDigest: prepared.policy.plan_digest,
    contentPinsChecked: prepared.policy.resources.length, internalBinding: "VALID",
    disposition: attempt === "01" ? "PRESERVE_HISTORICAL_V1" : "EXISTING_V2_PLAN_PINS_VALID",
    liveFreshness: "NOT_REOBSERVED" })
}
console.log(JSON.stringify({
  schema: "usl-property-graph-v2-migration-review/v1", reviewedAt: new Date().toISOString(),
  source: { path: sourcePath, digest: digestSource(source), sameNativeBytesAcrossVersions: true },
  historical: { artifact: priorPath, artifactDigest: digestSource(priorText), adapter: prior.mcp.source.adapter,
    planReconstruction: "MATCHED_RECORDED_PLAN_DIGEST", planDigest: planDigest(previousPlan), meaningsDigest: digestJson(previousPlan.meanings),
    hswmPlanDigest: hswmDigest(previousPlan) },
  current: { artifact: currentPath, artifactDigest: digestSource(currentText), adapter: adapted.source.adapter,
    planDigest: planDigest(adapted.plan), meaningsDigest: digestJson(adapted.plan.meanings), hswmPlanDigest: hswmDigest(adapted.plan) },
  resourcesUnchanged: true, relations, unaffectedSnapshots, hswmNativeSnapshots,
  disposition: "V2_TRANSFORMATION_REVIEWED_EXISTING_V2_RECEIPT_MATCHES",
  policyUpdate: { applied: false, storedNativeHswmPolicy: null,
    note: "For the game.adapter MCP fixture, these calculated identities are a review result, not a newly issued HSWM policy. Its receipt has no HSWM pins. Separately, HSWM native study snapshots and their stored policies are reviewed in hswmNativeSnapshots." },
  endpointReads: 0, semanticTruth: "NOT_EVALUATED",
}, null, 2))
