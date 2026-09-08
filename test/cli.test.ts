import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { temporary } from "./fixtures.js"

const root = fileURLToPath(new URL("..", import.meta.url))
const cli = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
  execFile(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: root, env: { ...process.env, USL_HOSTNAME: os.hostname(), USL_GIT_REPOS: "{}", USL_KG_SOURCES: "{}" } }, (error, stdout, stderr) => resolve({ code: typeof error?.code === "number" ? error.code : error ? 1 : 0, stdout, stderr }))
})

test("CLI rejects missing files and invalid arguments without creating output", async (t) => {
  const dir = await temporary(t), records = path.join(dir, "missing.json"), out = path.join(dir, "bundle.json"), utterance = path.join(dir, "utterance.txt")
  await fs.writeFile(utterance, "USL links please\n")
  assert.equal((await cli(["audit", "--records", records])).code, 1)
  assert.equal((await cli(["project", "--records", records, "--out", out, "--bundle-uid", "bundle:test", "--utterance-file", utterance])).code, 1)
  assert.equal((await cli(["pierce", "--records", records])).code, 64)
  assert.equal((await cli(["pierce", "--records", records, "--link-id", "x", "--relation", "X", "--from", "https://a.test", "--to", "https://b.test", "--direction", "sideways"])).code, 64)
  await assert.rejects(fs.stat(records), { code: "ENOENT" }); await assert.rejects(fs.stat(out), { code: "ENOENT" })
})

test("CLI lifecycle: pierce, audit/check/write, rebind, validate and projection", async (t) => {
  const dir = await temporary(t), a = path.join(dir, "a.txt"), b = path.join(dir, "b.txt"), records = path.join(dir, "records.json"), utterance = path.join(dir, "utterance.txt"), out = path.join(dir, "bundle.json")
  await fs.writeFile(a, "a\n"); await fs.writeFile(b, "b\n"); await fs.writeFile(utterance, "USL links please\n")
  const args = ["pierce", "--records", records, "--link-id", "test", "--relation", "REFERENCES", "--from", `file://${os.hostname()}${a}`, "--to", `file://${os.hostname()}${b}`]
  const pierced = await cli(args)
  assert.equal(pierced.code, 0, pierced.stderr)
  const baseline = await fs.readFile(records, "utf8")
  assert.equal((await cli(args)).code, 64)
  assert.equal(await fs.readFile(records, "utf8"), baseline)
  assert.equal((await cli(["audit", "--records", records, "--check"])).code, 0)
  await fs.writeFile(b, "changed\n")
  const drift = await cli(["audit", "--records", records, "--check", "--write"])
  assert.equal(drift.code, 2, drift.stderr)
  const report = JSON.parse(drift.stdout)
  assert.equal(report.after, "DRIFT"); assert.deepEqual(report.changed_ends, ["to"])
  assert.equal(JSON.parse(await fs.readFile(records, "utf8"))[0].content_hash_to, JSON.parse(baseline)[0].content_hash_to)
  const accepted = await cli(["rebind", "--records", records, "--link-id", "test"])
  assert.equal(accepted.code, 0, accepted.stderr)
  assert.equal((await cli(["audit", "--records", records, "--check"])).code, 0)
  assert.equal((await cli(["validate", "--records", records])).code, 0)
  const projectArgs = ["project", "--records", records, "--bundle-uid", "bundle:test", "--utterance-file", utterance]
  assert.equal((await cli([...projectArgs, "--out", records])).code, 64)
  const projected = await cli([...projectArgs, "--out", out])
  assert.equal(projected.code, 0, projected.stderr)
  assert.equal(JSON.parse(await fs.readFile(out, "utf8")).nodes.length, 1)
  const snapshot = await fs.readFile(records, "utf8")
  await fs.unlink(b)
  const failedRebind = await cli(["rebind", "--records", records, "--link-id", "test"])
  assert.equal(failedRebind.code, 1); assert.match(failedRebind.stderr, /requires both endpoints/)
  assert.equal(await fs.readFile(records, "utf8"), snapshot)
  const alias = path.join(dir, "alias.json")
  await fs.symlink(out, alias)
  assert.equal((await cli([...projectArgs, "--out", alias])).code, 1)
})

