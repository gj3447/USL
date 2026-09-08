import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openProgramFile, openProgramRegistry, type ProgramFile, type ProgramStatus } from "../src/program-store.js"
import { executeUslOperation, DEFAULT_USL_POLICY } from "../src/application.js"
import { Effect } from "effect"
import { formatLocator } from "../src/locator.js"

const source = (description: string) => `usl "0.1"; namespace "hot";
resource a = "https://example.test/a"; resource b = "https://example.test/b";
meaning related(a: url, b: url) = "${description}";
link relation = related(a: a, b: b);`
const fixture = async (t: { after(fn: () => Promise<void>): void }) => {
  const directory = await mkdtemp(join(tmpdir(), "usl-store-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return join(directory, "program.usl")
}
const changed = (file: ProgramFile, accept: (status: ProgramStatus) => boolean) => new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => { unsubscribe(); reject(new Error("watch update timed out")) }, 5000)
  const unsubscribe = file.subscribe(({ status }) => { if (accept(status)) { clearTimeout(timeout); unsubscribe(); resolve() } })
})

test("registered sources reuse unchanged plans and rebuild only the changed file", async (t) => {
  const file = await fixture(t), other = `${file}.other`
  await writeFile(file, source("one")); await writeFile(other, source("other"))
  const registry = await openProgramRegistry({ first: file, other }, { watch: false })
  t.after(() => registry.close())
  const old = await registry.getProgram("first")
  for (let i = 0; i < 20; i++) assert.equal(await registry.getProgram("first"), old)
  assert.equal(registry.status().first!.compilations, 1)
  const priorBytes = registry.status().first!.bytesRead
  await writeFile(file, source("two"))
  const next = await registry.getProgram("first")
  assert.notEqual(next, old)
  assert.equal(old.plan.meanings[0]?.description, "one")
  assert.equal(next.plan.meanings[0]?.description, "two")
  assert.equal(registry.status().first!.compilations, 2)
  assert.equal(registry.status().other!.compilations, 1)
  assert.ok(registry.status().first!.bytesRead > priorBytes)
  await assert.rejects(registry.getProgram(file), /unknown registered/)
})

test("watch atomically installs valid edits, retains old snapshots and exposes failed edits", async (t) => {
  const path = await fixture(t)
  await writeFile(path, source("one"))
  const file = await openProgramFile(path, { debounceMs: 1 })
  t.after(() => file.close())
  const old = file.snapshot()
  const next = changed(file, (status) => status.revision === 2)
  await writeFile(path, source("two")); await next
  assert.equal(old.plan.meanings[0]?.description, "one")
  assert.equal(file.snapshot().plan.meanings[0]?.description, "two")
  file.subscribe((update) => { (update.status as { state: string }).state = "CURRENT" })
  const invalid = changed(file, (status) => status.state === "INVALID_EDIT")
  await writeFile(path, "not a valid program"); await invalid
  assert.equal(file.status().state, "INVALID_EDIT")
  assert.equal(file.status().revision, 2)
  assert.equal(file.snapshot().plan.meanings[0]?.description, "two")
  const recovered = changed(file, (status) => status.state === "CURRENT")
  await writeFile(path, source("two")); await recovered
  assert.equal(file.status().revision, 2)
})

test("in-flight observations keep their original semantic version across a refresh", async (t) => {
  const file = await fixture(t)
  await writeFile(file, source("one"))
  const registry = await openProgramRegistry({ game: file }, { watch: false })
  t.after(() => registry.close())
  let entered!: () => void, release!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const observation = executeUslOperation("observe", { program: "game" }, {
    ...DEFAULT_USL_POLICY, getProgram: registry.getProgram, allowedLocators: ["https://example.test/a", "https://example.test/b"],
    resolvers: { resolve: (locator) => Effect.promise(async () => {
      entered(); await gate
      return { locator, resolvedLocator: formatLocator(locator), contentHash: "fixture", resolvedAt: new Date().toISOString(), guaranteeLevel: "pure" as const, matchCount: 1 }
    }) },
  })
  await started
  await writeFile(file, source("two")); await registry.getProgram("game"); release()
  const report = await observation as { meanings: { definition: { description: string } }[] }
  assert.equal(report.meanings[0]!.definition.description, "one")
  assert.equal((await registry.getProgram("game")).plan.meanings[0]?.description, "two")
})

test("source size limits and invalid newest edits fail without silently widening reads", async (t) => {
  const file = await fixture(t)
  await writeFile(file, source("one"))
  await assert.rejects(openProgramFile(file, { maxSourceBytes: 2, watch: false }), /maxSourceBytes/)
  const registry = await openProgramRegistry({ game: file }, { watch: false })
  t.after(() => registry.close())
  await writeFile(file, "invalid")
  await assert.rejects(registry.getProgram("game"), /invalid edit/)
  assert.equal(registry.status().game!.revision, 1)
})
