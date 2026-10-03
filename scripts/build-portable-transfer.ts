/** Synthetic PT01 artifacts. --record executes local contract tests; --check never does. */
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { createPortableTransferEnvelope, portableTransferManifestSchema, portableTransferEnvelopeSchema } from "../src/addons/portable-transfer.js"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2), check = args.includes("--check"), record = args.includes("--record")
if (args.length > 1 || args.some(arg => !["--check", "--record"].includes(arg))) throw new Error("usage: build-portable-transfer.ts [--check|--record]")
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"
const read = (path: string) => readFile(resolve(root, path), "utf8")
const digest = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex")
const ownerNamespace = "urn:example:owner:portable", issuer = "urn:example:issuer:fixture"
const identity = (nativeId: string) => ({ ownerNamespace, nativeId })
const bytes = "synthetic shared content\n", byteDigest = digest(bytes), byteLength = Buffer.byteLength(bytes)
const envelope = createPortableTransferEnvelope({
  schema: "usl-portable-transfer/v1", ownerNamespace, issuer, observedAt: "2026-10-03T00:00:00Z",
  resources: [identity("memory:alpha"), identity("memory:beta")],
  revisions: [
    { id: "urn:example:revision:alpha:1", resource: identity("memory:alpha"), kind: "CONTENT", parents: [], issuer },
    { id: "urn:example:revision:beta:1", resource: identity("memory:beta"), kind: "CONTENT", parents: [], issuer },
    { id: "urn:example:revision:alpha:2", resource: identity("memory:alpha"), kind: "TOMBSTONE", parents: ["urn:example:revision:alpha:1"], issuer },
  ],
  representations: [
    { id: "urn:example:representation:alpha:1", revision: "urn:example:revision:alpha:1", payloadPath: "payload/alpha.txt", byteDigestAlgorithm: "SHA256_RAW_BYTES_V1", byteDigest, byteLength },
    { id: "urn:example:representation:beta:1", revision: "urn:example:revision:beta:1", payloadPath: "payload/beta.txt", byteDigestAlgorithm: "SHA256_RAW_BYTES_V1", byteDigest, byteLength },
  ],
  historyBoundary: { mode: "CLOSED_V1", externalParents: [] },
})
const p = "urn:usl:portable-transfer:", prov = "http://www.w3.org/ns/prov#"
const ref = (id: string) => ({ "@id": id })
const resourceIri = (value: { ownerNamespace: string; nativeId: string }) => "urn:usl:portable-resource:" + digest(JSON.stringify([value.ownerNamespace, value.nativeId])).slice(7)
const graph = { "@context": { pt: p, prov, xsd: "http://www.w3.org/2001/XMLSchema#" }, "@graph": [
  { "@id": p + "fixture:manifest", "@type": ["pt:Manifest", "prov:Entity"],
    "pt:revision": envelope.manifest.revisions.map(r => ref(r.id)), "pt:representation": envelope.manifest.representations.map(r => ref(r.id)),
    "pt:observedAt": { "@value": envelope.manifest.observedAt, "@type": "xsd:dateTime" },
    "pt:authority": "NOT_GRANTED", "pt:freshness": "UNKNOWN", "pt:payload": "NOT_CHECKED", "prov:wasAttributedTo": ref(issuer) },
  ...envelope.manifest.resources.map(r => ({ "@id": resourceIri(r), "@type": ["pt:Resource", "prov:Entity"],
    "pt:ownerNamespace": ref(r.ownerNamespace), "pt:nativeId": r.nativeId,
    ...(r.derivedFrom === undefined ? {} : { "pt:derivedFrom": ref(resourceIri(r.derivedFrom)) }) })),
  ...envelope.manifest.revisions.map(r => ({ "@id": r.id, "@type": ["pt:Revision", "prov:Entity", ...(r.kind === "TOMBSTONE" ? ["pt:Tombstone"] : [])],
    "pt:revisionOf": ref(resourceIri(r.resource)), "pt:kind": r.kind, "pt:parentRevision": r.parents.map(ref), "prov:wasAttributedTo": ref(r.issuer) })),
  ...envelope.manifest.representations.map(r => ({ "@id": r.id, "@type": ["pt:Representation", "prov:Entity"],
    "pt:representsRevision": ref(r.revision), "pt:payloadPath": r.payloadPath, "pt:byteDigestAlgorithm": r.byteDigestAlgorithm,
    "pt:byteDigest": r.byteDigest, "pt:byteLength": r.byteLength })),
  { "@id": issuer, "@type": "prov:Agent" },
] }
const outputs: Record<string, string> = {
  "schemas/portable-transfer/manifest.schema.json": json(z.toJSONSchema(portableTransferManifestSchema)),
  "schemas/portable-transfer/envelope.schema.json": json(z.toJSONSchema(portableTransferEnvelopeSchema)),
  "research/portable-transfer/envelope.json": json(envelope),
  "research/portable-transfer/graph.jsonld": json(graph),
}
for (const [path, content] of Object.entries(outputs)) {
  if (check) { if (await read(path) !== content) throw new Error(`portable transfer artifact differs: ${path}`) }
  else { await mkdir(dirname(resolve(root, path)), { recursive: true }); await writeFile(resolve(root, path), content) }
}
const receiptPath = "research/portable-transfer/contract.receipt.json"
const pinPaths = ["src/addons/portable-transfer.ts", "src/contract-core.ts", "src/json-data.ts", "test/portable-transfer.test.ts",
  "scripts/build-portable-transfer.ts", "scripts/validate-portable-transfer.py", "schemas/portable-transfer/manifest.shacl.ttl",
  "research/portability-plan/plan.json", "package.json", "package-lock.json", "tsconfig.json", ...Object.keys(outputs)]
