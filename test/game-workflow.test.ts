import { test } from "node:test"
import assert from "node:assert/strict"
import { runGameWorkflow } from "../examples/game-workflow.js"

test("synthetic game workflow keeps observations attributable and scopes reads to the chosen link", async () => {
  const artifact = await runGameWorkflow()

  assert.equal(artifact.schema, "usl-game-workflow-benchmark/v1")
  assert.equal(artifact.label, "synthetic_fixture_local_reads")
  assert.ok(artifact.methods.repository_scan.resolverCalls > artifact.methods.targeted_link_lookup.resolverCalls)
  assert.equal(artifact.counters.referenceLookupReads, artifact.methods.repository_scan.resolverCalls)
  assert.equal(artifact.counters.targetedLookupReads, artifact.methods.targeted_link_lookup.resolverCalls)
  assert.equal(artifact.counters.unnecessaryRechecksAvoided, 2)
  assert.match(artifact.observedMeaningVersions.baseline.planDigest, /^sha256:[a-f0-9]{64}$/)
  assert.match(artifact.observedMeaningVersions.baseline.meaningsDigest, /^sha256:[a-f0-9]{64}$/)
  assert.equal(artifact.observedMeaningVersions.baseline.links[0]?.name, "dash_behavior")

  const content = artifact.changes.evidenceContentEdit.links.find((link) => link.name === "dash_behavior")!
  const semantic = artifact.changes.semanticReversal.links.find((link) => link.name === "dash_behavior")!
  const address = artifact.changes.addressMove.links.find((link) => link.name === "dash_behavior")!
  assert.ok(content.contentChanged.length > 0)
  assert.equal(semantic.semanticContractChanged, true)
  assert.ok(address.addressChanged.length > 0)
  assert.equal(artifact.counters.staleEvidenceCaught, 1)

  for (const observation of [artifact.changes.evidenceContentEdit, artifact.changes.semanticReversal, artifact.changes.addressMove]) {
    assert.equal(observation.schema, "usl-program-observation-comparison/v1")
    assert.match(observation.previousPlanDigest, /^sha256:[a-f0-9]{64}$/)
    assert.match(observation.currentPlanDigest, /^sha256:[a-f0-9]{64}$/)
  }
})
