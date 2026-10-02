import { readFile } from "node:fs/promises"
import { evaluateRulePolicy, readRulePolicyBinding } from "../src/addons/rule-policy.js"
import { configurationId, dashboardEvaluators, dashboardPolicy, observeDashboardTarget } from "./rule-policy-fixture.js"
import { digestSource } from "../src/language/digest.js"
import { contractDigest } from "../src/contract-core.js"

const graph = JSON.parse(await readFile(new URL("./fixtures/rule-policy/graph.json", import.meta.url), "utf8"))
const raw = await readFile(new URL("./fixtures/rule-policy/target.json", import.meta.url), "utf8")
const policy = readRulePolicyBinding(graph, configurationId)
const observations = observeDashboardTarget(policy, raw, new Date().toISOString())
// The consumer independently supplies its identity, scope, snapshot and supported evaluators.
const report = evaluateRulePolicy(policy, observations, { expectedPolicyDigest: contractDigest(dashboardPolicy()), consumer: "example:dashboard-consumer", target: "example:dashboard-memory",
  targetDigest: digestSource(raw), scope: "example-memory-quality", supportedEvaluators: dashboardEvaluators })
console.log(JSON.stringify(report, null, 2))
