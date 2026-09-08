/** Optional real HSWM consumer check; only local files and pure Python adapter calls. */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { runEngineeringWorkflow } from "../examples/engineering-workflow.js"

const root = fileURLToPath(new URL("../", import.meta.url))
const hswmRoot = resolve(process.argv[2] ?? join(root, "../HSWM"))
const python = `import json,sys
from hswm.infrastructure.usl_adapter import adapt_usl, Reject
x=json.loads(sys.stdin.read())
x['allowed_reads']=set(tuple(pair) for pair in x['allowed_reads'])
try: print(json.dumps({'ok':True,'result':adapt_usl(**x)},ensure_ascii=False))
except Reject as e: print(json.dumps({'ok':False,'error':str(e)}))`
const invoke = (input: unknown) => JSON.parse(execFileSync("python3", ["-c", python], {
  input: JSON.stringify(input), encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: join(hswmRoot, "src") },
}))
const result = await runEngineeringWorkflow()
const valid = invoke(result.handoff)
assert.equal(valid.ok, true); assert.equal(valid.result.status, "READY")
const stale = invoke({ ...result.handoff, now: result.handoff.now + 120 })
assert.equal(stale.ok, true); assert.equal(stale.result.status, "UNRESOLVED")
const badPin = invoke({ ...result.handoff, policy: { ...result.handoff.policy, resources: result.handoff.policy.resources.map((pin, i) => i === 0 ? { ...pin, content_hash: "f".repeat(64) } : pin) } })
assert.equal(badPin.ok, false)
const unauthorized = invoke({ ...result.handoff, allowed_reads: [] })
assert.equal(unauthorized.ok, false)

const at = new Date().toISOString()
const directory = join(root, "observations", `engineering-${at.replace(/[:.]/g, "-")}`)
await mkdir(directory, { recursive: true })
const artifacts: { file: string; digest: string }[] = []
const save = async (file: string, value: unknown, raw = false) => {
  const contents = raw ? String(value) : `${JSON.stringify(value, null, 2)}\n`
  await writeFile(join(directory, file), contents, { flag: "wx" })
  artifacts.push({ file, digest: `sha256:${createHash("sha256").update(contents).digest("hex")}` })
}
await save("source.usl", result.source, true)
await save("plan.json", result.plan)
await save("graph-binding.json", result.graph)
await save("observation.json", result.report)
await save("hswm-input.json", result.handoff)
await save("hswm-result.json", { valid, stale, badPin, unauthorized })
const consumers = await Promise.all(["usl_adapter.py", "usl_observation_v2.py"].map(async (file) => ({
  file: join(hswmRoot, "src/hswm/infrastructure", file),
  digest: `sha256:${createHash("sha256").update(await readFile(join(hswmRoot, "src/hswm/infrastructure", file))).digest("hex")}`,
})))
const receipt = { schema: "usl-code-geip-hswm-verification/v1", at, scope: "LOCAL_FIXTURES_AND_PURE_HSWM_CONSUMER",
  ...result.summary, hswm: valid.result.status, stale: stale.result.status,
  badPin: badPin.error, unauthorized: unauthorized.error, consumers, artifacts,
  limits: ["GraphSpec mapping demonstration, not execution of its workflow", "KG concept is declared but not resolved in this run", "READY indicates pinned reference availability only; no semantic truth or admission", "policy is local fixture policy, not production authorization"],
}
await writeFile(join(directory, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" })
console.log(JSON.stringify({ directory, status: result.report.status, resolverCalls: result.report.metrics.resolverCalls,
  hswm: valid.result.status, stale: stale.result.status, badPin: badPin.ok, unauthorized: unauthorized.ok }, null, 2))
