import { test } from "node:test"
import assert from "node:assert/strict"
import { Either } from "effect"
import { compileProgram, compileSource, parseProgram, semanticUid, toSemanticBundle } from "../src/language/index.js"

const source = `usl "0.1";
namespace "test.contracts";
resource repo = "git://fixture/repo";
resource concept = "kg://canonical-neo4j/sym:Concept:usl";
resource spec = "https://example.test/spec";
meaning implements(source: git_repo, concept: kg, specification: url) = "저장소가 개념을 구현한다"
  check source_review(source, specification) = "고정 revision의 코드와 명세를 대조한다"
  grounded "kg://canonical-neo4j/sym:Concept:implements"
  applies "고정 revision과 명시된 명세 버전의 범위"
  check concept_review(concept, specification) = "개념 anchor와 명세 대상을 대조한다";
link implementation = implements(source: repo, concept: concept, specification: spec);`

const compiled = (input = source) => Either.getOrThrowWith(compileSource(input), (error) => error)

test("meaning contracts declare applicability and evidence checks without changing old meaning syntax", () => {
  const plan = compiled()
  assert.deepEqual(plan.meanings[0]?.contract, {
    scope: "고정 revision과 명시된 명세 버전의 범위",
    checks: [
      { name: "source_review", evidenceRoles: ["source", "specification"], description: "고정 revision의 코드와 명세를 대조한다" },
      { name: "concept_review", evidenceRoles: ["concept", "specification"], description: "개념 anchor와 명세 대상을 대조한다" },
    ],
  })
  const legacy = compiled(source.replace(/\n  check source_review[^\n]+\n  grounded[^\n]+\n  applies[^\n]+\n  check concept_review[^;]+/, ""))
  assert.equal(legacy.meanings[0]?.contract, undefined)
})

test("meaning contract validation rejects incomplete or invalid evidence contracts", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["no checks", source.replace(/\n  check source_review[^\n]+/, "").replace(/\n  check concept_review[^;]+/, ""), /requires at least one check/],
    ["unknown evidence role", source.replace("source, specification", "source, absent"), /unknown evidence role absent/],
    ["duplicate evidence role", source.replace("source, specification", "source, source"), /duplicate evidence role source/],
    ["duplicate check", source.replace("concept_review", "source_review"), /invalid or duplicate contract check source_review/],
    ["empty scope", source.replace("고정 revision과 명시된 명세 버전의 범위", ""), /contract scope is empty/],
    ["empty procedure", source.replace("고정 revision의 코드와 명세를 대조한다", ""), /check description is empty/],
  ]
  for (const [name, input, expected] of cases) {
    const result = compileSource(input)
    assert.ok(Either.isLeft(result), name)
    assert.match(result.left.message, expected)
  }
  const parsed = Either.getOrThrow(parseProgram(source))
  const noApplies = { ...parsed, declarations: parsed.declarations.map((declaration) => declaration.tag === "meaning" ? { ...declaration, contract: { scope: "", checks: declaration.contract!.checks } } : declaration) }
  const result = compileProgram(noApplies)
  assert.ok(Either.isLeft(result)); assert.match(result.left.message, /contract scope is empty/)
})

test("KG projection preserves the complete meaning contract as JSON properties", () => {
  const plan = compiled()
  const bundle = Either.getOrThrowWith(toSemanticBundle(plan, { bundle_uid: "bundle:contracts", title: "contracts", trigger: { user_utterance_verbatim: "declare checks", utterance_date: "2026-09-08", tool: "test" } }), (error) => error)
  const meaning = bundle.nodes.find((node) => node.uid === semanticUid("test.contracts", "meaning", "implements"))!
  assert.equal(meaning.properties.contract_scope, "고정 revision과 명시된 명세 버전의 범위")
  assert.deepEqual(JSON.parse(String(meaning.properties.contract_checks_json)), plan.meanings[0]?.contract?.checks)
  assert.deepEqual(JSON.parse(String(meaning.properties.meaning_contract_json)), plan.meanings[0]?.contract)
})
