import { test } from "node:test"
import assert from "node:assert/strict"
import { runEngineeringWorkflow } from "../examples/engineering-workflow.js"

test("code + real GraphSpec fixture + scoped observation produce an HSWM handoff without reading the KG", async () => {
  const result = await runEngineeringWorkflow()
  assert.equal(result.summary.boundFunctionPreserved, true)
  assert.equal(result.report.status, "RESOLVES")
  assert.equal(result.report.metrics.resolverCalls, 4)
  assert.ok(result.plan.resources.some((r) => r.locator.kind === "kg"))
  assert.ok(result.report.resources.every((r) => r.resolution?.locator.kind === "filesystem"))
  assert.equal(result.handoff.policy.bindings.length, 2)
  assert.equal(result.report.semanticTruth, "NOT_EVALUATED")
  assert.equal(result.graph.guarantees.execution, "NOT_EXECUTED")
  assert.ok(result.summary.unchanged.deliveredBytes < result.summary.context.deliveredBytes)
})
