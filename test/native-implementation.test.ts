import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { temporary } from "./fixtures.js"
import { Either } from "effect"
import { adaptResourceGraph, parseResourceGraph } from "../src/integrations/resource-graph.js"

const root = fileURLToPath(new URL("..", import.meta.url))
const run = (...args: string[]) => execFileSync("python3", ["scripts/build-native-implementation.py", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
test("native implementation projection pins existing bounded code/test evidence and preserves pending work", async () => {
  run("--check")
  const graph = JSON.parse(await readFile(join(root, "research/native-development/implementation/graph.json"), "utf8"))
  assert.equal(graph.schema, "usl-resource-graph/v1")
  assert.ok(Either.isRight(parseResourceGraph(JSON.stringify(graph))))
  assert.ok(Either.isRight(adaptResourceGraph(JSON.stringify(graph), { namespace: "native.implementation.progress" })))
  const progress = JSON.parse(await readFile(join(root, "research/native-development/implementation/progress.json"), "utf8"))
  const expectedStatus = progress.checks.length ? "IMPLEMENTED_BOUNDED" : "CODE_PRESENT_NOT_VERIFIED"
  assert.ok(graph.resources.some((v: { metadata?: { workItem?:string; status?:string } }) => v.metadata?.workItem === "P06" && v.metadata.status === expectedStatus))
  assert.ok(graph.links.some((v: { meaning:string; participants: { resource:string }[] }) => v.meaning === "snapshotOf" && v.participants.some(p => p.resource === "urn:usl:dev:work:P06")))
  assert.equal(graph.resources.filter((v: { metadata?: { status?:string } }) => v.metadata?.status === "PLANNED").length, 4)
  assert.ok(graph.links.some((v: { meaning:string; participants: { resource:string }[] }) => v.meaning === "addresses" && v.participants[0]?.resource.endsWith("work:P08") && v.participants[1]?.resource === "urn:usl:dev:req:R06"))
  assert.equal(graph.links.filter((v: { meaning:string; participants: { resource:string }[] }) => v.meaning === "implementedBy" && v.participants[0]?.resource.endsWith("work:P09")).length, 2)
  assert.equal(graph.links.filter((v: { meaning:string; participants: { resource:string }[] }) => v.meaning === "checkedBy" && v.participants[0]?.resource.endsWith("work:P09")).length, 4)
  assert.equal(graph.links.filter((v: { meaning:string; participants: { resource:string }[] }) => v.meaning === "implementedBy" && v.participants[0]?.resource.endsWith("work:P10")).length, 2)
  assert.equal(graph.links.filter((v: { meaning:string; participants: { resource:string }[] }) => v.meaning === "checkedBy" && v.participants[0]?.resource.endsWith("work:P10")).length, 2)
  assert.deepEqual(graph.links.filter((v: { meaning:string; participants: { resource:string }[] }) => v.meaning === "addresses" && v.participants[0]?.resource.endsWith("work:P10")).map((v: { participants: { resource:string }[] }) => v.participants[1]?.resource).sort(), ["urn:usl:dev:req:R06", "urn:usl:dev:req:R07"])
  const trace = JSON.parse(await readFile(join(root, "research/native-development/implementation/trace.jsonld"), "utf8"))
  for (const link of graph.links) {
    const [source, target] = link.participants.map((p: { resource: string }) => p.resource)
    const node = trace["@graph"].find((n: { "@id": string }) => n["@id"] === source)
    assert.ok(node[`ni:${link.meaning}`].some((n: { "@id": string }) => n["@id"] === target))
  }
})
test("native implementation input evidence rejects stale pins without recording it", async t => {
  const dir=await temporary(t), input=join(dir,"evidence.json")
  await writeFile(input, JSON.stringify({schema:"usl-native-implementation-check/v1",status:"PASS",count:1,command:["node"],pins:{}}))
  assert.throws(() => run("--input",input), /stale or incomplete/)
  assert.throws(() => run("--check", "--input", input), /read-only/)
})

test("native implementation rejects empty commands, boolean counts and fabricated run evidence", async t => {
  const dir = await temporary(t), input = join(dir, "evidence.json")
  const progress = JSON.parse(await readFile(join(root, "research/native-development/implementation/progress.json"), "utf8"))
  const before = await readFile(join(root, "research/native-development/implementation/graph.json"), "utf8")
  const base = { schema: "usl-native-implementation-check/v1", status: "PASS", count: 1, command: ["node"], pins: progress.pins }
  for (const change of [{ command: [] }, { count: true }, {}]) {
    await writeFile(input, JSON.stringify({ ...base, ...change }))
    assert.throws(() => run("--input", input))
  }
  assert.equal(await readFile(join(root, "research/native-development/implementation/graph.json"), "utf8"), before)
})
