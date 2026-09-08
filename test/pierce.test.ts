import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { audit, pierce, rebind } from "../src/pierce.js"
import { fixture, rpcResponse } from "./fixtures.js"
import { validateRecords } from "../src/validation.js"

const pairs = [ ["kg", "kg"], ["url", "kg"], ["git", "kg"], ["fs", "kg"], ["kg", "fs"], ["url", "fs"], ["fs", "url"], ["git", "fs"] ] as const
for (const [from, to] of pairs) test(`user pair ${from} → ${to}: stable snapshot, drift and repeat audit preserve baseline`, async (t) => {
  const f = await fixture(t)
  const out = await f.run(pierce({ link_id: `${from}-${to}`, semantic_relation: "REFERENCES", from: f.loc[from], to: f.loc[to] }))
  assert.equal(out.record.status, "RESOLVES")
  const stable = await f.run(audit(out.record))
  assert.equal(stable.after, "RESOLVES"); assert.ok(stable.bx.getPut && stable.bx.putGet)
  if (to === "kg") f.state.kgVersion = "v2"
  else if (to === "url") f.state.urlBody = "changed body"
  else await fs.writeFile(f.file, "changed file\n")
  const first = await f.run(audit(out.record))
  assert.equal(first.after, "DRIFT"); assert.equal(first.drift_type, "SigMismatch"); assert.ok(first.changed_ends.includes("to"))
  assert.equal(first.updated.content_hash_to, out.record.content_hash_to)
  assert.equal(first.updated.resolved_at_to, out.record.resolved_at_to)
  assert.notEqual(first.observations.to?.contentHash, out.record.content_hash_to)
  assert.equal(first.bx.getPut, false)
  const repeat = await f.run(audit(first.updated))
  assert.equal(repeat.after, "DRIFT"); assert.equal(repeat.updated.drift_detected_at, first.updated.drift_detected_at)
  const accepted = await f.run(rebind(repeat.updated))
  assert.equal((await f.run(audit(accepted.record))).after, "RESOLVES")
  assert.equal(accepted.record.drift_detected_at, null)
})

test("missing baseline cannot pass GetPut after endpoint recovers; explicit rebind completes it", async (t) => {
  const f = await fixture(t)
  await fs.unlink(f.file)
  const out = await f.run(pierce({ link_id: "missing", semantic_relation: "REFERENCES", from: f.loc.kg, to: f.loc.fs }))
  assert.equal(out.record.status, "ORPHAN_TO")
  await assert.rejects(f.run(rebind(out.record)), /requires both endpoints/)
  await fs.writeFile(f.file, "recovered\n")
  const report = await f.run(audit(out.record))
  assert.equal(report.after, "AMBIGUOUS"); assert.equal(report.drift_type, "Unbaselined"); assert.equal(report.bx.getPut, false)
  assert.deepEqual(report.missing_baseline_ends, ["to"]); assert.equal(report.updated.content_hash_to, null)
  const accepted = await f.run(rebind(report.updated))
  assert.equal((await f.run(audit(accepted.record))).after, "RESOLVES")
})

test("audit reports both orphan endpoints and the underlying transport issue", async (t) => {
  const f = await fixture(t)
  const { record } = await f.run(pierce({ link_id: "two", semantic_relation: "X", from: f.loc.kg, to: f.loc.fs }))
  f.state.kgMissing = true; await fs.unlink(f.file)
  const missing = await f.run(audit(record))
  assert.equal(missing.after, "ORPHAN_FROM"); assert.deepEqual(missing.issues.map((i) => i.end), ["from", "to"])
  const failing: typeof fetch = async () => { throw new Error("ECONNREFUSED") }
  const blocked = await f.run(audit(record), { fetchImpl: failing })
  assert.equal(blocked.after, "AMBIGUOUS"); assert.equal(blocked.updated.confidence, "AMBIGUOUS")
  assert.ok(blocked.issues.some((i) => i.reason === "IO"))
})

test("a recovered audit restores EXTRACTED confidence before its RESOLVES record is persisted", async (t) => {
  const f = await fixture(t)
  const { record } = await f.run(pierce({ link_id: "recovery", semantic_relation: "X", from: f.loc.kg, to: f.loc.fs }))

  f.state.kgMissing = true
  const orphaned = await f.run(audit(record))
  assert.equal(orphaned.after, "ORPHAN_FROM")
  f.state.kgMissing = false
  const fromOrphan = await f.run(audit(orphaned.updated))
  assert.equal(fromOrphan.after, "RESOLVES")
  assert.equal(fromOrphan.updated.confidence, "EXTRACTED")
  assert.deepEqual(validateRecords([fromOrphan.updated]), [fromOrphan.updated])

  const unavailable: typeof fetch = async () => { throw new Error("ECONNREFUSED") }
  const transient = await f.run(audit(record), { fetchImpl: unavailable })
  assert.equal(transient.after, "AMBIGUOUS")
  const fromTransientIo = await f.run(audit(transient.updated))
  assert.equal(fromTransientIo.after, "RESOLVES")
  assert.equal(fromTransientIo.updated.confidence, "EXTRACTED")
  assert.deepEqual(validateRecords([fromTransientIo.updated]), [fromTransientIo.updated])
})

test("git pins full commit, ignores worktree edits, rejects missing path and unsupported symbol", async (t) => {
  const f = await fixture(t)
  const out = await f.run(pierce({ link_id: "git", semantic_relation: "X", from: f.loc.kg, to: f.loc.git.replace(f.commit, f.commit.slice(0, 12)) }))
  assert.equal(out.record.status, "RESOLVES"); assert.ok(out.record.resolved_locator_to?.includes(f.commit))
  await fs.writeFile(path.join(f.repo, "source.txt"), "worktree edit\n")
  assert.equal((await f.run(audit(out.record))).after, "RESOLVES")
  const missing = await f.run(pierce({ link_id: "missing-path", semantic_relation: "X", from: f.loc.kg, to: f.loc.git.replace("source.txt", "missing.txt") }))
  assert.equal(missing.record.status, "ORPHAN_TO")
  const symbol = await f.run(pierce({ link_id: "symbol", semantic_relation: "X", from: f.loc.kg, to: `${f.loc.git}::nonexistent` }))
  assert.equal(symbol.record.status, "AMBIGUOUS"); assert.ok(symbol.notes.some((n) => n.includes("symbol adapter")))
})

test("symlink relocation with identical content is LabelRot", async (t) => {
  const f = await fixture(t)
  const other = path.join(f.dir, "other.txt"), link = path.join(f.dir, "link.txt")
  await fs.writeFile(other, "baseline\n"); await fs.symlink(f.file, link)
  const { record } = await f.run(pierce({ link_id: "symlink", semantic_relation: "X", from: f.loc.kg, to: `file://${f.cfg.hostname}${link}` }))
  await fs.unlink(link); await fs.symlink(other, link)
  const report = await f.run(audit(record))
  assert.equal(report.after, "DRIFT"); assert.equal(report.drift_type, "LabelRot")
  assert.deepEqual(report.changed_ends, []); assert.deepEqual(report.relocated_ends, ["to"])
})

test("KG collision and transport failure are AMBIGUOUS", async (t) => {
  const f = await fixture(t)
  const collision: typeof fetch = async () => rpcResponse([{ uid: "sym:Concept:test", uid_match_count: 2, uid_collision: true }])
  const out = await f.run(pierce({ link_id: "collision", semantic_relation: "X", from: f.loc.kg, to: f.loc.fs }), { fetchImpl: collision })
  assert.equal(out.record.status, "AMBIGUOUS")
})
