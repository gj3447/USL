// Run after npm run build. Uses temporary local files and the existing HSWM
// Python consumer; does not modify a KG or HSWM service or persist a USL plan.
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir, hostname } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { Effect, Either } from "effect"
import { connectUsl } from "usl/adapters"
import { adaptPropertyGraph } from "usl/property-graph"
import { DEFAULT_USL_POLICY, planDigest, hswmDigest, formatLocator, digestSource } from "usl"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"

const dir = await mkdtemp(join(tmpdir(), "usl-native-smoke-"))
try {
  const a = join(dir, "a.ts"), b = join(dir, "b.md"), graphFile = join(dir, "kg-result.json")
  await writeFile(a, "export const dash = 1\n"); await writeFile(b, "Dash specification\n")
  const locators = [`file://${hostname()}${a}`, `file://${hostname()}${b}`]
  const raw = JSON.stringify({ nodes: [
    { uid: "code:dash", properties: { locator: locators[0] } }, { uid: "spec:dash", properties: { locator: locators[1] } },
  ], relations: [{ uid: "dash:implements", from_uid: "code:dash", to_uid: "spec:dash", type: "IMPLEMENTS", properties: { description: "Code implements the specification" } }] })
  await writeFile(graphFile, raw)
  const base = ["adapt", "--graph", graphFile, "--namespace", "game.native.smoke"]
  const cli = (args, expected = 0) => {
    const result = spawnSync(process.execPath, [resolve("dist/src/cli.js"), ...args], { encoding: "utf8", env: { ...process.env, USL_HOSTNAME: hostname() } })
    assert.equal(result.status, expected, result.stderr)
    return result.stdout ? JSON.parse(result.stdout) : null
  }
  assert.equal(cli(base).result.valid, true)
  const context = cli([...base, "--operation", "context", "--focus", "code:dash", "--target", "spec:dash"])
  assert.equal(context.result.target.status, "FOUND")
  const denied = cli([...base, "--operation", "observe", "--link", "dash:implements", "--deny-all"], 2)
  const observed = cli([...base, "--operation", "observe", "--link", "dash:implements", "--allow-locator", locators[0], "--allow-locator", locators[1]])
  assert.equal(denied.result.metrics.resolverCalls, 0)
  assert.equal(observed.result.metrics.resolverCalls, 2)
  assert.equal(observed.result.sourceDigest, null)
  assert.equal(observed.receipt.sourceDigest, digestSource(raw))
  cli([...base, "--out", graphFile], 64)
  assert.equal(await readFile(graphFile, "utf8"), raw)
  cli([...base, "--operation", "check", "--link", "dash:implements"], 64)

  const beforeFile = join(dir, "before.json"), afterFile = join(dir, "after.json")
  await writeFile(beforeFile, JSON.stringify(observed))
  const validation = cli(["validate-observation", "--report", beforeFile])
  assert.equal(validation.valid, true)
  assert.equal(validation.nativeSource.digest, digestSource(raw))
  const reversed = JSON.parse(raw)
  reversed.relations[0].from_uid = "spec:dash"
  reversed.relations[0].to_uid = "code:dash"
  await writeFile(graphFile, JSON.stringify(reversed))
  const after = cli([...base, "--operation", "observe", "--link", "dash:implements", "--allow-locator", locators[0], "--allow-locator", locators[1]])
  await writeFile(afterFile, JSON.stringify(after))
  const comparison = cli(["compare", "--before", beforeFile, "--after", afterFile])
  assert.equal(comparison.links[0].semanticContractChanged, true)
  assert.notEqual(comparison.nativeSources.before.digest, comparison.nativeSources.after.digest)
  await writeFile(graphFile, raw)

  const snapshot = Either.getOrThrow(adaptPropertyGraph(raw, { namespace: "game.native.smoke" }))
  // Fixture authority independently pins known file bytes before observation.
  const pins = await Promise.all(snapshot.plan.resources.map(async resource => ({ name: resource.name,
    content_hash: createHash("sha256").update(await readFile(resource.locator.path)).digest("hex"),
    resolved_locator: formatLocator(resource.locator) })))
  const authority = { policy: {
    schema_version: "hswm-usl-observation-policy/v2", namespace: snapshot.plan.namespace,
    plan_digest: hswmDigest(snapshot.plan), usl_plan_digest: planDigest(snapshot.plan), source_digest: null, max_age_seconds: 60,
    bindings: [{ link: snapshot.identities.links["dash:implements"], role: "game_reference", field: "available" }], resources: pins,
  }, allowed_reads: [["game_reference", "available"]], revision: "native-adapter-smoke" }
  const usl = connectUsl({ read: () => Effect.tryPromise(() => readFile(graphFile, "utf8")),
    adapt: source => adaptPropertyGraph(source, { namespace: "game.native.smoke" }),
    policy: { ...DEFAULT_USL_POLICY, allowedLocators: locators } })
  const handoff = await Effect.runPromise(usl.hswm(undefined, { links: ["dash:implements"] }, authority))
  const python = `import json,sys
from hswm.infrastructure.usl_adapter import adapt_usl,Reject
x=json.load(sys.stdin);x['allowed_reads']=set(tuple(v) for v in x['allowed_reads'])
try: print(json.dumps({'ok':True,'result':adapt_usl(**x)},sort_keys=True))
except Reject as e: print(json.dumps({'ok':False,'error':str(e)},sort_keys=True))`
  const consume = value => JSON.parse(execFileSync("python3", ["-c", python], { input: JSON.stringify(value), encoding: "utf8", env: { ...process.env, PYTHONPATH: "/home/lagyeongjun/CD/HSWM/src" } }))
  const hswm = consume(handoff.result)
  assert.equal(hswm.ok, true, JSON.stringify(hswm))
  assert.equal(hswm.result.status, "READY", JSON.stringify(hswm))
  assert.equal(hswm.result.usl.source_binding, "ABSENT")
  const wrong = structuredClone(handoff.result); wrong.policy.source_digest = digestSource(raw)
  const wrongSourcePin = consume(wrong)
  assert.equal(wrongSourcePin.ok, false)
  const future = consume({ ...handoff.result, now: handoff.result.now - 30 })
  assert.notEqual(future.result?.status, "READY")

  const launch = JSON.parse(await readFile("examples/mcp-adapter-client.json", "utf8")).mcpServers.usl
  const client = new Client({ name: "native-adapter-client", version: "1.0.0" })
  let mcp
  await client.connect(new StdioClientTransport({ ...launch, cwd: "/var/tmp", stderr: "pipe" }))
  try {
    const call = await client.callTool({ name: "context", arguments: { connection: "game", query: { focus: "game:dash", target: "checkout:game" }, compact: true } })
    assert.equal(call.isError, undefined, JSON.stringify(call))
    const body = JSON.parse(call.content[0].text)
    assert.match(JSON.stringify(body.result), /FOUND/)
    mcp = { source: body.source, planDigest: body.receipt.planDigest, toolCount: (await client.listTools()).tools.length }
  } finally { await client.close() }
  const builtClient = new Client({ name: "usl-built-config-smoke", version: "1" })
  await builtClient.connect(new StdioClientTransport({ command: process.execPath,
    args: [resolve("dist/src/mcp.js"), "--config", resolve("examples/usl.config.json")], cwd: "/var/tmp", stderr: "pipe" }))
  try {
    const result = await builtClient.callTool({ name: "check", arguments: { connection: "game" } })
    assert.equal(result.isError, undefined)
    assert.equal(result.structuredContent.result.valid, true)
    mcp.builtExecutable = "PASS"
  } finally { await builtClient.close() }
  const consumers = ["usl_adapter.py", "usl_observation_v2.py"]
  const consumerDigests = Object.fromEntries(await Promise.all(consumers.map(async name => [name, createHash("sha256").update(await readFile(`/home/lagyeongjun/CD/HSWM/src/hswm/infrastructure/${name}`)).digest("hex")])))
  const receipt = { verifiedAt: new Date().toISOString(), cli: { nativeUidContext: context.result.target.status,
    denyAllResolverCalls: denied.result.metrics.resolverCalls, allowedResolverCalls: observed.result.metrics.resolverCalls,
    uslSourceDigest: observed.result.sourceDigest, nativeSourceDigest: observed.receipt.sourceDigest, inputPreserved: true, envelopeValidation: validation.valid, reversedDirectionReview: comparison.links[0].semanticContractChanged },
    hswm: { status: hswm.result.status, sourceBinding: hswm.result.usl.source_binding, wrongSourcePin, futureTimestampStatus: future.result?.status, consumerDigests }, mcp,
    limitations: ["Local native graph fixture and files; production KG configuration unchanged", "HSWM READY means reference availability, not semantic truth or admission", "Native response identity is in the USL receipt; HSWM source_binding is ABSENT", "No USL database or intermediate plan file created"] }
  await writeFile("audit/platform-completion-smoke-2026-09-08.json", JSON.stringify(receipt, null, 2) + "\n")
  console.log(JSON.stringify(receipt, null, 2))
} finally { await rm(dir, { recursive: true, force: true }) }
