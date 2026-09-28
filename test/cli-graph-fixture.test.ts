import assert from "node:assert/strict"
import { test } from "node:test"
import { readFile } from "node:fs/promises"
import { Either } from "effect"
import { sha256 } from "../src/resolve.js"
import { parseGraphEngineeringSource } from "../src/integrations/graph-engineering.js"

test("CLI GraphSpec retains the exact independently validated document and derivation", async () => {
  const raw = await readFile("examples/fixtures/cli/graphspec.json", "utf8")
  const receipt = JSON.parse(await readFile("examples/fixtures/cli/graphspec-validation.json", "utf8"))
  const source = Either.getOrThrowWith(parseGraphEngineeringSource(raw), error => error)
  assert.equal(sha256(raw), receipt.subject.graphspec_sha256)
  assert.equal(sha256(await readFile(receipt.derivation.source_fixture_path)), receipt.derivation.source_fixture_sha256)
  assert.equal(source.graphId, "usl.cli.example")
  assert.equal(source.topology.nodes[0]?.id, "usl_check")
  assert.equal(receipt.validator.verdict, "STRUCTURALLY_CONFORMANT")
  assert.equal(receipt.scope, "document-structural")
  assert.equal(Object.keys(receipt.validator.invariants).length, 15)
  assert.ok(Object.values(receipt.validator.invariants).every(status => status === "PASS"))
})
