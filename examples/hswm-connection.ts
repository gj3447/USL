/** Read the registered HSWM research connection without executing its research programs. */
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { Effect } from "effect"
import { connectUsl } from "../src/adapters.js"
import { readUtf8Bounded } from "../src/bounded-read.js"
import { bindCliResourceGraph, inspectCliBinding } from "../src/cli-host.js"
import { adaptResourceGraph } from "../src/integrations/resource-graph.js"
import type { ResourceRepresentationSelection } from "../src/resource-bindings.js"

const directory = new URL("../connections/hswm/", import.meta.url)
const { values } = parseArgs({ options: { config: { type: "string" } }, strict: true, allowPositionals: false })
const config = values.config ?? fileURLToPath(new URL("host.json", directory))
const read = (name: string) => readUtf8Bounded(fileURLToPath(new URL(name, directory)), 1024 * 1024)
const selections = JSON.parse(await read("local-selections.json")) as ResourceRepresentationSelection[]
const rebound = await bindCliResourceGraph(config, await read("graph.json"), selections)
const observations = []
for (const selection of selections) observations.push(await inspectCliBinding(config, selection))

const usl = connectUsl({
  read: () => Effect.succeed(JSON.stringify(rebound.graph)),
  adapt: raw => adaptResourceGraph(raw, { namespace: "gj3447.hswm.research" }),
})
const context = await Effect.runPromise(usl.context(undefined, {
  focus: "hswm:research-plan", target: "hswm:selected-test",
}, { compact: true }))
const files = observations.filter(observation => observation.content.kind === "file")
const matches = files.filter(observation => observation.content.pinStatus === "MATCH").length
const status = matches === files.length ? "SELECTED_CONTENT_PINS_MATCH" : "SELECTED_CONTENT_DRIFT"
const sourceReceipt = JSON.parse(await read("source-receipt.json"))
const localGit = observations.find(observation => observation.resource === "github:repo:1305437076")?.git

console.log(JSON.stringify({
  status,
  repository: "https://github.com/gj3447/HSWM",
  registeredConfig: config,
  snapshot: sourceReceipt.snapshot,
  localGit,
  headMatchesRecordedSnapshot: localGit?.state === "REPOSITORY" && localGit.head === sourceReceipt.snapshot.commit,
  resources: rebound.graph.resources.length,
  links: rebound.graph.links.length,
  filesMatchingRecordedSnapshot: `${matches}/${files.length}`,
  bindings: observations.map(({ resource, representation, locator, content }) => ({ resource, representation, locator, content })),
  bindingReceiptDigest: rebound.bindingReceipt.digest,
  context: context.result,
  researchExecution: "NOT_EXECUTED",
  leanProofReplay: "NOT_RUN",
}, null, 2))
if (status !== "SELECTED_CONTENT_PINS_MATCH") process.exitCode = 2
