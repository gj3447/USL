import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { contractDigest } from "../src/contract-core.js"
import { dashboardContext, dashboardPolicy, dashboardTarget, observeDashboardTarget } from "../examples/rule-policy-fixture.js"
import { ruleWeightEvidenceFixture } from "../examples/rule-weight-evidence-fixture.js"
import { temporary } from "./fixtures.js"

const root = fileURLToPath(new URL("..", import.meta.url))
const source = join(root, "examples/fixtures/rule-weight-review")
const run = promisify(execFile)
const sha256 = async (file: string) => `sha256:${createHash("sha256").update(await readFile(file)).digest("hex")}`

const command = async (args: readonly string[]) => {
  try {
    const result = await run(process.execPath, ["--import", "tsx", "scripts/rule-weight-review.ts", ...args], { cwd: root, timeout: 40_000, maxBuffer: 5 * 1024 * 1024 })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const value = error as { code?: number; stdout?: string; stderr?: string }
    return { code: typeof value.code === "number" ? value.code : 1, stdout: value.stdout ?? "", stderr: value.stderr ?? "" }
  }
}

const setup = async (t: Parameters<typeof temporary>[0], mode = "ok") => {
  const dir = await temporary(t)
  for (const name of ["dataset.json", "report.json", "replay.json", "baseline-policy.json", "candidate-policy.json", "protocol.json", "outcomes.json"] as const) await cp(join(source, name), join(dir, name))
  const marker = join(dir, "learner-called")
  const learner = join(dir, "learner.mjs")
  const replayFixture = await readFile(join(dir, "replay.json"), "utf8")
  const dataset = JSON.parse(await readFile(join(dir, "dataset.json"), "utf8"))
  const validationFixture = JSON.stringify({ schema: "hswm-w-learning/v1", status: "VALID", inputDigest: createHash("sha256").update(JSON.stringify(dataset)).digest("hex"), sourceBytesVerified: true, episodes: dataset.episodes.length, contexts: dataset.graph.contexts.length })
  const implementation = mode === "nonzero"
    ? "process.exit(9)"
    : mode === "large"
      ? "process.stdout.write('x'.repeat(5 * 1024 * 1024))"
      : `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' ') + '\\n'); if(process.argv[3] === 'validate') process.stdout.write(${JSON.stringify(mode === "bad-validation" ? "{\"valid\":true}" : validationFixture)}); else process.stdout.write(${JSON.stringify(replayFixture)});`
  await writeFile(learner, `#!/usr/bin/env node\n${implementation}\n`)
  await chmod(learner, 0o700)
  const fixture = ruleWeightEvidenceFixture()
  const policy = dashboardPolicy()
  const observations = observeDashboardTarget(policy, JSON.stringify(dashboardTarget, null, 2) + "\n", "2026-10-03T00:00:00Z")
  const context = dashboardContext(observations)
  const artifacts = { dataset: "dataset.json", report: "report.json", baselineSource: "baseline-policy.json", candidateSource: "candidate-policy.json" }
  const handoff: any = {
    schema: "usl-rule-weight-review/v1", id: "urn:test:rule-weight-review", version: "1", reviewedAt: "2026-10-03T00:02:00Z",
    recipe: { policy, observations, evidence: fixture.evidence, proposalInput: fixture.proposalInput }, artifacts,
    mapping: { contextUid: "urn:example:context:dashboard-review", contextRevision: "1", baselineActionUid: "urn:example:w:baseline-action", candidateActionUid: "urn:example:w:candidate-action",
      baselineRuleUid: "urn:example:policy-snapshot:c46289dcacab901dddf20d271b33ecb02e289a46bf3c9cf07938ab5b38307f8d", candidateRuleUid: "urn:example:policy-snapshot:520c9d5cd98a75795c76ce960e590c3b88893a5eb7aa204e1b3fa8bf56f97073", role: "policy_snapshot", ordinal: 0 },
  }
  const host = { expectedHandoffDigest: contractDigest(handoff), artifactSha256: {
    dataset: await sha256(join(dir, artifacts.dataset)), report: await sha256(join(dir, artifacts.report)), baselineSource: await sha256(join(dir, artifacts.baselineSource)), candidateSource: await sha256(join(dir, artifacts.candidateSource)),
  }, evaluationContext: context, evidenceHost: fixture.host }
  const handoffPath = join(dir, "handoff.json"), hostPath = join(dir, "host.json")
  await writeFile(handoffPath, JSON.stringify(handoff)); await writeFile(hostPath, JSON.stringify(host))
  return { dir, marker, learner, handoff, host, handoffPath, hostPath }
}

test("optional rule-weight review CLI pins artifacts, runs the exact learner commands, and records an unapplied review", async t => {
  const f = await setup(t), out = join(f.dir, "receipt.json")
  const result = await command(["--handoff", f.handoffPath, "--host", f.hostPath, "--learner", f.learner, "--out", out])
  assert.equal(result.code, 0, result.stderr)
  const published: any = JSON.parse(await readFile(out, "utf8"))
  assert.equal(published.review.disposition, "REVIEW_ONLY_NOT_APPLIED")
  assert.equal(published.review.replay.source, "HOST_REPORTED")
  assert.equal(published.learner.runtimeTrust, "CALLER_SELECTED_EXECUTABLE_NOT_ATTESTED")
  assert.deepEqual(published.learner.validation.args.slice(0, 2), ["w", "validate"])
  assert.deepEqual(published.learner.replay.args.slice(0, 2), ["w", "replay"])
  assert.match(await readFile(f.marker, "utf8"), /^w validate .+\nw replay .+ .+\n$/)
})