test("language CLI checks, compiles, observes and projects USL while preserving source inputs", async (t) => {
  const dir = await temporary(t), source = path.join(dir, "links.usl"), plan = path.join(dir, "plan.json"), bundle = path.join(dir, "bundle.json"), utterance = path.join(dir, "request.txt")
  const endpoint = `file://${os.hostname()}${dir}`
  const text = `usl "0.1"; namespace "cli.language";
resource directory = ${JSON.stringify(endpoint)};
meaning refers(from: filesystem, to: filesystem) = "같은 경로의 역할 참조";
link self = refers(from: directory, to: directory);`
  await fs.writeFile(source, text); await fs.writeFile(utterance, "이 자원들을 의미로 연결해줘\n")
  const check = await cli(["check", "--source", source])
  assert.equal(check.code, 0, check.stderr); assert.equal(JSON.parse(check.stdout).links, 1)
  assert.equal((await cli(["compile", "--source", source, "--out", plan])).code, 0)
  assert.equal(JSON.parse(await fs.readFile(plan, "utf8")).schema, "usl-semantic-plan/v1")
  const observed = await cli(["observe", "--source", source])
  assert.equal(observed.code, 0, observed.stderr); assert.equal(JSON.parse(observed.stdout).semanticTruth, "NOT_EVALUATED")
  const args = ["project", "--source", source, "--bundle-uid", "bundle:language:test", "--utterance-file", utterance]
  assert.equal((await cli([...args, "--out", bundle])).code, 0)
  const graph = JSON.parse(await fs.readFile(bundle, "utf8"))
  assert.equal(graph.nodes.length, 3); assert.ok(graph.nodes.every((n: { properties: { review_required: boolean } }) => n.properties.review_required))
  assert.equal((await cli(["compile", "--source", source, "--out", source])).code, 64)
  assert.equal((await cli([...args, "--out", utterance])).code, 64)
  assert.equal(await fs.readFile(source, "utf8"), text)
  assert.equal(await fs.readFile(utterance, "utf8"), "이 자원들을 의미로 연결해줘\n")
  assert.equal((await cli(["check", "--source", source, "--records", plan])).code, 64)
})

test("context CLI exposes role-preserving reverse navigation and scoped limits without resolving endpoints", async (t) => {
  const dir = await temporary(t), source = path.join(dir, "context.usl"), out = path.join(dir, "context.json")
  const text = `usl "0.1"; namespace "cli.context";
    resource concept = "kg://unconfigured/concept"; resource code = "file://remote/unavailable";
    meaning implements(source: filesystem, concept: kg) = "구현";
    link implementation = implements(source: code, concept: concept);`
  await fs.writeFile(source, text)
  const args = ["context", "--source", source, "--focus", "concept", "--target", "code"]
  const direct = await cli(args)
  assert.equal(direct.code, 0, direct.stderr)
  const context = JSON.parse(direct.stdout)
  assert.equal(context.schema, "usl-agent-context/v1")
  assert.equal(context.target.status, "FOUND")
  assert.equal(context.target.path.steps[0].enteredRole, "concept")
  assert.equal(context.interpretation.reachability, "NOT_OBSERVED")
  const partial = await cli([...args, "--max-hops", "0"])
  assert.equal(partial.code, 0, partial.stderr)
  assert.equal(JSON.parse(partial.stdout).target.status, "NOT_FOUND_WITHIN_LIMITS")
  const filtered = await cli([...args, "--via", "implements:source:concept", "--out", out])
  assert.equal(filtered.code, 0, filtered.stderr)
  assert.equal(JSON.parse(await fs.readFile(out, "utf8")).target.status, "NOT_FOUND_IN_SCOPE")
  assert.equal((await cli([...args, "--via", "implements:concept:typo"])).code, 64)
  assert.equal((await cli([...args, "--max-hops", "no"])).code, 64)
  assert.equal((await cli([...args, "--max-resources", "0"])).code, 64)
  assert.equal((await cli([...args, "--out", source])).code, 64)
  assert.equal(await fs.readFile(source, "utf8"), text)
})

