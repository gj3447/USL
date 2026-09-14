/** Read-only reproduction for the adapter input-budget ordering audit. */
import { Effect, Either } from "effect"
import { connectUsl } from "../src/adapters.js"
import { adaptPropertyGraph } from "../src/integrations/property-graph.js"
import fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { join } from "node:path"
import { tmpdir } from "node:os"

let reads = 0
const raw = JSON.stringify({ nodes: [], relations: [] })
const adapter = connectUsl({
  read: () => { reads++; return Effect.succeed(raw) },
  adapt: (text) => adaptPropertyGraph(text, { namespace: "audit.native" }),
  policy: { allowedLocators: [], maxResources: 1, maxInputBytes: 3, maxOutputBytes: 1024 },
})
const outcome = await Effect.runPromise(Effect.either(adapter.check(undefined)))
const dir = await fs.mkdtemp(join(tmpdir(), "usl-audit-input-"))
const path = join(dir, "oversized-graph.json")
const inputBytes = 1024 * 1024 + 1
await fs.writeFile(path, raw + " ".repeat(inputBytes - Buffer.byteLength(raw)))
const originalRead = fs.readFile
let completedFileReadBytes = 0, cliError = ""
try {
  // Instrument only this isolated probe process, and only the temporary input.
  fs.readFile = (async (...args: any[]) => {
    const result = await (originalRead as any)(...args)
    if (args[0] === path) completedFileReadBytes += Buffer.byteLength(result)
    return result
  }) as typeof fs.readFile
  syncBuiltinESMExports()
  const { runAdapterCommand } = await import("../src/cli-adapter.js")
  try { await runAdapterCommand(["adapt", "--graph", path, "--namespace", "audit.size"]) }
  catch (failure) { cliError = String(failure) }
} finally {
  fs.readFile = originalRead; syncBuiltinESMExports()
  await fs.rm(dir, { recursive: true, force: true })
}
console.log(JSON.stringify({
  probe: "adapter-input-budget-after-host-read",
  rawBytes: Buffer.byteLength(raw, "utf8"),
  hostReadCalls: reads,
  outcome: Either.isLeft(outcome) ? String(outcome.left) : "unexpected success",
  note: "Generic source callbacks own their IO limits; this byte limit checks a completed response. The built-in CLI also completes its full file read before checking it.",
  cli: { configuredLimitBytes: 1024 * 1024, inputBytes, completedFileReadBytes, error: cliError },
}, null, 2))
