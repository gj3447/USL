/** Durable host-command CLI surface. The host owns all authority and receipts. */
import { realpath } from "node:fs/promises"
import { resolve } from "node:path"
import { parseArgs, type ParseArgsOptionsConfig } from "node:util"
import { readUtf8Bounded } from "./bounded-read.js"
import { capabilityInvocationSchema, type CapabilityInvocation } from "./capabilities.js"
import { bindCliResourceGraph, executeCliAction, listCliActions, locateCliResource, planCliAction } from "./cli-host.js"
import { PlatformUsageError } from "./cli-platform.js"
import { writeTextAtomic } from "./storage.js"

const MAX_INVOCATION_BYTES = 1024 * 1024
const EXPECTED_PLAN_DIGEST = /^sha256:[a-f0-9]{64}$/
const canonical = (file: string) => realpath(file).catch(() => resolve(file))

export const CLI_HOST_USAGE = `  usl cli-list --config FILE
  usl locate --config FILE --resource ID [--representation ID]
  usl bind-graph --config HOST --graph RESOURCE_GRAPH.json --selections SELECTIONS.json [--out FILE]
  usl cli-plan --config FILE --action ID --input INVOCATION.json [--out FILE]
  usl cli-run --config FILE --action ID --input INVOCATION.json --expected-plan sha256:... --receipt-dir NEW_DIRECTORY`

const required = (value: string | undefined, flag: string): string => {
  if (!value?.trim()) throw new PlatformUsageError(`--${flag} is required`)
  return value
}
const parse = (args: readonly string[], options: ParseArgsOptionsConfig) => {
  try { return parseArgs({ args, options, allowPositionals: false }).values as Record<string, string | undefined> }
  catch (error) { throw new PlatformUsageError(error instanceof Error ? error.message : String(error)) }
}
const invocation = async (file: string): Promise<CapabilityInvocation> => {
  let raw: string
  try { raw = await readUtf8Bounded(file, MAX_INVOCATION_BYTES) }
  catch (error) { throw new PlatformUsageError(error instanceof Error ? error.message : String(error)) }
  try { return capabilityInvocationSchema.parse(JSON.parse(raw)) }
  catch (error) { throw new PlatformUsageError(`--input must contain a CapabilityInvocation: ${error instanceof Error ? error.message : String(error)}`) }
}
const output = (value: unknown): string => JSON.stringify(value, null, 2) + "\n"
const textInput = async (file: string): Promise<string> => {
  try { return await readUtf8Bounded(file, MAX_INVOCATION_BYTES) }
  catch (error) { throw new PlatformUsageError(error instanceof Error ? error.message : String(error)) }
}
const jsonInput = async (file: string, flag: string): Promise<unknown> => {
  let raw: string
  raw = await textInput(file)
  try { return JSON.parse(raw) }
  catch (error) { throw new PlatformUsageError(`--${flag} must contain JSON: ${error instanceof Error ? error.message : String(error)}`) }
}
const setExitStatus = (result: unknown): void => {
  if (result !== null && typeof result === "object" && "status" in result &&
    ((result as { status?: unknown }).status === "REJECTED" || (result as { status?: unknown }).status === "INDETERMINATE")) process.exitCode = 2
}

export const runCliHostCommand = async (argv: readonly string[]): Promise<boolean> => {
  const command = argv[0]
  if (command === undefined || !["cli-list", "locate", "bind-graph", "cli-plan", "cli-run"].includes(command)) return false
  if (argv.length === 2 && argv[1] === "--help") { console.log(CLI_HOST_USAGE); return true }

  if (command === "cli-list") {
    const values = parse(argv.slice(1), { config: { type: "string" } })
    const result = await listCliActions(required(values.config, "config"))
    process.stdout.write(output(result))
    setExitStatus(result)
    return true
  }
  if (command === "locate") {
    const values = parse(argv.slice(1), { config: { type: "string" }, resource: { type: "string" }, representation: { type: "string" } })
    const result = await locateCliResource(required(values.config, "config"), {
      resource: required(values.resource, "resource"),
      ...(values.representation === undefined ? {} : { representation: required(values.representation, "representation") }),
    })
    process.stdout.write(output(result))
    setExitStatus(result)
    return true
  }
  if (command === "bind-graph") {
    const values = parse(argv.slice(1), { config: { type: "string" }, graph: { type: "string" }, selections: { type: "string" }, out: { type: "string" } })
    const config = required(values.config, "config"), graph = required(values.graph, "graph"), selections = required(values.selections, "selections")
    if (values.out !== undefined && (await Promise.all([config, graph, selections].map(canonical))).includes(await canonical(values.out))) {
      throw new PlatformUsageError("--out must differ from --config, --graph and --selections, including aliases")
    }
    const raw = await textInput(graph)
    const selectionInput = await jsonInput(selections, "selections")
    if (!Array.isArray(selectionInput)) throw new PlatformUsageError("--selections must contain an array")
    const result = await bindCliResourceGraph(config, raw, selectionInput)
    const text = output(result)
    if (values.out === undefined) process.stdout.write(text)
    else {
      try { await writeTextAtomic(values.out, text, null) }
      catch (error) { throw new PlatformUsageError(`--out must name a new file: ${error instanceof Error ? error.message : String(error)}`) }
      process.stdout.write(output({ out: values.out }))
    }
    return true
  }
  if (command === "cli-plan") {
    const values = parse(argv.slice(1), { config: { type: "string" }, action: { type: "string" }, input: { type: "string" }, out: { type: "string" } })
    const config = required(values.config, "config"), input = required(values.input, "input"), action = required(values.action, "action")
    if (values.out !== undefined && (await canonical(values.out) === await canonical(config) || await canonical(values.out) === await canonical(input))) {
      throw new PlatformUsageError("--out must differ from --config and --input, including aliases")
    }
    const result = await planCliAction(config, action, await invocation(input)), text = output(result)
    if (values.out === undefined) process.stdout.write(text)
    else {
      try { await writeTextAtomic(values.out, text, null) }
      catch (error) { throw new PlatformUsageError(`--out must name a new file: ${error instanceof Error ? error.message : String(error)}`) }
      process.stdout.write(output({ out: values.out }))
    }
    setExitStatus(result)
    return true
  }
  const values = parse(argv.slice(1), { config: { type: "string" }, action: { type: "string" }, input: { type: "string" }, "expected-plan": { type: "string" }, "receipt-dir": { type: "string" } })
  const expectedPlanDigest = required(values["expected-plan"], "expected-plan")
  if (!EXPECTED_PLAN_DIGEST.test(expectedPlanDigest)) throw new PlatformUsageError("--expected-plan must be sha256:<lowercase-hex>")
  const controller = new AbortController()
  const abort = () => controller.abort()
  process.once("SIGINT", abort)
  process.once("SIGTERM", abort)
  let result: Awaited<ReturnType<typeof executeCliAction>>
  try {
    result = await executeCliAction(required(values.config, "config"), required(values.action, "action"),
      await invocation(required(values.input, "input")), expectedPlanDigest, required(values["receipt-dir"], "receipt-dir"), { signal: controller.signal })
  } finally {
    process.removeListener("SIGINT", abort)
    process.removeListener("SIGTERM", abort)
  }
  process.stdout.write(output(result))
  setExitStatus(result)
  return true
}
