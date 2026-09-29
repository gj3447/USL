/** Offline, deterministic payload comparison. It changes no USL runtime format. */
import { readFile, writeFile } from "node:fs/promises"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib"
import { Either } from "effect"
import { compileSource } from "../src/language/compiler.js"
import { sourceFromPlan } from "../src/language/code.js"
import { compactAgentContext } from "../src/language/compact.js"
import { digestSource, planDigest } from "../src/language/digest.js"
import { agentContext, type NavigationQuery } from "../src/language/navigation.js"
import { adaptResourceGraph } from "../src/integrations/resource-graph.js"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const check = process.argv.slice(2).includes("--check")
if (process.argv.slice(2).some(arg => arg !== "--check")) throw new Error("usage: benchmark-compression.ts [--check]")
const read = (path: string) => readFile(resolve(root, path), "utf8")
const text = (value: unknown, pretty = false) => JSON.stringify(value, null, pretty ? 2 : undefined) + "\n"
const bytes = (value: string | Uint8Array) => Buffer.byteLength(value)
const unwrap = <A, E>(value: Either.Either<A, E>): A => Either.getOrThrowWith(value, error => error)
const inputs = JSON.parse(await read("research/compression/benchmark-inputs.json")) as { schema: string; fixtures: Array<any>; tokenizers: string[]; dictionaryCodec: string }
if (inputs.schema !== "usl-compression-benchmark-inputs/v1" || inputs.tokenizers.join(",") !== "cl100k_base,o200k_base") throw new Error("invalid benchmark inputs")

/** Exact JSON codec used only for a standalone benchmark lane. */
const dictionaryEncode = (value: unknown) => {
  const strings: string[] = [], seen = new Map<string, number>()
  const intern = (s: string) => { const prior = seen.get(s); if (prior !== undefined) return prior; const id = strings.length; strings.push(s); seen.set(s, id); return id }
  const encode = (v: any): any => v === null || typeof v === "boolean" || typeof v === "number" ? v
    : typeof v === "string" ? ["s", intern(v)] : Array.isArray(v) ? ["a", v.map(encode)]
    : ["o", Object.entries(v).map(([key, item]) => [intern(key), encode(item)])]
  return { schema: inputs.dictionaryCodec, strings, value: encode(value) }
}
const dictionaryDecode = (packet: any): unknown => {
  if (!packet || packet.schema !== inputs.dictionaryCodec || !Array.isArray(packet.strings)) throw new Error("invalid dictionary packet")
  const stringAt = (index: unknown) => { if (!Number.isSafeInteger(index)) throw new Error("invalid dictionary string index"); const safe = index as number; if (safe < 0 || safe >= packet.strings.length || typeof packet.strings[safe] !== "string") throw new Error("invalid dictionary string index"); return packet.strings[safe] }
  const decode = (v: any): any => !Array.isArray(v) ? v : v[0] === "s" ? stringAt(v[1])
    : v[0] === "a" ? v[1].map(decode) : v[0] === "o" ? Object.fromEntries(v[1].map(([key, item]: [number, any]) => [stringAt(key), decode(item)])) : (() => { throw new Error("invalid dictionary value") })()
  return decode(packet.value)
}
const minifyUsl = (source: string) => {
  let output = "", pendingSpace = false
  const word = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_]/.test(c)
  for (let i = 0; i < source.length;) {
    const c = source[i]!
    if (c === "/" && source[i + 1] === "/") { i = source.indexOf("\n", i); if (i < 0) break; pendingSpace = true; continue }
    if (/\s/.test(c)) { pendingSpace = true; i++; continue }
    if (pendingSpace && word(output.at(-1)) && word(c)) output += " "
    pendingSpace = false
    if (c === '"') {
      const start = i++
      let escaped = false, closed = false
      for (; i < source.length; i++) {
        const q = source[i]!
        if (!escaped && q === '"') { i++; closed = true; break }
        escaped = !escaped && q === "\\"
        if (q !== "\\") escaped = false
      }
      if (!closed) throw new Error("unterminated string")
      output += source.slice(start, i)
      continue
    }
    output += c; i++
  }
  return output + "\n"
}
const generated = (fixture: any) => {
  const resources = Array.from({ length: fixture.resources }, (_, i) => `resource r${i} = "https://example.test/${fixture.metadataLabel.replaceAll(" ", "-")}/resource-${String(i).padStart(2, "0")}";`)
  const links = Array.from({ length: fixture.links }, (_, i) => `link l${i} = related(left: r${i}, right: r${i + 1}, context: r${i + 2});`)
  return `// deterministic medium fixture; comments and blank lines are whitespace-only source overhead\n\nusl "0.1";\nnamespace "compression.generated";\n\n${resources.join("\n")}\n\nmeaning related(left: url, right: url, context: url) = "${fixture.metadataLabel}: repeated named-role relation";\n\n${links.join("\n")}\n`
}
const metrics = (payload: string) => ({ utf8Bytes: bytes(payload), gzipBytes: gzipSync(payload).byteLength, brotliBytes: brotliCompressSync(payload).byteLength,
  gzipBase64Bytes: gzipSync(payload).toString("base64").length, brotliBase64Bytes: brotliCompressSync(payload).toString("base64").length,
  payloadDigest: digestSource(payload) })
