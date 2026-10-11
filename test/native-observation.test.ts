import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { observeNativeBinding, prepareNativeObservation, recheckNativeObservation } from "../src/addons/native-observation.js"
import { contractDigest } from "../src/contract-core.js"
import { parseResourceBindings } from "../src/resource-bindings.js"
import { temporary } from "./fixtures.js"

const git = (cwd: string, ...args: string[]) => execFileSync("/usr/bin/git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" } }).trim()
const selection = { resource: "resource:native", representation: "worker-file" } as const
const bindings = () => parseResourceBindings({ schema: "usl-resource-bindings/v1", resources: [{ id: "resource:native", representations: [{ id: "worker-file", relation: "working-copy", kind: "workspace", workspace: "worker", path: "note.txt" }] }] })
const fixture = async (t: TestContext) => {
  const root = await temporary(t), main = join(root, "main"), worker = join(root, "worker")
  await mkdir(main); await writeFile(join(main, "note.txt"), "native bytes\n")
  git(main, "init", "-q"); git(main, "add", "."); git(main, "-c", "user.name=USL", "-c", "user.email=usl@example.invalid", "commit", "-qm", "base")
  git(main, "worktree", "add", "-q", "-b", "worker", worker)
  const head = git(worker, "rev-parse", "HEAD")
  const options = () => ({ workspaces: { worker }, checkout: { policy: { resource: "resource:native", representation: "worker-file", checkoutId: "worker-checkout", expectedHead: { kind: "COMMIT" as const, value: head }, dirtyPolicy: "REQUIRE_CLEAN" as const }, checkouts: { "worker-checkout": { workspace: "worker", root: worker } } } })
  return { root, main, worker, head, options }
}

test("P03 native observation reports linked-worktree SHA facts only through the owner registry", async t => {
  const f = await fixture(t), report = await observeNativeBinding(bindings(), selection, f.options())
  assert.equal(report.status, "PASS", JSON.stringify(report)); assert.equal(report.git?.head, f.head)
  assert.equal(report.git?.objectFormat, "sha1"); assert.equal(report.git?.commonGitDir, join(f.main, ".git"))
  assert.equal(report.git?.ref, "refs/heads/worker"); assert.equal(report.capabilities.authority, "NOT_GRANTED")
  const noRegistry = await observeNativeBinding(bindings(), selection, { workspaces: { worker: f.worker } })
  assert.equal(noRegistry.status, "HOLD"); assert.ok(noRegistry.reasons.includes("GIT_CHECKOUT_REGISTRY_REQUIRED"))
})

test("P03 native observation supports a pinned ordinary local file without Git", async t => {
  const root = await temporary(t); await writeFile(join(root, "plain.txt"), "plain\n")
  const document = parseResourceBindings({ schema: "usl-resource-bindings/v1", resources: [{ id: "resource:plain", representations: [{ id: "plain", relation: "snapshot", kind: "workspace", workspace: "plain", path: "plain.txt", digest: "sha256:dacf36547c7774a0a170806363b5d412991fbc0d6260b2c00b1d3a80a816c23f" }] }] })
  const report = await observeNativeBinding(document, { resource: "resource:plain", representation: "plain" }, { workspaces: { plain: root } })
  assert.equal(report.status, "PASS", JSON.stringify(report)); assert.equal(report.git, undefined); assert.equal(report.content.pinStatus, "MATCH")
  await writeFile(join(root, "plain.txt"), "changed\n")
  const changed = await observeNativeBinding(document, { resource: "resource:plain", representation: "plain" }, { workspaces: { plain: root } })
  assert.equal(changed.status, "HOLD"); assert.ok(changed.reasons.includes("CONTENT_PIN_MISMATCH"))
})

