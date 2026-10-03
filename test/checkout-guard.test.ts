import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { access, mkdir, rename, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { inspectCheckoutGuard, parseCheckoutGuardPolicy, prepareCheckoutGuard, recheckCheckoutGuard } from "../src/addons/checkout-guard.js"
import { parseResourceBindings } from "../src/resource-bindings.js"
import { temporary } from "./fixtures.js"

const git = (cwd: string, ...args: string[]): string => execFileSync("/usr/bin/git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
  encoding: "utf8", env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"],
}).trim()
const sha256 = (value: string): string => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`

const document = () => parseResourceBindings({ schema: "usl-resource-bindings/v1", resources: [{ id: "resource:checkout", representations: [
  { id: "main-file", relation: "working-copy", kind: "workspace", workspace: "main", path: "note.txt" },
  { id: "worker-file", relation: "working-copy", kind: "workspace", workspace: "worker", path: "note.txt" },
] }] })

const fixture = async (t: TestContext) => {
  const base = await temporary(t), main = join(base, "main"), worker = join(base, "worker")
  await mkdir(main); await writeFile(join(main, "note.txt"), "same bytes\n"); await writeFile(join(main, "runner.mjs"), "export {}\n")
  git(main, "init", "-q"); git(main, "add", "."); git(main, "-c", "user.name=USL", "-c", "user.email=usl@example.invalid", "commit", "-qm", "base")
  git(main, "worktree", "add", "-q", "-b", "worker", worker)
  const head = git(main, "rev-parse", "HEAD")
  const host = () => ({ workspaces: { main, worker }, checkouts: {
    "main-checkout": { workspace: "main", root: main }, "worker-checkout": { workspace: "worker", root: worker },
  } })
  const policy = (checkoutId = "worker-checkout", expectedHead = head, dirtyPolicy: "REQUIRE_CLEAN" | "ALLOW_DIRTY" = "REQUIRE_CLEAN") => ({
    resource: "resource:checkout", representation: "worker-file", checkoutId, expectedHead: { kind: "COMMIT" as const, value: expectedHead }, dirtyPolicy,
  })
  return { base, main, worker, head, host, policy }
}

const hold = (value: { readonly status: string; readonly reasons: readonly string[] }, reason: string) => {
  assert.equal(value.status, "HOLD", JSON.stringify(value)); assert.ok(value.reasons.includes(reason), JSON.stringify(value))
}

test("DG01-C1: equal bytes with a different HEAD or owner checkout identity hold", async t => {
  const f = await fixture(t), bindings = document()
  await writeFile(join(f.main, "only-main.txt"), "different commit, unchanged note\n")
  git(f.main, "add", "only-main.txt"); git(f.main, "-c", "user.name=USL", "-c", "user.email=usl@example.invalid", "commit", "-qm", "main only")
  const wrongHead = await inspectCheckoutGuard(bindings, { resource: "resource:checkout", representation: "worker-file" }, f.policy("worker-checkout", git(f.main, "rev-parse", "HEAD")), f.host())
  hold(wrongHead, "HEAD_MISMATCH")
  const sameHeadWrongCheckout = await inspectCheckoutGuard(bindings, { resource: "resource:checkout", representation: "worker-file" }, f.policy("main-checkout", f.head), f.host())
  hold(sameHeadWrongCheckout, "CHECKOUT_WORKSPACE_MISMATCH")
})

test("DG01-C1: an explicit Git worktree move and owner remap retain the selected logical binding", async t => {
  const f = await fixture(t), moved = join(f.base, "worker-moved"), bindings = document()
  git(f.main, "worktree", "move", f.worker, moved)
  const host = { workspaces: { main: f.main, worker: moved }, checkouts: {
    "main-checkout": { workspace: "main", root: f.main }, "worker-checkout": { workspace: "worker", root: moved },
  } }
  const result = await inspectCheckoutGuard(bindings, { resource: "resource:checkout", representation: "worker-file" }, f.policy(), host)
  assert.equal(result.status, "PASS", JSON.stringify(result)); assert.equal(result.resource, "resource:checkout"); assert.equal(result.representation, "worker-file")
  assert.equal(result.observation?.checkoutRoot, moved)
})

test("DG01-C2: dirty, detached, sparse, subdirectory and broken-gitfile states are held by policy", async t => {
  const f = await fixture(t), bindings = document()
  await writeFile(join(f.worker, "note.txt"), "dirty\n")
  hold(await inspectCheckoutGuard(bindings, { resource: "resource:checkout", representation: "worker-file" }, f.policy(), f.host()), "DIRTY_CHECKOUT")
  git(f.worker, "restore", "note.txt"); git(f.worker, "checkout", "-q", "--detach", "HEAD")
  hold(await inspectCheckoutGuard(bindings, { resource: "resource:checkout", representation: "worker-file" }, f.policy(), f.host()), "DETACHED_HEAD_NOT_ALLOWED")
  git(f.worker, "checkout", "-q", "worker")
  git(f.worker, "sparse-checkout", "init", "--no-cone"); git(f.worker, "sparse-checkout", "set", "--no-cone", "/note.txt")
  hold(await inspectCheckoutGuard(bindings, { resource: "resource:checkout", representation: "worker-file" }, f.policy(), f.host()), "SPARSE_CHECKOUT_NOT_ALLOWED")

  const subdirHost = { workspaces: { worker: join(f.worker, "sub") }, checkouts: { "worker-checkout": { workspace: "worker", root: join(f.worker, "sub") } } }
  await mkdir(join(f.worker, "sub"))
  hold(await inspectCheckoutGuard(bindings, { resource: "resource:checkout", representation: "worker-file" }, f.policy(), subdirHost), "GIT_ROOT_DOES_NOT_MATCH_REGISTERED_CHECKOUT_ROOT")
  await rename(f.main, join(f.base, "main-moved"))
  hold(await inspectCheckoutGuard(bindings, { resource: "resource:checkout", representation: "worker-file" }, f.policy(), f.host()), "GIT_FACTS_UNAVAILABLE")
})

test("DG01-C2: an owner may explicitly allow a dirty checkout and an unborn checkout is distinguished", async t => {
  const f = await fixture(t), bindings = document()
  await writeFile(join(f.worker, "untracked.txt"), "tracked by fingerprint\n")
  const allowed = await inspectCheckoutGuard(bindings, { resource: "resource:checkout", representation: "worker-file" }, f.policy("worker-checkout", f.head, "ALLOW_DIRTY"), f.host())
  assert.equal(allowed.status, "PASS", JSON.stringify(allowed)); assert.equal(allowed.observation?.dirty, true)

  const base = await temporary(t), unborn = join(base, "unborn"); await mkdir(unborn); await writeFile(join(unborn, "note.txt"), "unborn\n"); git(unborn, "init", "-q")
  const unbornBindings = parseResourceBindings({ schema: "usl-resource-bindings/v1", resources: [{ id: "resource:unborn", representations: [{ id: "local", relation: "working-copy", kind: "workspace", workspace: "unborn", path: "note.txt" }] }] })
  const policy = { resource: "resource:unborn", representation: "local", checkoutId: "unborn-checkout", expectedHead: { kind: "UNBORN" as const }, dirtyPolicy: "ALLOW_DIRTY" }
  const report = await inspectCheckoutGuard(unbornBindings, { resource: "resource:unborn", representation: "local" }, policy, { workspaces: { unborn }, checkouts: { "unborn-checkout": { workspace: "unborn", root: unborn } } })
  assert.equal(report.status, "PASS", JSON.stringify(report)); assert.equal(report.observation?.head, null)
})

test("DG01-C3: a prepared guard holds after HEAD, index or runner changes and a caller action stays at zero", async t => {
  const f = await fixture(t), bindings = document(), selection = { resource: "resource:checkout", representation: "worker-file" } as const
  const assertStale = async (change: () => Promise<void> | void) => {
    const prepared = await prepareCheckoutGuard(bindings, selection, f.policy(), f.host()); assert.equal(prepared.report.status, "PASS")
    await change()
    const rechecked = await recheckCheckoutGuard(prepared, f.host()); hold(rechecked, "PREPARED_FINGERPRINT_STALE")
    let actions = 0
    if (rechecked.status === "PASS") actions += 1
    assert.equal(actions, 0)
    git(f.worker, "reset", "--hard", "HEAD"); git(f.worker, "clean", "-fd")
  }
  await assertStale(async () => { await writeFile(join(f.worker, "note.txt"), "runner worktree change\n") })
  await assertStale(async () => { await writeFile(join(f.worker, "runner.mjs"), "export const changed = true\n"); git(f.worker, "add", "runner.mjs") })
  await assertStale(async () => { await writeFile(join(f.worker, "new-head.txt"), "commit\n"); git(f.worker, "add", "new-head.txt"); git(f.worker, "-c", "user.name=USL", "-c", "user.email=usl@example.invalid", "commit", "-qm", "new head") })
})

test("DG01-C2: a nested submodule is held unless a future profile closes its scope", async t => {
  const f = await fixture(t), source = join(f.base, "submodule-source"), bindings = document()
  await mkdir(source); await writeFile(join(source, "state.txt"), "base\n")
  git(source, "init", "-q"); git(source, "add", "."); git(source, "-c", "user.name=USL", "-c", "user.email=usl@example.invalid", "commit", "-qm", "base")
  git(f.worker, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "vendor/module")
  git(f.worker, "add", ".gitmodules", "vendor/module"); git(f.worker, "-c", "user.name=USL", "-c", "user.email=usl@example.invalid", "commit", "-qm", "add module")
  const policy = f.policy("worker-checkout", git(f.worker, "rev-parse", "HEAD"), "ALLOW_DIRTY")
  const report = await inspectCheckoutGuard(bindings, { resource: "resource:checkout", representation: "worker-file" }, policy, f.host())
  assert.equal(report.status, "HOLD", JSON.stringify(report))
  await writeFile(join(f.worker, "vendor/module/state.txt"), "nested dirty\n")
  assert.equal((await inspectCheckoutGuard(bindings, { resource: "resource:checkout", representation: "worker-file" }, policy, f.host())).status, "HOLD")
})

test("DG01-C3: a prepared guard is process-local, an initial HOLD cannot become PASS, and a remap is stale", async t => {
  const f = await fixture(t), bindings = document(), selection = { resource: "resource:checkout", representation: "worker-file" } as const
  const prepared = await prepareCheckoutGuard(bindings, selection, f.policy(), f.host())
  await assert.rejects(recheckCheckoutGuard(structuredClone(prepared), f.host()), /prepared checkout guard was not created by this runtime/)
  const mismatched = await prepareCheckoutGuard(bindings, selection, f.policy("worker-checkout", "0".repeat(40)), f.host())
  assert.equal(mismatched.report.status, "HOLD")
  assert.equal((await recheckCheckoutGuard(mismatched, f.host())).status, "HOLD")
  const remapped = { workspaces: { main: f.main, worker: f.main }, checkouts: {
    "main-checkout": { workspace: "main", root: f.main }, "worker-checkout": { workspace: "worker", root: f.main },
  } }
  assert.equal((await recheckCheckoutGuard(prepared, remapped)).status, "HOLD")
})

test("DG01-C2: malformed sparse configuration and unborn index changes fail closed", async t => {
  const f = await fixture(t), bindings = document()
  git(f.worker, "config", "core.sparseCheckout", "not-a-boolean")
  hold(await inspectCheckoutGuard(bindings, { resource: "resource:checkout", representation: "worker-file" }, f.policy(), f.host()), "GIT_FACTS_UNAVAILABLE")

  const base = await temporary(t), unborn = join(base, "unborn"); await mkdir(unborn); await writeFile(join(unborn, "note.txt"), "unborn\n"); git(unborn, "init", "-q")
  const unbornBindings = parseResourceBindings({ schema: "usl-resource-bindings/v1", resources: [{ id: "resource:unborn", representations: [{ id: "local", relation: "working-copy", kind: "workspace", workspace: "unborn", path: "note.txt" }] }] })
  const policy = { resource: "resource:unborn", representation: "local", checkoutId: "unborn-checkout", expectedHead: { kind: "UNBORN" as const }, dirtyPolicy: "ALLOW_DIRTY" }
  const host = { workspaces: { unborn }, checkouts: { "unborn-checkout": { workspace: "unborn", root: unborn } } }
  const prepared = await prepareCheckoutGuard(unbornBindings, { resource: "resource:unborn", representation: "local" }, policy, host)
  assert.equal(prepared.report.status, "PASS", JSON.stringify(prepared.report))
  git(unborn, "add", "note.txt")
  hold(await recheckCheckoutGuard(prepared, host), "PREPARED_FINGERPRINT_STALE")
})

test("DG01-C2: FIFO, untracked nested repository and symlink inputs fail closed without traversal", async t => {
  const f = await fixture(t), bindings = document(), inspect = () => inspectCheckoutGuard(bindings, { resource: "resource:checkout", representation: "worker-file" }, f.policy(), f.host())
  execFileSync("/usr/bin/mkfifo", [join(f.worker, "untracked.pipe")])
  hold(await inspect(), "GIT_FACTS_UNAVAILABLE")

  const nested = await fixture(t); await mkdir(join(nested.worker, "untracked-repo")); git(join(nested.worker, "untracked-repo"), "init", "-q")
  hold(await inspectCheckoutGuard(document(), { resource: "resource:checkout", representation: "worker-file" }, nested.policy(), nested.host()), "GIT_FACTS_UNAVAILABLE")

  const linked = await fixture(t), outside = join(linked.base, "outside.txt"); await writeFile(outside, "outside\n"); await symlink(outside, join(linked.worker, "untracked-link"))
  hold(await inspectCheckoutGuard(document(), { resource: "resource:checkout", representation: "worker-file" }, linked.policy(), linked.host()), "GIT_FACTS_UNAVAILABLE")
})

test("DG01-C2: configured Git clean filters hold before a selected-file observation can invoke them", async t => {
  const f = await fixture(t), marker = join(f.base, "filter-ran")
  await writeFile(join(f.worker, ".gitattributes"), "note.txt filter=usl\n")
  git(f.worker, "add", ".gitattributes"); git(f.worker, "-c", "user.name=USL", "-c", "user.email=usl@example.invalid", "commit", "-qm", "attributes before filter")
  const head = git(f.worker, "rev-parse", "HEAD")
  git(f.worker, "config", "filter.usl.clean", `sh -c 'echo invoked > ${marker}; cat'`)
  await writeFile(join(f.worker, "note.txt"), "changed without running filter\n")
  const result = await inspectCheckoutGuard(document(), { resource: "resource:checkout", representation: "worker-file" }, f.policy("worker-checkout", head, "ALLOW_DIRTY"), f.host())
  hold(result, "GIT_FACTS_UNAVAILABLE")
  await assert.rejects(access(marker))
})

test("DG01-C1: a selected content pin reports exact MATCH then MISMATCH", async t => {
  const f = await fixture(t)
  const pinned = parseResourceBindings({ schema: "usl-resource-bindings/v1", resources: [{ id: "resource:checkout", representations: [{
    id: "worker-file", relation: "working-copy", kind: "workspace", workspace: "worker", path: "note.txt", digest: sha256("same bytes\n"),
  }] }] })
  const policy = f.policy("worker-checkout", f.head, "ALLOW_DIRTY")
  const matched = await inspectCheckoutGuard(pinned, { resource: "resource:checkout", representation: "worker-file" }, policy, f.host())
  assert.equal(matched.status, "PASS", JSON.stringify(matched)); assert.equal(matched.observation?.content?.pinStatus, "MATCH")
  await writeFile(join(f.worker, "note.txt"), "different bytes\n")
  const mismatched = await inspectCheckoutGuard(pinned, { resource: "resource:checkout", representation: "worker-file" }, policy, f.host())
  hold(mismatched, "CONTENT_PIN_MISMATCH"); assert.equal(mismatched.observation?.content?.pinStatus, "MISMATCH")
})

test("DG01-C3: policies and hosts are snapshotted, reject accessors, and bounded untracked capture fails closed", async t => {
  const f = await fixture(t), bindings = document(), policy = f.policy(), host = f.host()
  const prepared = await prepareCheckoutGuard(bindings, { resource: "resource:checkout", representation: "worker-file" }, policy, host)
  policy.expectedHead.value = "0".repeat(40); host.workspaces.worker = f.main
  assert.equal(prepared.policy.expectedHead.kind, "COMMIT"); assert.equal(prepared.policy.expectedHead.value, f.head); assert.equal(prepared.host.workspaces.worker, f.worker)
  assert.ok(Object.isFrozen(prepared.policy)); assert.ok(Object.isFrozen(prepared.host))
  const getter = { ...f.policy(), get checkoutId() { throw new Error("must not run") } }
  assert.throws(() => parseCheckoutGuardPolicy(getter), /enumerable JSON values/)
  await writeFile(join(f.worker, "large-untracked.bin"), Buffer.alloc(1024 * 1024 + 1))
  const bounded = await inspectCheckoutGuard(bindings, { resource: "resource:checkout", representation: "worker-file" }, f.policy(), f.host())
  hold(bounded, "GIT_FACTS_UNAVAILABLE")
})
