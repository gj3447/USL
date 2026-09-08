import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { temporary } from "./fixtures.js"

const root = fileURLToPath(new URL("..", import.meta.url))
const cli = (args: string[]) => new Promise<{ code: number; stderr: string }>((resolve) => {
  execFile(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: root, env: { ...process.env, USL_HOSTNAME: os.hostname(), USL_GIT_REPOS: "{}", USL_KG_SOURCES: "{}" } }, (error, _stdout, stderr) => resolve({ code: typeof error?.code === "number" ? error.code : error ? 1 : 0, stderr }))
})

const record = [{
  link_id: "l1", semantic_relation: "DOCUMENTED_IN", from_endpoint_kind: "kg", from_locator: "kg://canonical-neo4j/sym:Concept:usl", to_endpoint_kind: "filesystem", to_locator: "file://host/tmp/doc.md",
  direction: "directed", resolved_at_from: "t", resolved_at_to: "t", resolved_locator_from: "kg://canonical-neo4j/sym:Concept:usl", resolved_locator_to: "file://host/tmp/doc.md", pierced_at: "t", drift_detected_at: null, drift_score: 0,
  content_hash_from: "a", content_hash_to: "b", confidence: "EXTRACTED", guarantee_level: "trust_host", status: "RESOLVES", provenance_actor: "test", provenance_tool_version: "usl/0.1.0", provenance_command: "test", provenance_date: "2026-09-08", hswm_owner_ref: null,
}]

test("legacy project preserves records, utterance and anchors when --out aliases any input", async (t) => {
  const dir = await temporary(t)
  const records = path.join(dir, "records.json"), utterance = path.join(dir, "utterance.txt"), anchors = path.join(dir, "anchors.json"), bundle = path.join(dir, "bundle.json")
  await fs.writeFile(records, JSON.stringify(record, null, 2) + "\n")
  await fs.writeFile(utterance, "preserve this request\n")
  await fs.writeFile(anchors, "{}\n")
  const before = await Promise.all([fs.readFile(records, "utf8"), fs.readFile(utterance, "utf8"), fs.readFile(anchors, "utf8")])
  const base = ["project", "--records", records, "--bundle-uid", "bundle:input-guard", "--utterance-file", utterance, "--anchors", anchors]
  for (const out of [records, utterance, anchors]) {
    const result = await cli([...base, "--out", out])
    assert.equal(result.code, 64, result.stderr)
  }
  for (const [name, input] of [["records-alias.json", records], ["utterance-alias.txt", utterance], ["anchors-alias.json", anchors]] as const) {
    const alias = path.join(dir, name)
    await fs.symlink(input, alias)
    const result = await cli([...base, "--out", alias])
    assert.equal(result.code, 64, result.stderr)
  }
  assert.deepEqual(await Promise.all([fs.readFile(records, "utf8"), fs.readFile(utterance, "utf8"), fs.readFile(anchors, "utf8")]), before)
  const projected = await cli([...base, "--out", bundle])
  assert.equal(projected.code, 0, projected.stderr)
  assert.equal((JSON.parse(await fs.readFile(bundle, "utf8")) as { nodes: unknown[] }).nodes.length, 1)
})
