import { parseArgs } from "node:util"
import { realpath } from "node:fs/promises"
import { resolve } from "node:path"
import { Effect, Either } from "effect"
import { connectUsl } from "./adapters.js"
import { DEFAULT_USL_POLICY } from "./application.js"
import { adaptPropertyGraph } from "./integrations/property-graph.js"
import { adaptResourceGraph, resourceGraphJsonLd } from "./integrations/resource-graph.js"
import { writeTextAtomic } from "./storage.js"
import { readUtf8Bounded } from "./bounded-read.js"
import { PlatformUsageError } from "./cli-platform.js"
import { parseDomainProfile } from "./domain-profile.js"

export const ADAPTER_USAGE = "  usl adapt --graph FILE.json --namespace NAME [--format property-graph|resource-graph]\n    [--profile PROFILE.json] [--kg-source SOURCE] [--operation check|context|observe|jsonld]\n    [--focus UID] [--target UID] [--compact] [--link REL_UID] [--allow-locator LOC | --deny-all] [--max-resources N] [--out FILE]"
const canonical = (file: string) => realpath(file).catch(() => resolve(file))

export const runAdapterCommand = async (argv: readonly string[]): Promise<boolean> => {
  if (argv[0] !== "adapt") return false
  if (argv.slice(1).includes("--help")) { console.log(ADAPTER_USAGE); return true }
  const parsed = (() => {
    try { return parseArgs({ args: argv.slice(1), allowPositionals: false, options: {
      graph: { type: "string" }, namespace: { type: "string" }, "kg-source": { type: "string" }, operation: { type: "string" }, format: { type: "string" },
      focus: { type: "string" }, target: { type: "string" }, compact: { type: "boolean" }, out: { type: "string" },
      profile: { type: "string" },
      link: { type: "string", multiple: true }, "allow-locator": { type: "string", multiple: true },
      "deny-all": { type: "boolean" }, "max-resources": { type: "string" },
    } }).values } catch (failure) { throw new PlatformUsageError(String(failure)) }
  })()
  const required = (value: string | undefined, name: string) => {
    if (!value?.trim()) throw new PlatformUsageError(`--${name} is required`)
    return value
  }
  const graph = required(parsed.graph, "graph"), namespace = required(parsed.namespace, "namespace")
  const operation = parsed.operation ?? "check"
  const format = parsed.format ?? "property-graph"
  if (!["property-graph", "resource-graph"].includes(format)) throw new PlatformUsageError("--format must be property-graph or resource-graph")
  if (format === "resource-graph" && parsed["kg-source"] !== undefined) throw new PlatformUsageError("resource-graph uses explicit locators, not --kg-source")
  if (parsed.profile !== undefined && format !== "resource-graph") throw new PlatformUsageError("--profile requires resource-graph")
  if (!["check", "context", "observe", "jsonld"].includes(operation)) throw new PlatformUsageError("--operation must be check, context, observe or jsonld")
  if (operation === "jsonld" && format !== "resource-graph") throw new PlatformUsageError("jsonld requires --format resource-graph")
  if (operation !== "context" && [parsed.focus, parsed.target, parsed.compact].some((value) => value !== undefined)) throw new PlatformUsageError("--focus, --target and --compact require context")
  if (operation !== "observe" && [parsed.link, parsed["allow-locator"], parsed["deny-all"]].some((value) => value !== undefined)) throw new PlatformUsageError("read scope flags require observe")
  if (parsed["deny-all"] && parsed["allow-locator"] !== undefined) throw new PlatformUsageError("choose --deny-all or --allow-locator")
  if (parsed["max-resources"] !== undefined && !/^\d+$/.test(parsed["max-resources"])) throw new PlatformUsageError("--max-resources must be a nonnegative integer")
  const maxResources = parsed["max-resources"] === undefined ? DEFAULT_USL_POLICY.maxResources : Number(parsed["max-resources"])
  if (!Number.isSafeInteger(maxResources)) throw new PlatformUsageError("--max-resources must be a safe integer")
  if (parsed.out !== undefined && await canonical(parsed.out) === await canonical(graph)) throw new PlatformUsageError("--out must differ from --graph, including aliases")
  if (parsed.out !== undefined && parsed.profile !== undefined && await canonical(parsed.out) === await canonical(parsed.profile)) throw new PlatformUsageError("--out must differ from --profile, including aliases")
  const profile = parsed.profile === undefined ? undefined : parseDomainProfile(JSON.parse(await readUtf8Bounded(parsed.profile, DEFAULT_USL_POLICY.maxInputBytes)))
  const resourceOptions = { namespace, ...(profile === undefined ? {} : { profile }) }
  const usl = connectUsl({
    read: () => Effect.tryPromise(() => readUtf8Bounded(graph, DEFAULT_USL_POLICY.maxInputBytes)),
    adapt: (raw) => format === "resource-graph" ? adaptResourceGraph(raw, resourceOptions)
      : adaptPropertyGraph(raw, { namespace, ...(parsed["kg-source"] === undefined ? {} : { kgSource: parsed["kg-source"] }) }),
    policy: { ...DEFAULT_USL_POLICY, maxResources, allowedLocators: parsed["allow-locator"] ?? [] },
  })
  const action = operation === "check" ? usl.check(undefined)
    : operation === "context" ? usl.context(undefined, { focus: required(parsed.focus, "focus"), ...(parsed.target === undefined ? {} : { target: parsed.target }) }, { compact: parsed.compact ?? false })
    : usl.observe(undefined, { ...(parsed.link === undefined ? {} : { links: parsed.link }) })
  const result = operation === "jsonld"
    ? Either.getOrThrowWith(resourceGraphJsonLd(await readUtf8Bounded(graph, DEFAULT_USL_POLICY.maxInputBytes), resourceOptions), failure => failure)
    : await Effect.runPromise(action)
  const text = JSON.stringify(result, null, 2) + "\n"
  if (Buffer.byteLength(text, "utf8") > DEFAULT_USL_POLICY.maxOutputBytes) throw new PlatformUsageError("output exceeds maxOutputBytes")
  if (parsed.out === undefined) process.stdout.write(text)
  else { await writeTextAtomic(parsed.out, text); console.log(JSON.stringify({ out: parsed.out })) }
  if (operation === "observe" && (result as { result: { status: string } }).result.status !== "RESOLVES") process.exitCode = 2
  return true
}