test("P03 native observation holds unsupported locators, symlink checkout facts, and content pin mismatch", async t => {
  const locator = parseResourceBindings({ schema: "usl-resource-bindings/v1", resources: [{ id: "resource:remote", representations: [{ id: "remote", relation: "mirror", kind: "locator", locator: "https://example.invalid/a" }] }] })
  const remote = await observeNativeBinding(locator, { resource: "resource:remote", representation: "remote" }, { workspaces: {} })
  assert.equal(remote.status, "HOLD"); assert.ok(remote.reasons.includes("UNSUPPORTED_REMOTE_LOCATOR"))
  const f = await fixture(t); await writeFile(join(f.worker, "note.txt"), "wrong\n")
  const mismatch = await observeNativeBinding(bindings(), selection, f.options())
  assert.equal(mismatch.status, "HOLD"); assert.ok(mismatch.reasons.includes("CONTENT_PIN_MISMATCH") || mismatch.reasons.some(value => value.startsWith("CHECKOUT_")))
  await git(f.worker, "restore", "note.txt"); await symlink(join(f.main, "note.txt"), join(f.worker, "link.txt"))
  const linkBindings = parseResourceBindings({ schema: "usl-resource-bindings/v1", resources: [{ id: "resource:native", representations: [{ id: "worker-file", relation: "working-copy", kind: "workspace", workspace: "worker", path: "link.txt" }] }] })
  const linked = await observeNativeBinding(linkBindings, selection, f.options())
  assert.equal(linked.status, "HOLD")
})

test("P03 native observation recheck holds a ref move or dirty change and rejects fabricated handles", async t => {
  const f = await fixture(t), prepared = await prepareNativeObservation(bindings(), selection, f.options())
  assert.equal(prepared.report.status, "PASS")
  await writeFile(join(f.worker, "new.txt"), "dirty\n")
  const dirty = await recheckNativeObservation(prepared)
  assert.equal(dirty.status, "HOLD"); assert.ok(dirty.reasons.includes("PREPARED_OBSERVATION_STALE"))
  const { observedAt: _observedAt, digest: _digest, ...stable } = dirty
  assert.equal(dirty.digest, contractDigest(stable))
  await assert.rejects(recheckNativeObservation(structuredClone(prepared)), /not prepared by this process/)
})

test("P03 native observation rejects an in-root symlink before it can be canonicalized", async t => {
  const root = await temporary(t); await writeFile(join(root, "target.txt"), "native\n"); await symlink(join(root, "target.txt"), join(root, "selected.txt"))
  const document = parseResourceBindings({ schema: "usl-resource-bindings/v1", resources: [{ id: "resource:link", representations: [{ id: "local", relation: "snapshot", kind: "workspace", workspace: "local", path: "selected.txt" }] }] })
  const report = await observeNativeBinding(document, { resource: "resource:link", representation: "local" }, { workspaces: { local: root } })
  assert.equal(report.status, "HOLD"); assert.ok(report.reasons.includes("LOCAL_CONTENT_UNAVAILABLE"))
})

test("P03 native observation fingerprints a symbolic-ref move even at the same commit", async t => {
  const f = await fixture(t), prepared = await prepareNativeObservation(bindings(), selection, f.options())
  git(f.worker, "branch", "same-head", "HEAD"); git(f.worker, "switch", "-q", "same-head")
  const report = await recheckNativeObservation(prepared)
  assert.equal(report.status, "HOLD"); assert.ok(report.reasons.includes("PREPARED_OBSERVATION_STALE"), JSON.stringify(report))
})

test("P03 native observation recognizes a SHA-256 repository when host Git supports it", async t => {
  const root = await temporary(t), repo = join(root, "sha256")
  await mkdir(repo); await writeFile(join(repo, "note.txt"), "hash format\n")
  try { git(repo, "init", "-q", "--object-format=sha256") } catch { t.skip("host Git lacks SHA-256 repository support"); return }
  git(repo, "add", "."); git(repo, "-c", "user.name=USL", "-c", "user.email=usl@example.invalid", "commit", "-qm", "sha256")
  const head = git(repo, "rev-parse", "HEAD")
  const document = parseResourceBindings({ schema: "usl-resource-bindings/v1", resources: [{ id: "resource:sha256", representations: [{ id: "local", relation: "working-copy", kind: "workspace", workspace: "sha256", path: "note.txt" }] }] })
  const report = await observeNativeBinding(document, { resource: "resource:sha256", representation: "local" }, { workspaces: { sha256: repo }, checkout: { policy: { resource: "resource:sha256", representation: "local", checkoutId: "sha256-checkout", expectedHead: { kind: "COMMIT", value: head }, dirtyPolicy: "REQUIRE_CLEAN" }, checkouts: { "sha256-checkout": { workspace: "sha256", root: repo } } } })
  assert.equal(report.status, "PASS", JSON.stringify(report)); assert.equal(report.git?.objectFormat, "sha256")
})
