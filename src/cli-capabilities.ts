/** Read-only catalog operations, sharing the exact application/MCP contracts. */
import { realpath } from "node:fs/promises"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { executeUslOperation } from "./application.js"
import { readMcpConfig, fileCapabilityCatalogResolver } from "./mcp-config.js"
import { readUtf8Bounded } from "./bounded-read.js"
import { writeTextAtomic } from "./storage.js"
import { PlatformUsageError } from "./cli-platform.js"

const commands = { "capability-discover": "capability_discover", "capability-preflight": "capability_preflight" } as const
export const CAPABILITY_USAGE = "  usl capability-discover --config FILE --input REQUEST.json [--out FILE]\n  usl capability-preflight --config FILE --input REQUEST.json [--out FILE]"
const canonical = (file: string) => realpath(file).catch(() => resolve(file))

export const runCapabilityCommand = async (argv: readonly string[]): Promise<boolean> => {
  const command = argv[0]
  if (command === undefined || !Object.hasOwn(commands, command)) return false
  const values = (() => {
    try { return parseArgs({ args: argv.slice(1), allowPositionals: false, options: {
      config: { type: "string" }, input: { type: "string" }, out: { type: "string" }, help: { type: "boolean" },
    } }).values } catch (error) { throw new PlatformUsageError(String(error)) }
  })()
  if (values.help) { console.log(CAPABILITY_USAGE); return true }
  if (!values.config?.trim() || !values.input?.trim()) throw new PlatformUsageError("--config and --input are required")
  const config = await readMcpConfig(values.config)
  // An output file must never replace the registration or any registered source.
  if (values.out !== undefined) {
    const inputs = [values.config, values.input, ...Object.values(config.programs), ...Object.values(config.capabilityCatalogs ?? {}),
      ...Object.values(config.connections ?? {}).flatMap(c => [c.graph, ...(c.profile === undefined ? [] : [c.profile])])]
    const target = await canonical(values.out)
    if ((await Promise.all(inputs.map(canonical))).includes(target)) throw new PlatformUsageError("--out must differ from input, config and registered files, including aliases")
  }
  const input: unknown = JSON.parse(await readUtf8Bounded(values.input, config.policy.maxInputBytes))
  const policy = { ...config.policy, ...(config.capabilityCatalogs === undefined ? {} : {
    getCapabilityCatalog: fileCapabilityCatalogResolver(config.capabilityCatalogs, config.policy.maxInputBytes),
  }) }
  const result = await executeUslOperation(commands[command as keyof typeof commands], input, policy)
  const output = JSON.stringify(result, null, 2) + "\n"
  if (Buffer.byteLength(output, "utf8") > policy.maxOutputBytes) throw new Error("output exceeds maxOutputBytes")
  if (values.out === undefined) process.stdout.write(output)
  else { await writeTextAtomic(values.out, output); console.log(JSON.stringify({ out: values.out })) }
  return true
}
