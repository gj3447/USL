/** A portable, host-registered CLI action that runs USL's own `check` command once. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { contractDigest } from "../src/contract-core.js"
import { digestSource } from "../src/language/digest.js"
import { Either } from "effect"
import { parseGraphEngineeringSource } from "../src/integrations/graph-engineering.js"
import type { CapabilityDescriptor } from "../src/capabilities.js"
import type { CliHostConfig } from "../src/cli-host.js"
import { executeCliAction, inspectCliBinding, planCliAction } from "../src/cli-host.js"
import { inspectCliAttempt } from "../src/cli-recovery.js"

const { values } = parseArgs({ options: { "out-dir": { type: "string" } }, allowPositionals: false })
const root = fileURLToPath(new URL("../", import.meta.url)), retained = values["out-dir"] !== undefined
const scratch = retained ? resolve(values["out-dir"]!) : await mkdtemp(join(tmpdir(), "usl-cli-workflow-"))
if (retained) await mkdir(scratch, { mode: 0o700 })
const digest = (text: string) => digestSource(text)
const idPart = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16)
const filesBelow = async (directory: string): Promise<string[]> => {
  const entries = await readdir(join(root, directory), { withFileTypes: true })
  const children = await Promise.all(entries.map(async entry => {
    const child = join(directory, entry.name)
    return entry.isDirectory() ? filesBelow(child) : entry.isFile() && child.endsWith(".ts") ? [child] : []
  }))
  return children.flat()
}
try {
  const sourcePath = "examples/fixtures/game-workflow/game-workflow.usl", cliPath = "src/cli.ts"
  // Pin the complete local TypeScript runtime, package manifest and lockfile.
  // This still does not attest the installed node_modules tree.
  const runtimePaths = [...await filesBelow("src"), "package.json", "package-lock.json", sourcePath].sort()
  const sourceTexts = new Map(await Promise.all(runtimePaths.map(async file => [file, await readFile(join(root, file), "utf8")] as const)))
  const graphText = await readFile(join(root, "examples/fixtures/cli/graphspec.json"), "utf8")
  const graph = Either.getOrThrowWith(parseGraphEngineeringSource(graphText), error => error)
  await writeFile(join(scratch, "graph.json"), graphText)
  const sourceResources = runtimePaths.map(file => ({ id: `urn:usl:runtime:${file}`, representations: [{ id: `runtime-${idPart(file)}`, relation: "working-copy", kind: "workspace", workspace: "repo", path: file, digest: digest(sourceTexts.get(file)!) }] }))
  const selectionFor = (file: string) => ({ resource: `urn:usl:runtime:${file}`, representation: `runtime-${idPart(file)}` })
  const bindings = { schema: "usl-resource-bindings/v1", resources: [
    { id: "graph", representations: [{ id: "graph-local", relation: "working-copy", kind: "workspace", workspace: "scratch", path: "graph.json" }] },
    { id: "repo", representations: [{ id: "repo-local", relation: "working-copy", kind: "workspace", workspace: "repo", path: "." }] },
    ...sourceResources,
  ] }
  await writeFile(join(scratch, "bindings.json"), JSON.stringify(bindings))
  const descriptor: CapabilityDescriptor = { schema: "usl-capability/v1", id: "usl-check", version: "1", connection: "local-example", nativeOperation: "usl check", sourceDigest: digest(graphText), kind: "ACTION", effect: "READ", meanings: ["urn:usl:check"], requiredScopes: ["repo:read"], input: { types: ["urn:usl:NoInput"], schema: true }, output: { types: ["urn:usl:CheckResult"], schema: { type: "object", properties: { valid: { type: "boolean" }, namespace: { type: "string" }, resources: { type: "number" }, meanings: { type: "number" }, links: { type: "number" } }, required: ["valid", "namespace", "resources", "meanings", "links"], additionalProperties: false } }, mapping: { completeness: "COMPLETE", losses: [], unsupported: [] } }
  const policy: CliHostConfig["actions"][number]["policy"] = { connection: "local-example", capabilityId: "usl-check", descriptorDigest: contractDigest(descriptor), sourceDigest: descriptor.sourceDigest, allowedEffects: ["READ"], allowedScopes: ["repo:read"], allowLossy: false, maxInputBytes: 4096, maxOutputBytes: 16384, timeoutMs: 10000 }
  const config: CliHostConfig = { schema: "usl-cli-host/v1", bindings: "bindings.json", workspaces: { repo: root, scratch }, maxSourceBytes: 1024 * 1024,
    operations: { namespace: "usl-example", directory: "operations" },
    actions: [{ id: "usl-check", descriptor, policy, graph: { source: { resource: "graph", representation: "graph-local" }, sourceDigest: digest(graphText), graphId: graph.graphId, graphspecDigest: graph.graphspecDigest, node: "usl_check", scope: "ENTRY_NODE_ONLY" }, cwd: { resource: "repo", representation: "repo-local" }, command: { executable: "node", args: ["--import", "tsx", selectionFor(cliPath), "check", "--source", selectionFor(sourcePath)], envAllowlist: [] }, pins: runtimePaths.map(file => ({ source: selectionFor(file), digest: digest(sourceTexts.get(file)!) })) }] }
  const configPath = join(scratch, "host.json"), request = { descriptorDigest: policy.descriptorDigest, sourceDigest: descriptor.sourceDigest, input: { types: ["urn:usl:NoInput"], value: {} } }
  await writeFile(configPath, JSON.stringify(config))
  await writeFile(join(scratch, "invocation.json"), JSON.stringify(request, null, 2) + "\n")
  const plan = await planCliAction(configPath, "usl-check", request)
  if (plan.status !== "READY") throw new Error(JSON.stringify(plan))
  await writeFile(join(scratch, "plan.json"), JSON.stringify(plan, null, 2) + "\n")
  const binding = await inspectCliBinding(configPath, selectionFor(sourcePath))
  const operationKey = "example-check-1"
  const receipt = await executeCliAction(configPath, "usl-check", request, plan.planDigest, join(scratch, "receipt"), { operationKey })
  if (receipt.status !== "SUCCEEDED") throw new Error(JSON.stringify(receipt))
  const inspection = await inspectCliAttempt(join(scratch, "receipt"))
  const duplicate = await executeCliAction(configPath, "usl-check", request, plan.planDigest, join(scratch, "duplicate"), { operationKey })
  if (duplicate.status !== "REJECTED" || duplicate.reason !== "OPERATION_ALREADY_RESERVED") throw new Error(JSON.stringify(duplicate))
  console.log(JSON.stringify({ plan: plan.status, execution: receipt.status, output: receipt.output,
    binding: { resource: binding.resource, pin: binding.content.pinStatus, git: binding.git?.state ?? null },
    inspection: inspection.recordedStatus, duplicate: duplicate.reason, operationKey,
    graphExecution: receipt.graph.wholeGraphExecution,
    receiptDirectory: retained ? join(scratch, "receipt") : "temporary; removed after output",
    ...(retained ? { config: configPath, invocation: join(scratch, "invocation.json"), planFile: join(scratch, "plan.json") } : {}),
  }, null, 2))
} finally {
  // Keep the directory only while this example is running; receipt contents are reported above.
  if (!retained) await rm(scratch, { recursive: true, force: true })
}
