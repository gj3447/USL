import { promises as fs } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as os from "node:os"
import * as path from "node:path"
import { Effect, Either, Layer } from "effect"
import { compileSource, toSemanticBundle } from "../src/language/index.js"
import { sha256, Resolvers } from "../src/resolve.js"
import { pierce, audit, rebind } from "../src/pierce.js"
import { toBundle } from "../src/project.js"
import { validateRecords } from "../src/validation.js"
import { readRecords, writeRecords, writeTextAtomic } from "../src/storage.js"
import type { UslRecord } from "../src/domain.js"

const run = promisify(execFile)
const results: Array<Record<string, unknown>> = []
const record: UslRecord = {
  link_id: "audit-probe", semantic_relation: "IMPLEMENTS", from_endpoint_kind: "url", from_locator: "https://fixture.invalid/code", to_endpoint_kind: "url", to_locator: "https://fixture.invalid/spec",
  direction: "directed", resolved_at_from: null, resolved_at_to: null, resolved_locator_from: null, resolved_locator_to: null,
  pierced_at: "2026-09-08T00:00:00.000Z", drift_detected_at: null, drift_score: 0, content_hash_from: null, content_hash_to: null,
  confidence: "EXTRACTED", guarantee_level: "trust_host", status: "RESOLVES", provenance_actor: "audit", provenance_tool_version: "usl/0.3.0", provenance_command: "fixture", provenance_date: "2026-09-08", hswm_owner_ref: null,
}
const projection = { bundle_uid: "bundle:adversarial-probe", title: "Adversarial fixture", trigger: { user_utterance_verbatim: "isolated review fixture", utterance_date: "2026-09-08", tool: "audit" }, evidence: [] }
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "usl-audit-storage-"))
try {
  const sourceA = `usl "0.1"; namespace "audit.source"; resource a = "https://fixture.invalid/a"; resource b = "https://fixture.invalid/b"; meaning implements(a: url, b: url) = "A implements B"; link l = implements(a: a, b: b);`
  const sourceB = sourceA.replace("A implements B", "A contradicts B")
  const planA = Either.getOrThrow(compileSource(sourceA))
  const output = toSemanticBundle(planA, { ...projection, source: { name: "opposite.usl", text: sourceB } })
  const meaning = Either.isRight(output) ? output.right.nodes.find((n) => n.properties.name === "implements") : undefined
  results.push({ id: "projection-source-mismatch", outcome: meaning?.properties.source_sha256 === sha256(sourceB) && meaning?.properties.description === "A implements B" ? "CONFIRMED" : "RESISTED", expected: "reject source text that compiles to another plan", actual: { accepted: Either.isRight(output), description: meaning?.properties.description, attributedSourceDigest: meaning?.properties.source_sha256, suppliedOppositeSourceDigest: sha256(sourceB) } })

  const validated = validateRecords([record])
  const properties = toBundle(validated, projection).nodes[0]!.properties as Record<string, unknown>
  results.push({ id: "legacy-unresolved-record-canonical", outcome: properties.canonical_scope === "CANONICAL" && properties.review_required === false ? "CONFIRMED" : "RESISTED", expected: "RESOLVES requires complete successful baseline data before canonical projection", actual: { validationAccepted: true, status: properties.status, contentHashFrom: properties.content_hash_from, resolvedAtFrom: properties.resolved_at_from, canonicalScope: properties.canonical_scope, reviewRequired: properties.review_required } })

  const multiple = Layer.succeed(Resolvers, { resolve: (locator) => Effect.succeed({ locator, resolvedLocator: locator.kind === "url" ? locator.href : "https://fixture.invalid/unused", contentHash: "same", resolvedAt: "2026-09-08T00:00:00.000Z", guaranteeLevel: "pure" as const, matchCount: 2 }) })
  const pierced = await Effect.runPromise(pierce({ link_id: "multiple", semantic_relation: "R", from: record.from_locator, to: record.to_locator }).pipe(Effect.provide(multiple)))
  const audited = await Effect.runPromise(audit(pierced.record).pipe(Effect.provide(multiple)))
  const rebound = await Effect.runPromise(Effect.either(rebind(pierced.record)).pipe(Effect.provide(multiple)))
  results.push({ id: "legacy-multiple-matches-resolve", outcome: pierced.record.status === "RESOLVES" && audited.after === "RESOLVES" && Either.isRight(rebound) ? "CONFIRMED" : "RESISTED", expected: "matchCount != 1 is AMBIGUOUS and cannot become a rebind baseline", actual: { matchCount: 2, pierceStatus: pierced.record.status, auditStatus: audited.after, rebindAccepted: Either.isRight(rebound) }, scope: "injected conforming Resolution service; live KG resolver rejects multiple matches itself" })

  const recordsPath = path.join(dir, "records.json")
  await fs.writeFile(recordsPath, "[]\n")
  for (const inputKind of ["utterance", "anchors"] as const) {
    const utterance = path.join(dir, `request-${inputKind}.txt`)
    const anchors = path.join(dir, `anchors-${inputKind}.json`)
    await fs.writeFile(utterance, "KEEP THIS ORIGINAL REQUEST\n")
    await fs.writeFile(anchors, "{}\n")
    const target = inputKind === "utterance" ? utterance : anchors
    const before = await fs.readFile(target, "utf8")
    const command = await run(process.execPath, ["--import", "tsx", "src/cli.ts", "project", "--records", recordsPath, "--bundle-uid", "bundle:audit:cli", "--utterance-file", utterance, "--anchors", anchors, "--out", target], { cwd: process.cwd(), timeout: 10000 })
    const after = await fs.readFile(target, "utf8")
    results.push({ id: `legacy-project-overwrites-${inputKind}`, outcome: before !== after ? "CONFIRMED" : "RESISTED", expected: "reject --out equal to any input path", actual: { exitCode: 0, inputReplaced: before !== after, replacementSchema: JSON.parse(after).schema_version, stdout: command.stdout.trim() } })
  }

  const stale = await readRecords(recordsPath)
  await fs.writeFile(recordsPath, "[ ]\n")
  let staleBlocked = false
  try { await writeRecords(stale, []) } catch { staleBlocked = true }
  const target = path.join(dir, "target.txt"), symlink = path.join(dir, "alias.txt")
  await fs.writeFile(target, "UNCHANGED\n"); await fs.symlink(target, symlink)
  let symlinkBlocked = false
  try { await writeTextAtomic(symlink, "REPLACEMENT\n") } catch { symlinkBlocked = true }
  results.push({ id: "storage-stale-and-symlink-output", outcome: staleBlocked && symlinkBlocked && await fs.readFile(target, "utf8") === "UNCHANGED\n" ? "RESISTED" : "CONFIRMED", expected: "reject stale cooperative snapshot and direct symlink output", actual: { staleBlocked, symlinkBlocked, targetPreserved: await fs.readFile(target, "utf8") === "UNCHANGED\n" } })
} finally { await fs.rm(dir, { recursive: true, force: true }) }
await fs.writeFile("audit/storage-projection-results.json", JSON.stringify({ schema: "usl-adversarial-probes/v1", results }, null, 2) + "\n")
console.log(JSON.stringify(results.map(({ id, outcome }) => ({ id, outcome })), null, 2))
