/** Reproduce portable handoff artifacts from archived, explicitly executed learner outputs. */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { contractDigest } from "../src/contract-core.js"
import { digestSource } from "../src/language/digest.js"
import { ruleWeightReviewFixture } from "../examples/rule-weight-review-fixture.js"
import { prepareRuleWeightReview, completeRuleWeightReview, ruleWeightReviewSchema, ruleWeightReviewHostSchema } from "../src/addons/rule-weight-review.js"

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), check = process.argv.includes("--check")
if (process.argv.slice(2).some(arg => arg !== "--check")) throw new Error("usage: build-rule-weight-review.ts [--check]")
const folder = "examples/fixtures/rule-weight-review", json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"
const { prior, files, mapping } = ruleWeightReviewFixture()
// Do not overwrite dataset/evidence inputs underneath an archived learner report.
for (const [name, raw] of Object.entries(files)) {
  if (await readFile(resolve(root, folder, name), "utf8") !== raw) throw new Error(`synthetic source changed: ${name}; explicitly regenerate inputs and rerun the learner`)
}
const handoff = { schema: "usl-rule-weight-review/v1" as const, id: "urn:example:usl-rule-weight-review", version: "1",
  reviewedAt: "2026-10-03T00:40:00Z", recipe: { policy: prior.policy, observations: prior.observations,
    evidence: prior.evidence, proposalInput: prior.proposalInput },
  artifacts: { dataset: "dataset.json", report: "report.json", baselineSource: "baseline-policy.json", candidateSource: "candidate-policy.json" }, mapping }
const artifacts = Object.fromEntries(await Promise.all(Object.entries(handoff.artifacts).map(async ([key, name]) => [key, await readFile(resolve(root, folder, name), "utf8")]))) as Record<keyof typeof handoff.artifacts, string>
const host = { expectedHandoffDigest: contractDigest(handoff), artifactSha256: Object.fromEntries(Object.entries(artifacts).map(([key, raw]) => [key, digestSource(raw)])),
  evaluationContext: prior.evaluationContext, evidenceHost: prior.host }
const prepared = prepareRuleWeightReview(handoff, host, artifacts)
const replay = JSON.parse(await readFile(resolve(root, folder, "replay.json"), "utf8"))
const review = completeRuleWeightReview(prepared, replay)
const outputs = {
  [`${folder}/handoff.json`]: json(handoff), [`${folder}/host.json`]: json(host), [`${folder}/review.json`]: json(review),
  "schemas/rule-weight-evidence/review.schema.json": json(z.toJSONSchema(ruleWeightReviewSchema)),
  "schemas/rule-weight-evidence/review-host.schema.json": json(z.toJSONSchema(ruleWeightReviewHostSchema)),
}
for (const [path, raw] of Object.entries(outputs)) {
  const file = resolve(root, path)
  if (check) { if (await readFile(file, "utf8") !== raw) throw new Error(`review artifact differs: ${path}`) }
  else { await mkdir(dirname(file), { recursive: true }); await writeFile(file, raw) }
}
console.log(json({ mode: check ? "ARTIFACTS_CHECKED" : "ARTIFACTS_BUILT", dataKind: review.dataKind,
  reviewStatus: review.reviewStatus, disposition: review.disposition, learnerExecution: "ARCHIVED_REPORT_CHECK_ONLY" }))