test("observe CLI saves attributable baselines and detects meaning-only changes without replacing input", async (t) => {
  const dir = await temporary(t), source = path.join(dir, "game.usl"), baseline = path.join(dir, "baseline.json"), next = path.join(dir, "next.json")
  const a = path.join(dir, "code.txt"), b = path.join(dir, "spec.txt")
  await fs.writeFile(a, "dash implementation\n"); await fs.writeFile(b, "grounded dash only\n")
  const text = `usl "0.1"; namespace "cli.observation";
resource code = "file://${os.hostname()}${a}";
resource spec = "file://${os.hostname()}${b}";
resource ignored = "https://must-not-fetch.invalid/resource";
meaning implements(code: filesystem, spec: filesystem) = "grounded dash only"
  applies "single player" check review(code, spec) = "compare dash conditions";
link dash = implements(code: code, spec: spec);`
  await fs.writeFile(source, text)
  const args = ["observe", "--source", source, "--link", "dash"]
  const first = await cli([...args, "--out", baseline])
  assert.equal(first.code, 0, first.stderr)
  const baselineText = await fs.readFile(baseline, "utf8")
  const original = JSON.parse(baselineText)
  assert.equal(original.schema, "usl-program-observation/v2")
  assert.match(original.sourceDigest, /^sha256:[a-f0-9]{64}$/)
  assert.equal(original.metrics.resolverCalls, 2)
  const stable = await cli([...args, "--baseline", baseline])
  assert.equal(stable.code, 0, stable.stderr)
  assert.deepEqual(JSON.parse(stable.stdout).comparison.links[0].actions, [])
  await fs.writeFile(source, text.replace('= "grounded dash only"', '= "air dash allowed"'))
  const revised = await cli([...args, "--baseline", baseline, "--out", next])
  assert.equal(revised.code, 2, revised.stderr)
  const output = JSON.parse(revised.stdout)
  assert.deepEqual(output.comparison.links[0].actions, ["REVIEW_SEMANTIC_CONTRACT"])
  assert.deepEqual(output.comparison.links[0].contentChanged, [])
  assert.notEqual(output.observation.planDigest, original.planDigest)
  assert.deepEqual(JSON.parse(await fs.readFile(next, "utf8")), output.observation)
  assert.equal(await fs.readFile(baseline, "utf8"), baselineText)
  assert.equal((await cli([...args, "--baseline", baseline, "--out", baseline])).code, 64)
  assert.equal((await cli([...args, "--out", source])).code, 64)
  const denied = await cli([...args, "--deny-all"])
  assert.equal(denied.code, 2, denied.stderr)
  assert.equal(JSON.parse(denied.stdout).metrics.resolverCalls, 0)
  assert.ok(JSON.parse(denied.stdout).resources.every((r: {status: string}) => r.status === "DENIED"))
  const limited = await cli([...args, "--max-resources", "1"])
  assert.equal(limited.code, 1); assert.match(limited.stderr, /exceeding maxResources/)
})

test("compact context CLI bounds the AI payload and skips only an identical cached context", async (t) => {
  const dir = await temporary(t), source = path.join(dir, "brief.usl"), out = path.join(dir, "brief.json")
  const text = `usl "0.1"; namespace "cli.compact";
resource concept = "kg://unconfigured/concept";
resource code = "file://remote/never-read";
meaning implements(code: filesystem, concept: kg) = "code implements the concept";
link implementation = implements(code: code, concept: concept);`
  await fs.writeFile(source, text)
  const args = ["context", "--source", source, "--focus", "concept", "--target", "code", "--compact"]
  const first = await cli([...args, "--stats"])
  assert.equal(first.code, 0, first.stderr)
  const packet = JSON.parse(first.stdout)
  assert.equal(packet.schema, "usl-agent-context-compact/v1")
  assert.equal(packet.mode, "FULL")
  assert.equal(packet.target.status, "FOUND")
  assert.equal(JSON.parse(first.stderr).deliveredBytes, Buffer.byteLength(first.stdout))
  const cached = await cli([...args, "--known-context", packet.contextDigest])
  assert.equal(cached.code, 0, cached.stderr)
  assert.equal(JSON.parse(cached.stdout).mode, "UNCHANGED")
  assert.ok(Buffer.byteLength(cached.stdout) < Buffer.byteLength(first.stdout))
  const capped = await cli([...args, "--max-bytes", String(Buffer.byteLength(first.stdout) - 1), "--out", out])
  assert.equal(capped.code, 64)
  await assert.rejects(fs.stat(out), { code: "ENOENT" })
  await fs.writeFile(source, text.replace("code implements the concept", "code contradicts the concept"))
  const changed = await cli([...args, "--known-context", packet.contextDigest, "--out", out])
  assert.equal(changed.code, 0, changed.stderr)
  const updated = JSON.parse(await fs.readFile(out, "utf8"))
  assert.equal(updated.mode, "FULL")
  assert.notEqual(updated.contextDigest, packet.contextDigest)
  assert.equal((await cli([...args, "--max-bytes", "bad"])).code, 64)
  assert.equal((await cli(["check", "--source", source, "--compact"])).code, 64)
})