const sourcePins = Object.fromEntries(await Promise.all(pinPaths.map(async path => [path, digest(await read(path))])))
const command = ["--import", "tsx", "--test", "--test-reporter=tap", "test/portable-transfer.test.ts"]
const receiptContract = { schema: "usl-portable-transfer-contract-receipt/v1", authority: "SECONDARY_AI", task: "task:PT01",
  implementation: "CONTRACT_IMPLEMENTED", status: "LOCAL_CONTRACT_TESTS_PASS", command: "node " + command.join(" "), exitCode: 0,
  criteria: ["criterion:PT01-C1", "criterion:PT01-C2", "criterion:PT01-C3"],
  evidenceScope: "BOUNDED_PURE_MANIFEST_CONTRACT_ONLY", transfer: "NOT_IMPLEMENTED", restore: "NOT_IMPLEMENTED",
  crossDeviceAcceptance: "NOT_RUN", proofStatus: "NOT_PROVEN", payload: "NOT_CHECKED", freshness: "UNKNOWN", execution: "NOT_REQUESTED" }
if (record) {
  const log = execFileSync(process.execPath, command, { cwd: root, encoding: "utf8" })
  const count = (name: string) => { const found = log.match(new RegExp(`^# ${name} (\\d+)$`, "m")); if (!found) throw new Error(`missing TAP total: ${name}`); return Number(found[1]) }
  const totals = { tests: count("tests"), pass: count("pass"), fail: count("fail"), skipped: count("skipped"), cancelled: count("cancelled"), todo: count("todo") }
  if (totals.tests < 1 || totals.tests !== totals.pass || totals.fail || totals.skipped || totals.cancelled || totals.todo) throw new Error("PT01 local tests did not all pass")
  const receipt = { ...receiptContract, recordedAt: new Date().toISOString(), sourcePins, totals }
  await writeFile(resolve(root, receiptPath), json(receipt))
  console.log(json({ mode: "LOCAL_TESTS_RECORDED", ...totals }))
} else if (check) {
  const receipt = JSON.parse(await read(receiptPath))
  const totals = z.strictObject({ tests: z.number().int().positive(), pass: z.number().int().positive(), fail: z.literal(0),
    skipped: z.literal(0), cancelled: z.literal(0), todo: z.literal(0) }).parse(receipt.totals)
  if (json(receipt.sourcePins) !== json(sourcePins)
    || json(Object.keys(receipt).sort()) !== json([...Object.keys(receiptContract), "recordedAt", "sourcePins", "totals"].sort())
    || Object.entries(receiptContract).some(([key, value]) => json(receipt[key]) !== json(value))
    || !z.iso.datetime().safeParse(receipt.recordedAt).success || totals.tests !== totals.pass) throw new Error("stale or invalid PT01 receipt")
  console.log(json({ mode: "ARTIFACTS_AND_RECORDED_PINS_CHECKED", testsExecutedNow: false, transfer: "NOT_IMPLEMENTED", restore: "NOT_IMPLEMENTED" }))
} else console.log(json({ mode: "SYNTHETIC_ARTIFACTS_BUILT", testsExecutedNow: false }))
