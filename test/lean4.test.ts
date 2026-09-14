import { test } from "node:test"
import assert from "node:assert/strict"
import { Either } from "effect"
import { adaptLean4Export, lean4ResourceGraph, leanDeclarationId, type Lean4AdaptOptions } from "../src/integrations/lean4.js"
import { agentContext } from "../src/language/navigation.js"
import { planDigest, digestSource } from "../src/language/digest.js"

const options: Lean4AdaptOptions = { namespace: "lean.test", source: { id: "proofs", locator: "file://fixture/Proof.lean" },
  bindings: [{ declaration: "Demo.theorem", description: "Formalization of the specification.",
    resource: { id: "spec", types: ["urn:example:Requirement"], locator: "kg://fixture/spec" } }] }
const source = (axioms: string[] = []) => JSON.stringify({ schema: "usl-lean4-export/v1", leanVersion: "4.33.1",
  declarations: [{ name: "Demo.theorem", kind: "theorem", type: "True", axioms, unsafe: false, partial: false }] })

test("Lean declarations connect to external resources without assuming correspondence is proved", () => {
  const graph = Either.getOrThrow(adaptLean4Export(source(), options))
  const name = graph.identities.resources[leanDeclarationId("proofs", "Demo.theorem")]!
  const result = Either.getOrThrow(agentContext(graph.plan, { focus: graph.identities.resources.spec!, target: name }))
  assert.equal(result.target?.status, "FOUND")
  assert.equal(result.interpretation.semanticTruth, "NOT_EVALUATED")
  assert.equal(graph.source.digest, digestSource(source()))
  assert.match(JSON.stringify(result.meanings), /Demo.theorem/)
})

test("sorry and custom axioms remain visible and change the meaning digest", () => {
  const raw = source(["sorryAx", "Demo.assumption"])
  const graph = Either.getOrThrow(lean4ResourceGraph(raw, options))
  const theorem = graph.resources.find(resource => resource.id === leanDeclarationId("proofs", "Demo.theorem"))!
  assert.equal(theorem.metadata?.proofStatus, "USES_SORRY")
  assert.deepEqual(theorem.metadata?.axioms, ["sorryAx", "Demo.assumption"])
  assert.notEqual(planDigest(Either.getOrThrow(adaptLean4Export(raw, options)).plan), planDigest(Either.getOrThrow(adaptLean4Export(source(), options)).plan))
})

test("unknown declarations, conflicting resources and malformed exports are refused", () => {
  assert.ok(Either.isLeft(adaptLean4Export(source(), { ...options, bindings: [{ ...options.bindings![0]!, declaration: "unknown" }] })))
  const duplicate = JSON.parse(source()); duplicate.declarations.push(duplicate.declarations[0])
  assert.ok(Either.isLeft(adaptLean4Export(JSON.stringify(duplicate), options)))
  const bad = JSON.parse(source()); bad.declarations[0].unsafe = "false"
  assert.ok(Either.isLeft(adaptLean4Export(JSON.stringify(bad), options)))
})
