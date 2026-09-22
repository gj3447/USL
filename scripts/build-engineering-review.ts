/** Replay local attacks, pin implementation bytes, then emit the review graph and standard projection. */
import { readFile, writeFile, readdir } from "node:fs/promises"
import { hostname } from "node:os"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { Either } from "effect"
import { z } from "zod"
import { engineeringAdversarialCases } from "../test/engineering-adversarial-cases.js"
import { parseEngineeringCatalog, engineeringReceiptSchema, engineeringCatalogSchema, reviewControlStatus, buildEngineeringReviewGraph, engineeringReviewProfile, type EngineeringReceipt } from "../src/engineering-review.js"
import { checkResourceGraphProfile, domainProfileSchema } from "../src/domain-profile.js"
import { capabilitySchema } from "../src/capabilities.js"
import { capabilityCatalogSchema } from "../src/capability-catalog.js"
import { contractDigest } from "../src/contract-core.js"
import { digestSource } from "../src/language/digest.js"
import { adaptResourceGraph, resourceGraphJsonLd } from "../src/integrations/resource-graph.js"

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), checkOnly = process.argv.includes("--check")
if (process.argv.slice(2).some(arg => arg !== "--check")) throw new Error("usage: build-engineering-review.ts [--check]")
const read = (file: string) => readFile(resolve(root, file), "utf8")
const catalog = parseEngineeringCatalog(JSON.parse(await read("research/engineering/catalog.json")))
if (catalog.technologies.length !== 40 || catalog.technologies.some((t, index) => t.id !== `S${String(index + 1).padStart(2, "0")}`)) throw new Error("research must cover exactly S01–S40")
const declaredChecks = catalog.controls.flatMap(c => c.checks.map(id => ({ id, control: c.id })))
if (declaredChecks.length !== engineeringAdversarialCases.length || declaredChecks.some(c => !engineeringAdversarialCases.some(t => t.id === c.id && t.control === c.control))) throw new Error("catalog/replay check coverage differs")
// Pin every local runtime source, including transitive validation/digest dependencies.
const runtimeSources = (await readdir(resolve(root, "src"), { recursive: true })).filter(file => file.endsWith(".ts")).map(file => `src/${file}`)
const files = [...new Set([...runtimeSources, ...catalog.controls.flatMap(c => c.implementation),
  "test/engineering-adversarial-cases.ts", "src/engineering-review.ts", "scripts/build-engineering-review.ts",
  "src/contract-core.ts", "src/mcp-config.ts", "src/cli-adapter.ts",
  "package-lock.json", "package.json", "tsconfig.json",
])].sort()
const digests = Object.fromEntries(await Promise.all(files.map(async file => [file, digestSource(await read(file))] as const)))
let receipt: EngineeringReceipt
if (checkOnly) {
  receipt = engineeringReceiptSchema.parse(JSON.parse(await read("research/engineering/receipt.json")))
  if (JSON.stringify(receipt.sourceDigests) !== JSON.stringify(digests)) throw new Error("source pins changed; replay with npm run engineering:build")
} else {
  const startedAt = new Date().toISOString(), checks: EngineeringReceipt["checks"] = []
  for (const entry of engineeringAdversarialCases) {
    try { await entry.run(); checks.push({ id: entry.id, control: entry.control, status: "PASS", detail: entry.description }) }
    catch (error) { checks.push({ id: entry.id, control: entry.control, status: "FAIL", detail: String(error).slice(0,4096) }) }
  }
  const body = { schema: "usl-engineering-receipt/v1" as const, runId: `urn:uuid:${randomUUID()}`, startedAt, finishedAt: new Date().toISOString(),
    catalogDigest: contractDigest(catalog), sourceRoot: `file://${hostname()}${root}`, sourceDigests: digests, checks,
    scope: "LOCAL_USL_COUNTEREXAMPLES" as const, upstreamExecution: "NOT_TESTED" as const }
  receipt = { ...body, receiptDigest: contractDigest(body) }
}
const statuses = reviewControlStatus(catalog, receipt, digests)
const graph = buildEngineeringReviewGraph(catalog, receipt, digests), raw = JSON.stringify(graph, null, 2) + "\n"
const profile = checkResourceGraphProfile(graph, engineeringReviewProfile)
if (profile.status !== "CONFORMS") throw new Error(JSON.stringify(profile.issues))
Either.getOrThrow(adaptResourceGraph(raw, { namespace: "usl.engineering.review", profile: engineeringReviewProfile }))
const jsonld = Either.getOrThrow(resourceGraphJsonLd(raw, { namespace: "usl.engineering.review", profile: engineeringReviewProfile }))
const esc = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ")
const matrix = ["# USL 공학 보완 매트릭스", "", "이 문서는 `npm run engineering:build`가 catalog와 실제 로컬 반례 실행 영수증에서 생성한다.", "",
  "외부 40기술을 설치하거나 공격해 결함을 재현한 보고서가 아니다. 공식 자료의 범위와 통합 시 발생할 수 있는 반례를 분리하고, USL의 공통 방어 계약을 로컬에서 실행했다. 모든 항목은 남은 한계를 유지한다.", "",
  "- [원본 catalog](../research/engineering/catalog.json) · [실행 영수증](../research/engineering/receipt.json)",
  "- [탐색 가능한 resource graph](../research/engineering/graph.json) · [JSON-LD](../research/engineering/graph.jsonld)",
  "- [계약과 사용법](ENGINEERING_CONTRACTS.md)", "",
  "| ID / 기술과 출처 | 적용 한계와 반례 | USL 요구·보완 | 로컬 검증 | 남은 범위 |", "|---|---|---|---|---|",
  ...catalog.technologies.map(t => `| ${t.id} [${esc(t.title)}](${t.sources[0]}) | ${esc(t.limitation)}<br>반례: ${esc(t.attack)} | ${esc(t.requirement)} (${t.controls.join(", ")}) | ${t.controls.map(id => `${id}: ${statuses.find(s => s.id === id)!.status}`).join("; ")} | ${esc(t.residual)} |`),
  "", "## 공통 보완 코드와 테스트", "", "| 제어 | 범위 | 구현 | 반례 검사 | 남은 한계 |", "|---|---|---|---|---|",
  ...catalog.controls.map(c => `| ${c.id} ${esc(c.title)} | ${esc(c.scope)} | ${c.implementation.map(p => `[${p}](../${p})`).join(", ")} | ${c.checks.map(id => `\`${id}\``).join(", ")} | ${esc(c.residual)} |`),
  "", "검증 지위는 `HOST_REPORTED_LOCAL_TESTS`다. digest는 바이트/계약 변경 검출이며 서명이나 외부 의미의 참에 대한 증명이 아니다. `engineering:check`는 현재 소스 pin과 생성물의 일치를 확인하며, 테스트 재실행은 `engineering:build` 또는 `npm test`로 한다.", "",
].join("\n")
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"
const roleShapes = ["@prefix usl: <urn:usl:vocab:> .", "@prefix sh: <http://www.w3.org/ns/shacl#> .", "",
  `usl:EngineeringRoleShape a sh:NodeShape ; sh:targetClass usl:Link ;\n  sh:or ( ${engineeringReviewProfile.meanings.map((_, i) => `usl:EngineeringMeaning_${i}`).join(" ")} ) .`, "",
  ...engineeringReviewProfile.meanings.map((m, i) => [
    `usl:EngineeringMeaning_${i} a sh:NodeShape ;`,
    `  sh:property [ sh:path (usl:meaning usl:nativeId) ; sh:hasValue ${JSON.stringify(m.id)} ] ;`,
    `  sh:property [ sh:path (usl:participant usl:role) ; sh:in ( ${m.roles.map(r => JSON.stringify(r.role)).join(" ")} ) ] ;`,
    ...m.roles.map(r => `  sh:property [ sh:path usl:participant ; sh:qualifiedMinCount 1 ; sh:qualifiedMaxCount 1 ;\n    sh:qualifiedValueShape [\n      sh:property [ sh:path usl:role ; sh:hasValue ${JSON.stringify(r.role)} ] ;\n      sh:property [ sh:path usl:resource ; sh:class <${r.types[0]}> ]\n    ] ] ;`),
  ].join("\n").replace(/;$/, ".")), "",
].join("\n")
const outputs: Record<string, string> = {
  "research/engineering/receipt.json": json(receipt), "research/engineering/graph.json": raw,
  "research/engineering/graph.jsonld": json(jsonld), "research/engineering/profile.json": json(engineeringReviewProfile),
  "schemas/domain-profile.schema.json": json(z.toJSONSchema(domainProfileSchema)),
  "schemas/capability.schema.json": json(z.toJSONSchema(capabilitySchema)),
  "schemas/capability-catalog.schema.json": json(z.toJSONSchema(capabilityCatalogSchema)),
  "schemas/engineering-review.schema.json": json(z.toJSONSchema(engineeringCatalogSchema)),
  "schemas/engineering-receipt.schema.json": json(z.toJSONSchema(engineeringReceiptSchema)),
  "schemas/engineering-review.shacl.ttl": roleShapes,
  "docs/ENGINEERING_ADVERSARIAL_MATRIX.md": matrix,
}
for (const [file, value] of Object.entries(outputs)) {
  if (checkOnly) { if (await read(file) !== value) throw new Error(`generated artifact differs: ${file}`) }
  else await writeFile(resolve(root, file), value)
}
console.log(JSON.stringify({ technologies: catalog.technologies.length, controls: statuses.length, checks: receipt.checks.length,
  failed: receipt.checks.filter(c => c.status === "FAIL").map(c => c.id), controlStatus: [...new Set(statuses.map(s => s.status))],
  resources: graph.resources.length, links: graph.links.length, graphBytes: Buffer.byteLength(raw), jsonldBytes: Buffer.byteLength(json(jsonld)),
  profile: profile.status, mode: checkOnly ? "PINS_AND_ARTIFACTS_CHECKED" : "REPLAYED" }))
if (statuses.some(s => s.status !== "LOCAL_CHECKS_PASS")) process.exitCode = 1
