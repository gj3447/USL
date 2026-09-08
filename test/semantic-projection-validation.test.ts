import { test } from "node:test"
import assert from "node:assert/strict"
import { Either } from "effect"
import { compileSource, toSemanticBundle } from "../src/language/index.js"
import { sha256 } from "../src/resolve.js"

const options = {
  bundle_uid: "bundle:semantic-projection",
  title: "semantic projection",
  trigger: { user_utterance_verbatim: "project this declaration", utterance_date: "2026-09-08", tool: "test" },
}

const source = (description: string) => `usl "0.1";
namespace "projection.validation";
resource implementation = "git://fixture/repo";
resource contract = "kg://canonical-neo4j/sym:Concept:contract";
meaning implements(from: git_repo, to: kg) = "${description}";
link implementation_link = implements(from: implementation, to: contract);
`

const planFor = (text: string) => Either.getOrThrowWith(compileSource(text), (error) => error)

test("semantic projection rejects a source whose opposite meaning did not produce the supplied plan", () => {
  const implementationSource = source("구현이 계약을 구현한다")
  const contradicts = source("구현이 계약을 구현하지 않는다")
  const projected = toSemanticBundle(planFor(implementationSource), { ...options, source: { name: "contradicts.usl", text: contradicts } })

  assert.ok(Either.isLeft(projected))
  assert.match(projected.left.message, /source does not match the semantic plan/)
})

test("semantic projection accepts matching source and records the digest of that source", () => {
  const text = source("구현이 계약을 구현한다")
  const bundle = Either.getOrThrowWith(toSemanticBundle(planFor(text), { ...options, source: { name: "implements.usl", text } }), (error) => error)

  for (const node of bundle.nodes) {
    assert.equal(node.properties.source_hash_kind, "USL_SOURCE")
    assert.equal(node.properties.source_sha256, sha256(text))
    assert.equal(node.properties.source_name, "implements.usl")
  }
})

test("semantic projection snapshots the plan and source option before accessors can change caller data", () => {
  const initialText = source("구현이 계약을 구현한다")
  const changedText = source("구현이 계약을 구현하지 않는다")
  const plan = planFor(initialText)
  const mutablePlan = plan as unknown as { meanings: Array<{ description: string }> }
  let sourceReads = 0
  const changingOptions = {
    ...options,
    get source() {
      sourceReads += 1
      if (sourceReads > 1) return { name: "changed.usl", text: changedText }
      return {
        name: "initial.usl",
        get text() {
          mutablePlan.meanings[0]!.description = "호출자 변경 값"
          return initialText
        },
      }
    },
  }

  const bundle = Either.getOrThrowWith(toSemanticBundle(plan, changingOptions), (error) => error)
  const meaning = bundle.nodes.find((node) => node.properties.name === "implements")!
  assert.equal(sourceReads, 1)
  assert.equal(meaning.properties.description, "구현이 계약을 구현한다")
  assert.equal(meaning.properties.source_name, "initial.usl")
  assert.equal(meaning.properties.source_sha256, sha256(initialText))
})

test("semantic projection remains compatible without source text and hashes its plan snapshot", () => {
  const plan = planFor(source("구현이 계약을 구현한다"))
  const expected = sha256(JSON.stringify(plan))
  const bundle = Either.getOrThrowWith(toSemanticBundle(plan, options), (error) => error)

  for (const node of bundle.nodes) {
    assert.equal(node.properties.source_hash_kind, "COMPILED_PLAN")
    assert.equal(node.properties.source_sha256, expected)
    assert.equal(node.properties.source_name, "compiled-plan")
  }
})
