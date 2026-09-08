import { test } from "node:test"
import assert from "node:assert/strict"
import { Effect, Either } from "effect"
import { compileSource, compileProgram, parseProgram, observeProgram, toSemanticBundle, semanticUid } from "../src/language/index.js"
import { fixture } from "./fixtures.js"

const program = `usl "0.1";
namespace "test.language";
// Forward references and Unicode descriptions are allowed.
link implementation = implements(from: code, to: concept);
resource concept = "kg://canonical-neo4j/sym:Concept:usl";
resource code = "git://fixture/repo";
meaning implements(from: git_repo, to: kg) = "저장소가 개념을 구현한다";
`
const compiled = (source = program) => Either.getOrThrowWith(compileSource(source), (e) => e)

test("USL compiles heterogeneous resources and a meaning-bearing link independently of declaration order", () => {
  const plan = compiled()
  assert.equal(plan.resources[1]?.locator.kind, "git_repo")
  assert.deepEqual(plan.meanings[0]?.roles, [{ name: "from", kind: "git_repo" }, { name: "to", kind: "kg" }])
  assert.deepEqual(plan.links[0], { name: "implementation", meaning: "implements", participants: [{ role: "from", resource: "code" }, { role: "to", resource: "concept" }] })
  assert.equal(plan.declarationStatus, "DECLARED")
  assert.deepEqual(compiled(), plan)
})

const invalid: Array<[string, string, RegExp]> = [
  ["role type", program.replace("from: code", "from: concept"), /expected git_repo, got kg/],
  ["missing role", program.replace("from: code, to: concept", "from: code"), /missing participant role/],
  ["duplicate role", program.replace("from: code, to: concept", "from: code, from: code"), /duplicate participant/],
  ["unknown resource", program.replace("from: code", "from: missing"), /undeclared resource/],
  ["unknown meaning", program.replace("= implements(", "= missing("), /undeclared meaning/],
  ["duplicate declaration", program + 'resource code = "https://example.test";', /duplicate declaration/],
  ["empty meaning", program.replace("저장소가 개념을 구현한다", ""), /description is empty/],
  ["invalid grounding", program.replace('"저장소가 개념을 구현한다";', '"구현" grounded "https://example.test";'), /must be a KG locator/],
  ["language version", program.replace('usl "0.1"', 'usl "100"'), /unsupported USL language version/],
]
for (const [name, source, error] of invalid) test(`USL rejects ${name} before any IO`, () => {
  const result = compileSource(source)
  assert.ok(Either.isLeft(result)); assert.match(result.left.message, error)
})

test("parser reports source location and respects URL/string comment boundaries", () => {
  const result = parseProgram('usl "0.1";\nnamespace "x";\nresource r = "unterminated')
  assert.ok(Either.isLeft(result)); assert.equal(result.left.line, 3); assert.equal(result.left.phase, "parse")
  const plan = compiled(program + 'resource url = "https://example.test/a//b"; // comment\n')
  assert.equal(plan.resources.at(-1)?.locator.kind, "url")
})

test("role-bearing links support multiple participants and intentional resource aliasing", () => {
  const plan = compiled(`usl "0.1"; namespace "roles";
    resource a = "https://example.test"; resource b = "https://example.test";
    meaning refers(subject: any, evidence: url, context: any) = "명시적 참조";
    link l = refers(context: a, evidence: b, subject: a);`)
  assert.deepEqual(plan.links[0]?.participants.map((p) => p.role), ["subject", "evidence", "context"])
  const ast = Either.getOrThrow(parseProgram(program))
  const malformed = { ...ast, declarations: ast.declarations.map((d) => d.tag === "link" ? { ...d, meaning: "bad name" } : d) }
  assert.ok(Either.isLeft(compileProgram(malformed)))
})

test("Effect observation resolves references without asserting semantic truth", async (t) => {
  const f = await fixture(t)
  const plan = compiled(`usl "0.1"; namespace "observed";
    resource concept = ${JSON.stringify(f.loc.kg)}; resource code = ${JSON.stringify(f.loc.git)};
    meaning implements(from: git_repo, to: kg) = "구현한다" grounded ${JSON.stringify(f.loc.kg)};
    link l = implements(from: code, to: concept);`)
  const result = await f.run(observeProgram(plan))
  assert.equal(result.status, "RESOLVES"); assert.equal(result.links[0]?.resourcesResolve, true)
  assert.equal(result.semanticTruth, "NOT_EVALUATED"); assert.equal(result.links[0]?.semanticTruth, "NOT_EVALUATED")
  assert.equal(plan.declarationStatus, "DECLARED")
  f.state.kgMissing = true
  const missing = await f.run(observeProgram(plan))
  assert.equal(missing.status, "UNRESOLVED"); assert.equal(missing.groundings[0]?.status, "ORPHAN")
})

const options = { bundle_uid: "bundle:usl:test", title: "test", trigger: { user_utterance_verbatim: "connect these resources", utterance_date: "2026-09-07", tool: "test" } }
test("KG projection preserves meanings, roles and resource identities as pending declarations", () => {
  const bundle = Either.getOrThrowWith(toSemanticBundle(compiled(), options), (e) => e)
  assert.equal(bundle.nodes.length, 4)
  const meaning = bundle.nodes.find((n) => n.uid === semanticUid("test.language", "meaning", "implements"))!
  assert.equal(meaning.properties.description, "저장소가 개념을 구현한다")
  assert.deepEqual(meaning.properties.role_kinds, ["git_repo", "kg"])
  assert.ok(bundle.relations.some((r) => r.to_uid === "sym:Concept:usl" && r.type === "LONGINUS_BINDS"))
  const participants = bundle.relations.filter((r) => (r.properties as Record<string, unknown>).role === "participant")
  assert.equal(participants.length, 2)
  for (const n of bundle.nodes) {
    assert.equal(n.properties.canonical_scope, "PENDING_OR_PRELIMINARY")
    assert.equal(n.properties.review_required, true)
    for (const value of Object.values(n.properties)) assert.ok(typeof value === "string" || typeof value === "boolean" || Array.isArray(value))
  }
  const known = new Set([...bundle.anchors, ...bundle.nodes.map((n) => n.uid)])
  for (const edge of bundle.relations) { assert.ok(known.has(String(edge.from_uid))); assert.ok(known.has(String(edge.to_uid))) }
})

test("KG projection keeps foreign source UIDs distinct and preserves author source hash", () => {
  const source = program.replace("kg://canonical-neo4j/", "kg://foreign/")
  const plan = compiled(source)
  const rejected = toSemanticBundle(plan, options)
  assert.ok(Either.isLeft(rejected)); assert.match(rejected.left.message, /foreign KG locator/)
  const bundle = Either.getOrThrowWith(toSemanticBundle(plan, { ...options, source: { name: "example.usl", text: source }, kgAnchors: { "kg://foreign/sym:Concept:usl": "sym:External:foreign-usl" } }), (e) => e)
  assert.ok(bundle.anchors.includes("sym:External:foreign-usl"))
  assert.equal(bundle.nodes[0]?.properties.source_name, "example.usl")
  assert.equal(bundle.nodes[0]?.properties.source_hash_kind, "USL_SOURCE")
})