test("CLI refuses stale host pins and unsafe handoff paths before any learner process starts", async t => {
  const stale = await setup(t)
  stale.host.artifactSha256.dataset = `sha256:${"0".repeat(64)}`
  await writeFile(stale.hostPath, JSON.stringify(stale.host))
  const rejected = await command(["--handoff", stale.handoffPath, "--host", stale.hostPath, "--learner", stale.learner])
  assert.equal(rejected.code, 1); assert.match(rejected.stderr, /artifact hash mismatch/)
  await assert.rejects(readFile(stale.marker, "utf8"))

  const traversal = await setup(t)
  traversal.handoff.artifacts.dataset = "../dataset.json"
  await writeFile(traversal.handoffPath, JSON.stringify(traversal.handoff))
  const escaped = await command(["--handoff", traversal.handoffPath, "--host", traversal.hostPath, "--learner", traversal.learner])
  assert.equal(escaped.code, 1); assert.match(escaped.stderr, /must be relative|escapes handoff root/)
  await assert.rejects(readFile(traversal.marker, "utf8"))

  const linked = await setup(t)
  const outside = join(linked.dir, "..", "outside-dataset.json")
  await writeFile(outside, "{}")
  await symlink(outside, join(linked.dir, "linked-dataset.json"))
  linked.handoff.artifacts.dataset = "linked-dataset.json"
  await writeFile(linked.handoffPath, JSON.stringify(linked.handoff))
  const throughLink = await command(["--handoff", linked.handoffPath, "--host", linked.hostPath, "--learner", linked.learner])
  assert.equal(throughLink.code, 1); assert.match(throughLink.stderr, /must not traverse a symlink|resolves outside handoff root/)
  await assert.rejects(readFile(linked.marker, "utf8"))
})

test("CLI refuses an existing output before invoking the learner and fails closed on learner failures", async t => {
  const occupied = await setup(t), out = join(occupied.dir, "receipt.json")
  await writeFile(out, "keep\n")
  const noClobber = await command(["--handoff", occupied.handoffPath, "--host", occupied.hostPath, "--learner", occupied.learner, "--out", out])
  assert.equal(noClobber.code, 64); assert.equal(await readFile(out, "utf8"), "keep\n")
  await assert.rejects(readFile(occupied.marker, "utf8"))

  const failing = await setup(t, "nonzero")
  const result = await command(["--handoff", failing.handoffPath, "--host", failing.hostPath, "--learner", failing.learner])
  assert.equal(result.code, 1); assert.match(result.stderr, /NONZERO_EXIT/)
})

test("CLI bounds learner output", async t => {
  const f = await setup(t, "large")
  const result = await command(["--handoff", f.handoffPath, "--host", f.hostPath, "--learner", f.learner])
  assert.equal(result.code, 1); assert.match(result.stderr, /OUTPUT_LIMIT/)
})

test("CLI resolves dataset evidence from a nested dataset and rejects a malformed validation receipt before replay", async t => {
  const nested = await setup(t), directory = join(nested.dir, "nested")
  await mkdir(directory)
  for (const name of ["dataset.json", "baseline-policy.json", "candidate-policy.json", "protocol.json", "outcomes.json"] as const) await cp(join(nested.dir, name), join(directory, name))
  await Promise.all(["dataset.json", "baseline-policy.json", "candidate-policy.json", "protocol.json", "outcomes.json"].map(name => rm(join(nested.dir, name))))
  nested.handoff.artifacts.dataset = "nested/dataset.json"
  nested.handoff.artifacts.baselineSource = "nested/baseline-policy.json"
  nested.handoff.artifacts.candidateSource = "nested/candidate-policy.json"
  nested.host.expectedHandoffDigest = contractDigest(nested.handoff)
  nested.host.artifactSha256.dataset = await sha256(join(directory, "dataset.json"))
  nested.host.artifactSha256.baselineSource = await sha256(join(directory, "baseline-policy.json"))
  nested.host.artifactSha256.candidateSource = await sha256(join(directory, "candidate-policy.json"))
  await writeFile(nested.handoffPath, JSON.stringify(nested.handoff)); await writeFile(nested.hostPath, JSON.stringify(nested.host))
  const nestedResult = await command(["--handoff", nested.handoffPath, "--host", nested.hostPath, "--learner", nested.learner])
  assert.equal(nestedResult.code, 0, nestedResult.stderr)

  const invalid = await setup(t, "bad-validation")
  const result = await command(["--handoff", invalid.handoffPath, "--host", invalid.hostPath, "--learner", invalid.learner])
  assert.equal(result.code, 1); assert.match(result.stderr, /validate receipt does not bind/)
  const calls = (await readFile(invalid.marker, "utf8")).trim().split("\n")
  assert.equal(calls.length, 1); assert.match(calls[0]!, /^w validate \/(?:var\/)?tmp(?:\/orca)?\/usl-rule-weight-review-/)
})
