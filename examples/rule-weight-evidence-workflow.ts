import { ruleWeightEvidenceFixture } from "./rule-weight-evidence-fixture.js"

const { evaluation, evidence, proposal } = ruleWeightEvidenceFixture()
console.log(JSON.stringify({ fixture: "SYNTHETIC_FIXED_CLOCK", policyPenalty: evaluation.penalty,
  separatelyObservedOutcome: evidence.outcome, proposal }, null, 2))