const assertBinaryRoundtrip = (payload: string, label: string) => {
  const original = Buffer.from(payload, "utf8")
  const gzip = gzipSync(original)
  const brotli = brotliCompressSync(original)
  if (!gunzipSync(gzip).equals(original)) throw new Error(`gzip byte roundtrip mismatch: ${label}`)
  if (!brotliDecompressSync(brotli).equals(original)) throw new Error(`brotli byte roundtrip mismatch: ${label}`)
}
const fixtureResult = async (fixture: any) => {
  let source: string, baseSourceDigest: string | null = null, plan: any, query: NavigationQuery
  if (fixture.kind === "resource-graph") {
    const base = await read(fixture.path); baseSourceDigest = digestSource(base)
    const graph = JSON.parse(base)
    if (fixture.metadataOverlay) {
      const resource = graph.resources.find((item: any) => item.id === fixture.metadataOverlay.resource)
      if (!resource) throw new Error(`metadata overlay resource missing: ${fixture.id}`)
      resource.metadata = { ...(resource.metadata ?? {}), ...fixture.metadataOverlay.metadata }
    }
    source = text(graph, true)
    const adapted = unwrap(adaptResourceGraph(source, { namespace: "compression.resource.graph" }))
    plan = adapted.plan
    query = { ...fixture.query, focus: adapted.identities.resources[fixture.query.focus]!, target: adapted.identities.resources[fixture.query.target]! }
  } else {
    source = fixture.kind === "generated-usl" ? generated(fixture) : await read(fixture.path)
    plan = unwrap(compileSource(source))
    query = fixture.query as NavigationQuery
  }
  const canonical = unwrap(sourceFromPlan(plan))
  const minifiedSource = fixture.kind === "resource-graph" ? text(JSON.parse(source)) : minifyUsl(source)
  const rebuilt = fixture.kind === "resource-graph" ? unwrap(adaptResourceGraph(minifiedSource, { namespace: "compression.resource.graph" })).plan : unwrap(compileSource(minifiedSource))
  if (planDigest(rebuilt) !== planDigest(plan)) throw new Error(`minified source changed plan: ${fixture.id}`)
  const full = unwrap(agentContext(plan, query))
  const compact = unwrap(compactAgentContext(plan, query, { maxBytes: 10_000_000 }))
  if (compact.mode !== "FULL") throw new Error("unexpected compact mode")
  const compactValue = JSON.parse(compact.text)
  // FULL is intentionally a transport projection: it preserves resources/meanings/links/routes/coverage/interpretation and reconstructible paths, not the full path-step objects.
  for (const key of ["namespace", "planDigest", "focus", "routes", "resources", "meanings", "links", "coverage", "interpretation"] as const) if (JSON.stringify((compactValue as any)[key]) !== JSON.stringify((full as any)[key])) throw new Error(`compact projection mismatch ${fixture.id}/${key}`)
  if (JSON.stringify(compactValue.target) !== JSON.stringify(full.target === null ? null : { resource: full.target.resource, status: full.target.status })) throw new Error(`compact target resource/status mismatch: ${fixture.id}`)
  const reconstructedPaths = compactValue.paths.map((path: any) => {
    let at = full.focus
    return { resource: path.resource, steps: path.steps.map(([linkName, enteredRole, exitedRole]: [string, string, string]) => {
      const link = compactValue.links.find((item: any) => item.name === linkName)
      const to = link.participants.find((participant: any) => participant.role === exitedRole).resource
      const step = { link: linkName, meaning: link.meaning, from: at, enteredRole, to, exitedRole }
      at = to; return step
    }) }
  })
  if (JSON.stringify(reconstructedPaths) !== JSON.stringify(full.paths)) throw new Error(`compact path reconstruction mismatch: ${fixture.id}`)
  if (full.target !== null && full.target.path !== null && JSON.stringify(reconstructedPaths.find((path: any) => path.resource === full.target!.resource)) !== JSON.stringify(full.target.path)) throw new Error(`compact target witness mismatch: ${fixture.id}`)
  const packet = dictionaryEncode(full)
  if (JSON.stringify(dictionaryDecode(packet)) !== JSON.stringify(full)) throw new Error(`dictionary roundtrip mismatch: ${fixture.id}`)
  let malformedRejected = false
  try { dictionaryDecode({ ...packet, value: ["s", packet.strings.length] }) } catch { malformedRejected = true }
  if (!malformedRejected) throw new Error(`dictionary malformed alias accepted: ${fixture.id}`)
  const unchanged = unwrap(compactAgentContext(plan, query, { maxBytes: 10_000_000, knownContextDigest: compact.contextDigest }))
  if (unchanged.mode !== "UNCHANGED") throw new Error("unchanged cache did not activate")
  const dictionaryGuide = "Decode benchmark-dictionary-table/v1: strings is a zero-based string table; [s,index] means that string, [a,items] an array, [o,[[keyIndex,value],...]] an object. Decode before using value. This is a benchmark-only codec; LLM quality is NOT_TESTED."
  const payloads = {
    "source-original": source, "source-minified": minifiedSource,
    "context-pretty": text(full, true), "context-minified": text(full), "compact-full": compact.text,
    "dictionary-table-data-needs-decoder": text(packet), "dictionary-table-standalone": text({ schema: "usl-compression-benchmark-dictionary-prompt/v1", decoderGuide: dictionaryGuide, packet }), "compact-unchanged-requires-prior-full": unchanged.text,
  }
  for (const [lane, payload] of Object.entries(payloads)) assertBinaryRoundtrip(payload, `${fixture.id}/${lane}`)
  const tokenInput: Record<string, string> = {}
  for (const [lane, payload] of Object.entries(payloads)) { tokenInput[`${fixture.id}/${lane}`] = payload; tokenInput[`${fixture.id}/${lane}/gzip-base64`] = gzipSync(payload).toString("base64"); tokenInput[`${fixture.id}/${lane}/brotli-base64`] = brotliCompressSync(payload).toString("base64") }
  return { id: fixture.id, input: { kind: fixture.kind, path: fixture.path ?? null, baseSourceDigest, metadataOverlay: fixture.metadataOverlay ?? null, sourceDigest: digestSource(source), minifiedSourceDigest: digestSource(minifiedSource), canonicalSourceDigest: digestSource(canonical), planDigest: planDigest(plan), generatedParameters: fixture.kind === "generated-usl" ? { resources: fixture.resources, links: fixture.links, metadataLabel: fixture.metadataLabel } : null },
    guarantees: { source: fixture.kind === "resource-graph" ? "RESOURCE_GRAPH_PRETTY_AND_MINIFIED_SAME_ADAPTED_PLAN_DIGEST" : "USL_SOURCE_AND_TOKENIZER_SAFE_WHITESPACE_MINIFIED_SOURCE_SAME_PLAN_DIGEST", contextPrettyAndMinified: "EXACT_JSON_VALUE", dictionaryTable: "EXACT_JSON_ROUNDTRIP; STANDALONE_LANE_INCLUDES_DECODER_GUIDE; LLM_QUALITY_NOT_TESTED", compactFull: "TRANSPORT_PROJECTION_WITH_RECONSTRUCTIBLE_PATHS_AND_TARGET_WITNESS", compactUnchanged: "REQUIRES_RECEIVER_PRIOR_FULL_CONTEXT" }, lanes: Object.fromEntries(Object.entries(payloads).map(([lane, payload]) => [lane, metrics(payload)])), tokenInput }
}
const fixtures = await Promise.all(inputs.fixtures.map(fixtureResult))
const tokenTexts = Object.assign({}, ...fixtures.map(item => item.tokenInput))
const python = process.env.USL_TIKTOKEN_PYTHON ?? "python3"
const tokens = spawnSync(python, [resolve(root, "scripts/count-compression-tokens.py")], { input: JSON.stringify({ encodings: inputs.tokenizers, texts: tokenTexts }), encoding: "utf8" })
if (tokens.status !== 0) throw new Error(`offline tokenizer failed (${python}): ${tokens.stderr || tokens.error}`)
const counted = JSON.parse(tokens.stdout)
const results = { schema: "usl-compression-benchmark-results/v1", scope: "OFFLINE_PAYLOAD_MEASUREMENT_NOT_RUNTIME_MEMORY_OR_BILLED_USAGE", validationStatus: "FIXTURE_ROUNDTRIPS_PASSED", environment: { node: process.version, pythonVersion: counted.pythonVersion, tiktokenVersion: counted.tiktokenVersion, encodings: inputs.tokenizers, tokenCounting: "tiktoken.encode_ordinary; comparison baseline only, not billed API usage", compression: ["gzip", "brotli"], memory: "HEAP_NOT_MEASURED" }, inputs: { digest: digestSource(await read("research/compression/benchmark-inputs.json")), benchmarkScriptDigest: digestSource(await read("scripts/benchmark-compression.ts")), tokenScriptDigest: digestSource(await read("scripts/count-compression-tokens.py")), requirementsDigest: digestSource(await read("scripts/requirements-compression.txt")) }, fixtures: fixtures.map(({ tokenInput, ...item }) => ({ ...item, tokens: Object.fromEntries(inputs.tokenizers.map(encoding => [encoding, Object.fromEntries(Object.keys(item.lanes).map(lane => [lane, { text: counted.encodings[encoding][`${item.id}/${lane}`], gzipBase64: counted.encodings[encoding][`${item.id}/${lane}/gzip-base64`], brotliBase64: counted.encodings[encoding][`${item.id}/${lane}/brotli-base64`] }]))])) })) }
const output = text(results, true), out = "research/compression/benchmark-results.json"
if (check) { if (await read(out) !== output) throw new Error("benchmark results differ; rerun benchmark-compression.ts") } else await writeFile(resolve(root, out), output)
console.log(JSON.stringify({ fixtures: fixtures.length, tokenizers: inputs.tokenizers, mode: check ? "CHECKED" : "MEASURED" }))
