/** Regenerate declared synthetic inputs. Running the external learner is a separate explicit operation. */
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { ruleWeightReviewFixture } from "../examples/rule-weight-review-fixture.js"

if (process.argv.length !== 2) throw new Error("usage: prepare-rule-weight-review-fixture.ts")
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../examples/fixtures/rule-weight-review")
await mkdir(root, { recursive: true })
const { files } = ruleWeightReviewFixture()
for (const [name, raw] of Object.entries(files)) await writeFile(resolve(root, name), raw)
console.log(JSON.stringify({ scope: "SYNTHETIC_INPUTS_ONLY", files: Object.keys(files), learnerExecuted: false }))
