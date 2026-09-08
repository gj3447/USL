/** Optional cross-repository smoke. Run: npx tsx audit/hswm-adapter-smoke.ts */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { Effect, Either, Layer } from "effect"
import { compileSource, observeProgram } from "../src/language/index.js"
import { formatLocator } from "../src/locator.js"
import { Resolvers } from "../src/resolve.js"
import type { Locator, Resolution } from "../src/domain.js"
import { hswmDigest, prepareHswmAdapterArguments, type HswmObservationPolicyV2 } from "../src/integrations/hswm.js"

const source = `usl "0.1"; namespace "hswm.smoke";
resource code = "https://example.test/code"; resource spec = "https://example.test/spec";
meaning implements(implementation: url, requirement: url) = "code implements spec" grounded "kg://canonical-neo4j/sym:Concept:implements";
link edge = implements(implementation: code, requirement: spec);`
const plan = Either.getOrThrow(compileSource(source))
const hash = (c: string) => c.repeat(64)
const layer = Layer.succeed(Resolvers, { resolve: (locator: Locator): Effect.Effect<Resolution, never> => Effect.succeed({ locator, resolvedLocator: formatLocator(locator), contentHash: hash(locator.kind === "kg" ? "b" : "a"), resolvedAt: "2026-09-08T00:00:00.000Z", guaranteeLevel: "pure", matchCount: 1 }) })
const python = `import json, sys
from hswm.infrastructure.usl_adapter import adapt_usl, Reject
x=json.loads(sys.stdin.read()); x['allowed_reads']=set(tuple(v) for v in x['allowed_reads'])
try: print(json.dumps({'ok': True, 'result': adapt_usl(**x)}, sort_keys=True))
except Reject as e: print(json.dumps({'ok': False, 'error': str(e)}, sort_keys=True))`
const invoke = (value: unknown) => JSON.parse(execFileSync("python3", ["-c", python], { input: JSON.stringify(value), encoding: "utf8", env: { ...process.env, PYTHONPATH: "/home/lagyeongjun/CD/HSWM/src" } })) as { ok: boolean; result?: { status?: string }; error?: string }

const main = async () => {
  const report = await Effect.runPromise(observeProgram(plan, { links: ["edge"], sourceText: source }).pipe(Effect.provide(layer)))
  const policy: HswmObservationPolicyV2 = { schema_version: "hswm-usl-observation-policy/v2", namespace: plan.namespace, plan_digest: hswmDigest(plan), usl_plan_digest: report.planDigest, source_digest: report.sourceDigest, max_age_seconds: 60, bindings: [{ link: "edge", role: "reference", field: "resolves" }], resources: [...report.resources.map((r) => ({ name: r.name, content_hash: r.resolution!.contentHash, resolved_locator: r.resolution!.resolvedLocator })), ...report.groundings.map((r) => ({ name: `meaning:${r.name}`, content_hash: r.resolution!.contentHash, resolved_locator: r.resolution!.resolvedLocator }))] }
  const prepared = prepareHswmAdapterArguments({ plan, report, policy, allowed_reads: [["reference", "resolves"]], now: 1_788_825_630, revision: "smoke" })
  const valid = invoke(prepared)
  const badPin = structuredClone(prepared); ;(badPin.policy.resources[0] as { content_hash: string }).content_hash = hash("f")
  const mismatch = invoke(badPin)
  const stale = invoke({ ...prepared, now: 1_788_825_660 })
  const unauthorized = invoke({ ...prepared, allowed_reads: [] })
  const consumer = "/home/lagyeongjun/CD/HSWM/src/hswm/infrastructure/usl_adapter.py"
  const consumerV2 = "/home/lagyeongjun/CD/HSWM/src/hswm/infrastructure/usl_observation_v2.py"
  const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")
  const results = { noLiveExternalIO: true, hswmRoot: "/home/lagyeongjun/CD/HSWM", consumerSha256: { usl_adapter_py: sha(consumer), usl_observation_v2_py: sha(consumerV2) }, valid, badPin: mismatch, stale, unauthorized }
  await writeFile(new URL("./hswm-adapter-smoke-results.json", import.meta.url), `${JSON.stringify(results, null, 2)}\n`)
  console.log(JSON.stringify(results, null, 2))
}
void main()
