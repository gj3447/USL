import { promises as fs } from "node:fs"
import { parseArgs } from "node:util"
import * as path from "node:path"
import { DEFAULT_USL_POLICY, executeUslOperation } from "./application.js"
import { readUtf8Bounded } from "./bounded-read.js"
import { openProgramFile } from "./program-store.js"
import { writeTextAtomic } from "./storage.js"

const commands = new Set(["init", "compare", "validate-observation", "graph-import", "hswm-prepare", "watch", "mcp"])
export class PlatformUsageError extends Error { readonly name = "PlatformUsageError" }
const canonical = async (file: string) => fs.realpath(file).catch(() => path.resolve(file))
const need = (values: Record<string, unknown>, key: string): string => { const v = values[key]; if (typeof v !== "string" || !v.trim()) throw new PlatformUsageError(`--${key} is required`); return v }
const parse = (args: string[]) => { try { return parseArgs({ args, options: { out: { type: "string" }, before: { type: "string" }, after: { type: "string" }, report: { type: "string" }, graph: { type: "string" }, bindings: { type: "string" }, input: { type: "string" }, source: { type: "string" }, once: { type: "boolean" }, help: { type: "boolean" }, config: { type: "string" } }, allowPositionals: false }).values as Record<string, unknown> } catch (error) { throw new PlatformUsageError(error instanceof Error ? error.message : String(error)) } }
const write = async (value: unknown, out: string | undefined, inputs: readonly string[]) => { const text = JSON.stringify(value, null, 2) + "\n"; if (!out) return process.stdout.write(text); const target = await canonical(out); if ((await Promise.all(inputs.map(canonical))).includes(target)) throw new Error("--out must differ from input files"); await writeTextAtomic(out, text); console.log(JSON.stringify({ out })) }
const example = 'usl "0.1";\nnamespace "game.example";\nresource spec = "https://example.test/spec";\nresource implementation = "file://host/project/src/game.ts";\nmeaning implements(specification: url, code: filesystem) = "코드가 명세를 구현한다" applies "고정된 빌드" check review(specification, code) = "명세와 코드를 대조한다";\nlink game_flow = implements(specification: spec, code: implementation);\n'
export const PLATFORM_USAGE = `  usl init --out FILE.usl\n  usl compare --before REPORT --after REPORT\n  usl validate-observation --report REPORT\n  usl graph-import --graph FILE --bindings FILE [--out FILE]\n  usl hswm-prepare --input JSON [--out FILE]\n  usl watch --source FILE [--once]\n  usl mcp [--config FILE.json]`

export const runPlatformCommand = async (argv: readonly string[]): Promise<boolean> => {
  const [command, ...rest] = argv
  if (!command || !commands.has(command)) return false
  const values = parse(rest)
  const allowed: Record<string, readonly string[]> = { init: ["out"], compare: ["before", "after", "out"], "validate-observation": ["report", "out"], "graph-import": ["graph", "bindings", "out"], "hswm-prepare": ["input", "out"], watch: ["source", "once"], mcp: ["config"] }
  if (values.help) { console.log(`usl ${command} ${PLATFORM_USAGE.split("\n").find((line) => line.includes(`usl ${command} `))?.trim().replace(`usl ${command} `, "") ?? ""}`); return true }
  for (const key of Object.keys(values)) if (!allowed[command]!.includes(key)) throw new PlatformUsageError(`--${key} is not valid for ${command}`)
  if (command === "mcp") { const { readMcpConfig, startUslMcpServer } = await import("./mcp.js"); await startUslMcpServer(await readMcpConfig(typeof values.config === "string" ? values.config : undefined)); return true }
  if (command === "init") { const out = need(values, "out"); try { await writeTextAtomic(out, example, null) } catch (error) { if (String(error).includes("changed during operation")) throw new PlatformUsageError("--out already exists"); throw error }; console.log(JSON.stringify({ out })); return true }
  if (command === "watch") { const handle = await openProgramFile(need(values, "source")); const emit = () => console.log(JSON.stringify(handle.status())); if (values.once) { emit(); handle.close() } else { const close = () => handle.close(); process.once("SIGINT", close); process.once("SIGTERM", close); handle.subscribe(emit); emit() }; return true }
  const read = (file: string) => readUtf8Bounded(file, DEFAULT_USL_POLICY.maxInputBytes)
  const json = async (key: string) => JSON.parse(await read(need(values, key)))
  if (command === "compare") { const before = need(values, "before"), after = need(values, "after"); await write(await executeUslOperation("compare", { before: await json("before"), after: await json("after") }), typeof values.out === "string" ? values.out : undefined, [before, after]); return true }
  if (command === "validate-observation") { const report = need(values, "report"); await write(await executeUslOperation("validate_observation", { report: await json("report") }), typeof values.out === "string" ? values.out : undefined, [report]); return true }
  if (command === "graph-import") { const graph = need(values, "graph"), bindings = need(values, "bindings"), raw = await read(graph), parsed = await json("bindings") as Record<string, unknown>; const source = parsed.source; if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("bindings.source is required"); const prior = (source as Record<string, unknown>).text; if (prior !== undefined && prior !== raw) throw new Error("bindings.source.text must match --graph"); const bound = { ...parsed, source: { ...(source as Record<string, unknown>), text: raw } }; await write(await executeUslOperation("graph_import", { graph: raw, bindings: bound }), typeof values.out === "string" ? values.out : undefined, [graph, bindings]); return true }
  const input = need(values, "input"); await write(await executeUslOperation("hswm_prepare", { arguments: await json("input") }), typeof values.out === "string" ? values.out : undefined, [input]); return true
}
