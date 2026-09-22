/** Evidence-qualified engineering claims over existing resource graphs; no external product verdicts. */
import { z } from "zod"
import { Either } from "effect"
import { contractDigest, contractHash, contractSnapshot, contractText, freezeContract, uniqueContractIds } from "./contract-core.js"
import { parseResourceGraph, type ResourceGraph } from "./integrations/resource-graph.js"
import type { DomainProfile } from "./domain-profile.js"

const localPath = z.string().regex(/^(?:(?:src|test|scripts|schemas)\/[A-Za-z0-9._/-]+|package(?:-lock)?\.json|tsconfig\.json)$/).refine(s => !s.split("/").includes(".."))
export const engineeringCatalogSchema = z.strictObject({
  schema: z.literal("usl-engineering-review/v1"), reviewedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  authority: z.literal("SECONDARY_AI"), upstreamExecution: z.literal("NOT_TESTED"),
  controls: z.array(z.strictObject({ id: z.string().regex(/^C\d{2}$/), title: contractText, scope: contractText,
    implementation: z.array(localPath).min(1), checks: z.array(contractText).min(1), residual: contractText })).min(1).max(128),
  technologies: z.array(z.strictObject({ id: z.string().regex(/^S\d{2}$/), title: contractText,
    sources: z.array(z.string().url()).min(1).max(8), upstreamCapability: contractText,
    classification: z.enum(["SCOPE_BOUNDARY", "INTEGRATION_HAZARD"]), limitation: contractText,
    requirement: contractText, attack: contractText, expected: contractText,
    controls: z.array(z.string().regex(/^C\d{2}$/)).min(1).max(8), residual: contractText,
  })).min(1).max(256),
})
export type EngineeringCatalog = z.infer<typeof engineeringCatalogSchema>
export const parseEngineeringCatalog = (input: unknown): EngineeringCatalog => {
  const catalog = engineeringCatalogSchema.parse(contractSnapshot(input))
  uniqueContractIds(catalog.technologies.map(t => t.id), "technology IDs")
  uniqueContractIds(catalog.controls.map(c => c.id), "control IDs")
  const ids = new Set(catalog.controls.map(c => c.id)), checks = new Set<string>()
  for (const c of catalog.controls) {
    uniqueContractIds(c.implementation, "implementation paths"); uniqueContractIds(c.checks, "control checks")
    for (const check of c.checks) { if (checks.has(check)) throw new Error(`check ${check} has multiple owners`); checks.add(check) }
  }
  for (const technology of catalog.technologies) {
    uniqueContractIds(technology.controls, "technology controls"); uniqueContractIds(technology.sources, "source URLs")
    for (const id of technology.controls) if (!ids.has(id)) throw new Error(`unknown control ${id}`)
  }
  return freezeContract(catalog)
}
export const engineeringReceiptSchema = z.strictObject({
  schema: z.literal("usl-engineering-receipt/v1"), runId: contractText, startedAt: z.string().datetime(), finishedAt: z.string().datetime(),
  catalogDigest: contractHash, sourceRoot: contractText,
  sourceDigests: z.record(localPath, contractHash),
  checks: z.array(z.strictObject({ id: contractText, control: contractText, status: z.enum(["PASS", "FAIL"]), detail: contractText })).min(1),
  scope: z.literal("LOCAL_USL_COUNTEREXAMPLES"), upstreamExecution: z.literal("NOT_TESTED"), receiptDigest: contractHash,
})
export type EngineeringReceipt = z.infer<typeof engineeringReceiptSchema>
export const reviewControlStatus = (catalogInput: EngineeringCatalog, receiptInput: unknown, currentSourceDigests: Readonly<Record<string, string>>) => {
  const catalog = parseEngineeringCatalog(catalogInput), receipt = engineeringReceiptSchema.parse(contractSnapshot(receiptInput))
  const current = z.record(localPath, contractHash).parse(contractSnapshot(currentSourceDigests))
  const { receiptDigest, ...body } = receipt
  if (contractDigest(body) !== receiptDigest) throw new Error("engineering receipt digest mismatch")
  uniqueContractIds(receipt.checks.map(c => c.id), "receipt check IDs")
  const checks = new Map(receipt.checks.map(c => [c.id, c]))
  const declared = new Set(catalog.controls.flatMap(c => c.checks))
  for (const check of receipt.checks) if (!declared.has(check.id)) throw new Error(`undeclared check ${check.id}`)
  return freezeContract(catalog.controls.map(control => {
    // Always pin the replay code and graph compiler as well as the implementation under test.
    const paths = [...Object.keys(receipt.sourceDigests), ...control.implementation, "test/engineering-adversarial-cases.ts", "src/engineering-review.ts", "scripts/build-engineering-review.ts", "package-lock.json", "package.json", "tsconfig.json", "src/contract-core.ts"]
    const fresh = receipt.catalogDigest === contractDigest(catalog) && paths.every(path => current[path] !== undefined && current[path] === receipt.sourceDigests[path])
    const results = control.checks.map(id => checks.get(id))
    const status = !fresh ? "STALE" : results.some(r => !r || r.control !== control.id) ? "UNVERIFIED"
      : results.some(r => r!.status === "FAIL") ? "LOCAL_CHECKS_FAILED" : "LOCAL_CHECKS_PASS"
    return { id: control.id, status, residual: control.residual, verification: "HOST_REPORTED_LOCAL_TESTS", semanticTruth: "NOT_EVALUATED" }
  }))
}
export const engineeringReviewProfile: DomainProfile = {
  schema: "usl-domain-profile/v1", id: "urn:usl:engineering:review-profile", version: "1", closedMeanings: true,
  meanings: [
    { id: "assesses", roles: [["technology", "Technology"], ["limitation", "Limitation"], ["requirement", "Requirement"], ["attack", "AdversarialCase"]] },
    { id: "mitigates", roles: [["requirement", "Requirement"], ["control", "Control"]] },
    { id: "implemented_by", roles: [["control", "Control"], ["implementation", "Implementation"]] },
    { id: "checked_by", roles: [["control", "Control"], ["check", "LocalCheck"], ["run", "VerificationRun"]] },
    { id: "cites", roles: [["limitation", "Limitation"], ["source", "Source"]] },
  ].map(rule => ({ id: `urn:usl:engineering:${rule.id}`, allowExtraRoles: false,
    roles: rule.roles.map(([role, type]) => ({ role: role!, required: true, types: [`urn:usl:engineering:${type}`], metadata: [] })) })),
}
export const buildEngineeringReviewGraph = (catalogInput: EngineeringCatalog, receiptInput: EngineeringReceipt, currentSourceDigests: Readonly<Record<string, string>>): ResourceGraph => {
  const catalog = parseEngineeringCatalog(catalogInput), receipt = engineeringReceiptSchema.parse(contractSnapshot(receiptInput))
  const statuses = reviewControlStatus(catalog, receipt, currentSourceDigests), root = receipt.sourceRoot.replace(/\/$/, "")
  const resources: ResourceGraph["resources"] = [], links: ResourceGraph["links"] = [], seen = new Set<string>()
  const local = (path: string) => `${root}/${path}`
  const catalogLocator = local("research/engineering/catalog.json"), receiptLocator = local("research/engineering/receipt.json")
  const add = (id: string, type: string, locator: string, metadata: unknown) => {
    if (seen.has(id)) return
    seen.add(id); resources.push({ id, types: [`urn:usl:engineering:${type}`], locator, metadata: z.record(z.string(), z.json()).parse(metadata) })
  }
  const link = (id: string, meaning: string, participants: Record<string, string>) => links.push({ id, meaning: `urn:usl:engineering:${meaning}`,
    participants: Object.entries(participants).map(([role, resource]) => ({ role, resource })) })
  add("review:catalog", "Source", catalogLocator, { authority: catalog.authority, digest: contractDigest(catalog), upstreamExecution: "NOT_TESTED" })
  add("review:run", "VerificationRun", receiptLocator, { runId: receipt.runId, scope: receipt.scope, receiptDigest: receipt.receiptDigest,
    verification: "HOST_REPORTED_LOCAL_TESTS", upstreamExecution: "NOT_TESTED", startedAt: receipt.startedAt, finishedAt: receipt.finishedAt })
  add("review:agent", "Agent", catalogLocator, { kind: "AI_REVIEW", authority: "SECONDARY_AI" })
  for (const control of catalog.controls) {
    add(`control:${control.id}`, "Control", catalogLocator, { ...control, assessment: statuses.find(s => s.id === control.id)! })
    for (const file of control.implementation) {
      add(`implementation:${file}`, "Implementation", local(file), { path: file, sourceDigest: currentSourceDigests[file] ?? null })
      link(`implementation:${control.id}:${file}`, "implemented_by", { control: `control:${control.id}`, implementation: `implementation:${file}` })
    }
    for (const id of control.checks) {
      const check = receipt.checks.find(c => c.id === id)
      add(`check:${id}`, "LocalCheck", receiptLocator, { id, status: check?.status ?? "NOT_RUN", applicability: statuses.find(s => s.id === control.id)!.status,
        scope: "LOCAL_USL_COUNTEREXAMPLES", detail: check?.detail ?? "No receipt" })
      link(`check:${control.id}:${id}`, "checked_by", { control: `control:${control.id}`, check: `check:${id}`, run: "review:run" })
    }
  }
  for (const t of catalog.technologies) {
    add(`technology:${t.id}`, "Technology", t.sources[0]!, { title: t.title, upstreamCapability: t.upstreamCapability })
    add(`limitation:${t.id}`, "Limitation", catalogLocator, { classification: t.classification, claim: t.limitation, authority: "SECONDARY_AI",
      upstreamExecution: "NOT_TESTED", residual: t.residual })
    add(`requirement:${t.id}`, "Requirement", catalogLocator, { description: t.requirement, remainingLimits: t.residual })
    add(`attack:${t.id}`, "AdversarialCase", catalogLocator, { scenario: t.attack, expected: t.expected, executionScope: "LOCAL_MODEL_VIA_LINKED_CONTROLS" })
    link(`assessment:${t.id}`, "assesses", { technology: `technology:${t.id}`, limitation: `limitation:${t.id}`, requirement: `requirement:${t.id}`, attack: `attack:${t.id}` })
    for (const c of t.controls) link(`mitigation:${t.id}:${c}`, "mitigates", { requirement: `requirement:${t.id}`, control: `control:${c}` })
    for (const url of t.sources) {
      const id = `source:${url}`; add(id, "Source", url, { url, consultedAt: catalog.reviewedAt, supports: "UPSTREAM_SCOPE_NOT_EXTERNAL_FAILURE_TEST" })
      link(`citation:${t.id}:${url}`, "cites", { limitation: `limitation:${t.id}`, source: id })
    }
  }
  return Either.getOrThrow(parseResourceGraph(JSON.stringify({ schema: "usl-resource-graph/v1", resources, links,
    meanings: engineeringReviewProfile.meanings.map(m => ({ id: m.id, description: `${m.id}: declared engineering traceability; no truth, authorization, or upstream failure inference.` })),
    provenance: { sources: ["review:catalog"], activity: "review:run", agent: "review:agent" },
  })))
}
