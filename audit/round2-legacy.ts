// Local-only adversarial probes for the legacy JSON record lifecycle.
// Run: node --import tsx audit/round2-legacy.ts
import { promises as fs } from "node:fs"
import { Effect, Layer } from "effect"
import type { Locator, Resolution, UslRecord } from "../src/domain.js"
import { formatLocator } from "../src/locator.js"
import { audit, pierce, rebind } from "../src/pierce.js"
import { toBundle } from "../src/project.js"
import { Resolvers } from "../src/resolve.js"
import { validateRecords } from "../src/validation.js"

const options = { bundle_uid: "bundle:audit-round2:v1", title: "round2", trigger: { user_utterance_verbatim: "audit", utterance_date: "2026-09-08", tool: "audit" }, evidence: [] }
const record = (over: Partial<UslRecord> = {}): UslRecord => ({
  link_id: "audit-link", semantic_relation: "REFERENCES", from_endpoint_kind: "kg", from_locator: "kg://canonical-neo4j/sym:Concept:original",
  to_endpoint_kind: "url", to_locator: "https://example.test/document", direction: "directed",
  resolved_at_from: "observed-from", resolved_at_to: "observed-to",
  resolved_locator_from: "kg://canonical-neo4j/sym:Concept:original", resolved_locator_to: "https://example.test/document",
  pierced_at: "pierced", audited_at: null, drift_detected_at: null, drift_score: 0,
  content_hash_from: "a".repeat(64), content_hash_to: "b".repeat(64), confidence: "EXTRACTED", guarantee_level: "trust_host", status: "RESOLVES",
  provenance_actor: "audit", provenance_tool_version: "usl/audit", provenance_command: "audit", provenance_date: "2026-09-08", hswm_owner_ref: null,
  ...over,
})

const resolution = (locator: Locator, matchCount = 1): Resolution => ({ locator, resolvedLocator: formatLocator(locator), contentHash: "c".repeat(64), resolvedAt: "2026-09-08T00:00:00.000Z", guaranteeLevel: "pure", matchCount })
const run = <A, E>(effect: Effect.Effect<A, E, Resolvers>, matchCount = 1) =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.succeed(Resolvers, { resolve: (locator: Locator) => Effect.succeed(resolution(locator, matchCount)) }))))

const outcome = (id: string, fn: () => unknown) => {
  try { return { id, passed: true, actual: fn() } }
  catch (error) { return { id, passed: false, error: error instanceof Error ? error.message : String(error) } }
}

const forgedKg = record({ content_hash_from: "c".repeat(64), content_hash_to: "c".repeat(64), resolved_locator_from: "kg://canonical-neo4j/sym:Concept:substituted" })
const forgedKgBundle = toBundle([forgedKg], options)
const forgedProperties = forgedKgBundle.nodes[0]!.properties as Record<string, unknown>

const unconstrainedHash = record({ content_hash_from: "operator-asserted-not-a-sha256" })
const unconstrainedHashProperties = (toBundle([unconstrainedHash], options).nodes[0]!.properties as Record<string, unknown>)

const incomplete = record({ content_hash_from: null, resolved_locator_from: null, resolved_at_from: null })
const getterRecord = incomplete as UslRecord & { status: UslRecord["status"] }
let statusReads = 0
Object.defineProperty(getterRecord, "status", { enumerable: true, get: () => ++statusReads === 1 ? "DRIFT" : "RESOLVES" })

const main = async () => {
  const auditedForged = await run(audit(forgedKg))
  const reboundForged = await run(rebind(forgedKg))
  const oldF05 = await run(pierce({ link_id: "match-count-two", semantic_relation: "REFERENCES", from: forgedKg.from_locator, to: forgedKg.to_locator }), 2)
  const results = [
    {
      id: "L2-01-same-kind-kg-identity-substitution",
      severity: "MEDIUM",
      precondition: "An untrusted legacy JSON record reaches validateRecords()/toBundle() without a fresh resolver observation.",
      source: ["src/validation.ts:35-47", "src/project.ts:28-61"],
      actual: { validated: validateRecords([forgedKg]).length === 1, original: forgedKg.from_locator, claimedResolved: forgedKg.resolved_locator_from, canonicalScope: forgedProperties.canonical_scope, reviewRequired: forgedProperties.review_required },
      verdict: "REPRODUCED",
    },
    {
      id: "L2-02-unconstrained-content-hash-claim",
      severity: "INFO",
      precondition: "The legacy UslRecord schema deliberately encodes content_hash as an opaque string; neither a SHA-shaped string nor its syntax authenticates evidence.",
      source: ["src/domain.ts:75-76", "src/validation.ts:33-47", "src/project.ts:49-61"],
      actual: { acceptedHash: unconstrainedHash.content_hash_from, canonicalScope: unconstrainedHashProperties.canonical_scope, reviewRequired: unconstrainedHashProperties.review_required },
      verdict: "LIMITATION",
    },
    {
      id: "L2-03-in-memory-status-getter-time-of-check-time-of-use",
      severity: "LOW",
      precondition: "A same-process JavaScript caller passes an accessor-bearing object directly to toBundle(); JSON.parse input cannot contain accessors.",
      source: ["src/project.ts:28-31", "src/project.ts:43-61"],
      actual: outcome("getter", () => {
        const b = toBundle([getterRecord], options)
        const p = b.nodes[0]!.properties as Record<string, unknown>
        return { statusReads, projectedStatus: p.status, canonicalScope: p.canonical_scope, reviewRequired: p.review_required, baselineWasIncomplete: true }
      }),
      verdict: "REPRODUCED",
    },
    {
      id: "L2-D01-audit-detects-forged-resolved-identity",
      severity: "DEFENSE",
      source: ["src/pierce.ts:95-109"],
      actual: { after: auditedForged.after, driftType: auditedForged.drift_type, relocatedEnds: auditedForged.relocated_ends, updatedStatus: auditedForged.updated.status },
      verdict: auditedForged.after === "DRIFT" && auditedForged.drift_type === "LabelRot" && auditedForged.relocated_ends.includes("from") ? "RESISTED" : "FAILED",
    },
    {
      id: "L2-D02-rebind-replaces-forged-baseline",
      severity: "DEFENSE",
      source: ["src/pierce.ts:126-130"],
      actual: { status: reboundForged.record.status, fromResolved: reboundForged.record.resolved_locator_from, inheritedForgedValue: reboundForged.record.resolved_locator_from === forgedKg.resolved_locator_from },
      verdict: reboundForged.record.status === "RESOLVES" && reboundForged.record.resolved_locator_from === forgedKg.from_locator ? "RESISTED" : "FAILED",
    },
    {
      id: "L2-KNOWN-F05-match-count-not-enforced-in-legacy-pierce",
      severity: "KNOWN",
      source: ["src/pierce.ts:27-40"],
      actual: { resolverMatchCount: 2, recordStatus: oldF05.record.status, confidence: oldF05.record.confidence },
      verdict: oldF05.record.status === "RESOLVES" ? "RECONFIRMED" : "CHANGED",
    },
  ]
  await fs.writeFile(new URL("./round2-legacy-results.json", import.meta.url), JSON.stringify({ schema: "usl-adversarial-round2-legacy/v1", generatedAt: new Date().toISOString(), isolation: "in-process deterministic fake resolver only; no network, filesystem target, or KG writes", results }, null, 2) + "\n")
  console.log(JSON.stringify(results, null, 2))
}

await main()
