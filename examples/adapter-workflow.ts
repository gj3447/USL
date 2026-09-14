import { readFile } from "node:fs/promises"
import { Effect } from "effect"
import { connectUsl } from "../src/adapters.js"
import { adaptPropertyGraph } from "../src/integrations/property-graph.js"

// Replace this bounded fixture read with the owner's existing read API or
// parameterized Cypher projection. No USL source file or storage is involved.
const usl = connectUsl({
  read: () => Effect.tryPromise(() => readFile(new URL("./fixtures/native-graph.json", import.meta.url), "utf8")),
  adapt: raw => adaptPropertyGraph(raw, { namespace: "game.adapter" }),
})

const result = await Effect.runPromise(Effect.gen(function* () {
  const context = yield* usl.context(undefined, { focus: "game:dash", target: "checkout:game" }, { compact: true })
  const observation = yield* usl.observe(undefined, { links: ["game:dash-implementation"] })
  return {
    source: context.source,
    context: context.result,
    observation: { nativeSourceDigest: observation.receipt.sourceDigest,
      uslSourceDigest: observation.result.sourceDigest, planDigest: observation.result.planDigest,
      resolverCalls: observation.result.metrics.resolverCalls, status: observation.result.status },
  }
}))
console.log(JSON.stringify(result, null, 2))
