import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { readRecords, writeRecords } from "../src/storage.js"
import { fixture, temporary } from "./fixtures.js"
import { pierce } from "../src/pierce.js"

test("snapshot writes reject stale data and active writers without changing original bytes", async (t) => {
  const dir = await temporary(t), file = path.join(dir, "records.json")
  const initial = await readRecords(file, true)
  await writeRecords(initial, [])
  await assert.rejects(writeRecords(initial, []), /changed during operation/)
  assert.equal(await fs.readFile(file, "utf8"), "[]\n")
  const snapshot = await readRecords(file)
  await fs.writeFile(`${file}.lock`, "another writer")
  await assert.rejects(writeRecords(snapshot, []), /another writer/)
  assert.equal(await fs.readFile(file, "utf8"), "[]\n")
  await fs.unlink(`${file}.lock`)
  const results = await Promise.allSettled([writeRecords(snapshot, []), writeRecords(snapshot, [])])
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1)
  assert.deepEqual((await fs.readdir(dir)).sort(), ["records.json"])
})

test("records with unknown fields fail validation instead of silently losing data", async (t) => {
  const f = await fixture(t), file = path.join(f.dir, "records.json")
  const { record } = await f.run(pierce({ link_id: "extra", semantic_relation: "X", from: f.loc.kg, to: f.loc.fs }))
  const original = JSON.stringify([{ ...record, unexpected: "future metadata" }]) + "\n"
  await fs.writeFile(file, original)
  await assert.rejects(readRecords(file), /unexpected/)
  assert.equal(await fs.readFile(file, "utf8"), original)
})
