import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { test } from "node:test"
import { Effect, Either } from "effect"
import { DEFAULT_USL_POLICY, executeUslOperation } from "../src/application.js"
import { runPlatformCommand } from "../src/cli-platform.js"
import { digestJson } from "../src/language/digest.js"
import { adaptPropertyGraph } from "../src/integrations/property-graph.js"
import { formatLocator } from "../src/locator.js"
import { temporary } from "./fixtures.js"

type Envelope = {
  source: { adapter: string; digest: string }
  identities: { resources: Record<string, string>; links: Record<string, string> }
  result: Record<string, unknown>
  receipt: { sourceDigest: string; planDigest: string; resultDigest: string; digest: string }
}

const raw = JSON.stringify({
  nodes: [
    { uid: "code", properties: { locator: "file://game/src/dash.ts" } },
    { uid: "spec", properties: { locator: "https://example.test/dash" } },
    { uid: "unselected", properties: { locator: "file://game/src/unused.ts" } },
  ],
  relations: [{ uid: "dash-implements", from_uid: "code", to_uid: "spec", type: "IMPLEMENTS", properties: {
    description: "dash code implements the specification",
    participants: [{ role: "code", uid: "code" }, { role: "specification", uid: "spec" }],
  }}],
})

const refreshedReceipt = (envelope: Envelope): Envelope => {
  const receipt = {
    sourceDigest: envelope.receipt.sourceDigest,
    planDigest: envelope.receipt.planDigest,
    resultDigest: digestJson(envelope.result),
  }
  return { ...envelope, receipt: { ...receipt, digest: digestJson({ source: envelope.source, identities: envelope.identities, ...receipt }) } }
}

test("CLI accepts a complete native observation envelope and rejects recomputed forged receipts", async (t) => {
  const adapted = Either.getOrThrow(adaptPropertyGraph(raw, { namespace: "envelope", kgSource: "game" }))
  const envelope = await executeUslOperation("observe", {
    connection: "game", options: { links: ["dash-implements"] },
  }, {
    ...DEFAULT_USL_POLICY,
    allowedLocators: adapted.plan.resources.map(resource => formatLocator(resource.locator)),
    getConnection: async () => adapted,
    resolvers: { resolve: locator => Effect.succeed({ locator, resolvedLocator: formatLocator(locator), contentHash: "a".repeat(64), resolvedAt: "2026-09-08T00:00:00.000Z", guaranteeLevel: "pure" as const, matchCount: 1 }) },
  }) as Envelope
  const dir = await temporary(t), valid = path.join(dir, "valid.json")
  await fs.writeFile(valid, JSON.stringify(envelope))

  assert.equal(await runPlatformCommand(["validate-observation", "--report", valid]), true)
  assert.equal(await runPlatformCommand(["compare", "--before", valid, "--after", valid]), true)
  assert.equal((await executeUslOperation("validate_observation", { report: envelope.result }) as { valid: boolean }).valid, true)

  // A report may select a strict subset of the native graph. Extra identity
  // mappings are optional, but every selected resource/link must remain mapped.
  const subsetMap = structuredClone(envelope)
  delete subsetMap.identities.resources.unselected
  const missingSelectedMap = structuredClone(envelope)
  delete missingSelectedMap.identities.resources.code

  const receiptChanged = structuredClone(envelope)
  receiptChanged.receipt.sourceDigest = "sha256:" + "b".repeat(64)
  const planChanged = structuredClone(envelope)
  planChanged.receipt.planDigest = "sha256:" + "c".repeat(64)
  const resultChanged = structuredClone(envelope)
  resultChanged.result.status = "UNRESOLVED"
  const { observationDigest: _, ...alteredPayload } = resultChanged.result
  resultChanged.result.observationDigest = digestJson(alteredPayload)
  const subset = path.join(dir, "subset-map.json")
  await fs.writeFile(subset, JSON.stringify(refreshedReceipt(subsetMap)))
  assert.equal(await runPlatformCommand(["validate-observation", "--report", subset]), true)

  for (const [name, forged] of Object.entries({ missingSelectedMap, receiptChanged, planChanged, resultChanged })) {
    const file = path.join(dir, `${name}.json`)
    await fs.writeFile(file, JSON.stringify(refreshedReceipt(forged)))
    await assert.rejects(runPlatformCommand(["validate-observation", "--report", file]))
    await assert.rejects(runPlatformCommand(["compare", "--before", valid, "--after", file]))
  }
})
