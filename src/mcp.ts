#!/usr/bin/env node
/** Local, read-only MCP façade over the shared USL application boundary. */
import { McpServer } from "@modelcontextprotocol/server"
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import * as z from "zod/v4"
import { pathToFileURL } from "node:url"
import { realpathSync } from "node:fs"
import { parseArgs } from "node:util"
import { Either } from "effect"
import { parseLocator } from "./locator.js"
import { DEFAULT_USL_POLICY, executeUslOperation, type UslOperation, type UslOperationPolicy } from "./application.js"
import { openProgramRegistry } from "./program-store.js"
import { fileConnectionResolver, readMcpConfig, type FileGraphConnection } from "./mcp-config.js"
export { readMcpConfigFromEnv, readMcpConfig } from "./mcp-config.js"

export interface UslMcpServerConfig {
  readonly name?: string
  readonly version?: string
  /** Fixed at startup. Tool arguments can only narrow these limits. */
  readonly policy?: UslOperationPolicy
  /** Administrator-owned ID → source-file map, opened once at server startup. */
  readonly programs?: Readonly<Record<string, string>>
  /** Administrator-owned native graph files, read afresh for each selected call. */
  readonly connections?: Readonly<Record<string, FileGraphConnection>>
}

const json = z.unknown()
const object = z.record(z.string(), json)
const selection = { source: z.string().optional(), program: z.string().optional(), connection: z.string().optional() }
const schemas: Record<UslOperation, z.ZodType> = {
  check: z.object(selection).strict(),
  compile: z.object(selection).strict(),
  context: z.object({ ...selection, query: object, compact: z.boolean().optional(), maxBytes: z.number().int().nonnegative().optional(), knownContextDigest: z.string().optional() }).strict(),
  observe: z.object({ ...selection, options: object.optional(), baseline: json.optional() }).strict(),
  compare: z.object({ before: json, after: json }).strict(),
  validate_observation: z.object({ report: json }).strict(),
  graph_import: z.object({ graph: z.string(), bindings: object }).strict(),
  hswm_prepare: z.object({ arguments: json }).strict(),
  project: z.object({ ...selection, options: object }).strict(),
}

const descriptions: Record<UslOperation, string> = {
  check: "Check source, a registered program, or a named native connection and return its identity.",
  compile: "Return a plan from source, a program, or a named native connection without resolving endpoints.",
  context: "Return bounded graph context from source, a program, or a native connection. For connections use native resource/link UIDs.",
  observe: "Observe only policy-allowed selected resources; the server starts deny-all by default.",
  compare: "Compare two observation reports or complete native observation envelopes without reading a resource.",
  validate_observation: "Validate observation fields, internal consistency and native envelope receipts. This is not semantic verification.",
  graph_import: "Import a raw GEIP GraphSpec plus explicit USL bindings; this does not execute the graph.",
  hswm_prepare: "Prepare a pure HSWM handoff argument bundle; this does not contact HSWM.",
  project: "Produce a semantic projection from USL source or a registered program; this server performs no KG write.",
}
const annotations = (operation: UslOperation) => ({ readOnlyHint: true, destructiveHint: false, idempotentHint: operation !== "observe", openWorldHint: operation === "observe" })

const frozenPolicy = (supplied: UslOperationPolicy | undefined): UslOperationPolicy => {
  const policy = supplied ?? DEFAULT_USL_POLICY
  const captured = { allowedLocators: structuredClone(policy.allowedLocators), maxResources: policy.maxResources,
    maxInputBytes: policy.maxInputBytes, maxOutputBytes: policy.maxOutputBytes,
    ...(policy.resolvers === undefined ? {} : { resolvers: policy.resolvers }),
    ...(policy.getProgram === undefined ? {} : { getProgram: policy.getProgram }),
    ...(policy.getConnection === undefined ? {} : { getConnection: policy.getConnection }) }
  if (!Array.isArray(captured.allowedLocators) || captured.allowedLocators.some(value => typeof value !== "string" || Either.isLeft(parseLocator(value))) ||
    [captured.maxResources, captured.maxInputBytes, captured.maxOutputBytes].some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error("invalid MCP policy")
  return Object.freeze({ ...captured, allowedLocators: Object.freeze(captured.allowedLocators) })
}
const connectionPolicy = (config: UslMcpServerConfig): UslOperationPolicy => {
  const base = frozenPolicy(config.policy)
  if (config.connections !== undefined && base.getConnection !== undefined) throw new Error("configure either policy.getConnection or connections, not both")
  return frozenPolicy({ ...base, ...(config.connections === undefined ? {} : { getConnection: fileConnectionResolver(config.connections, base.maxInputBytes) }) })
}
const response = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> })
const failure = (error: unknown) => ({ content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true })

/** Build an in-process server for tests or a caller-owned stdio transport. */
export const createUslMcpServer = (config: UslMcpServerConfig = {}): McpServer => {
  const policy = connectionPolicy(config)
  const server = new McpServer({ name: config.name ?? "usl", version: config.version ?? "0.3.0" })
  for (const operation of Object.keys(schemas) as UslOperation[]) {
    const schema = schemas[operation]
    server.registerTool(operation, { description: descriptions[operation], annotations: annotations(operation), inputSchema: schema }, async (input) => {
      try { return response(await executeUslOperation(operation, input, policy)) }
      catch (error) { return failure(error) }
    })
  }
  return server
}

/** Start a stdio server. stdout is reserved for MCP JSON-RPC; diagnostics use stderr. */
export const startUslMcpServer = async (config: UslMcpServerConfig = {}) => {
  const basePolicy = connectionPolicy(config)
  if (config.programs !== undefined && basePolicy.getProgram !== undefined) throw new Error("configure either policy.getProgram or programs, not both")
  const registry = config.programs === undefined ? undefined : await openProgramRegistry(config.programs, { maxSourceBytes: basePolicy.maxInputBytes })
  const policy = frozenPolicy({ ...basePolicy, ...(registry === undefined ? {} : { getProgram: registry.getProgram }) })
  const transport = new StdioServerTransport()
  let closed = false
  const closeRegistry = () => { if (!closed) { closed = true; registry?.close() } }
  // Closing stdin must release file watchers even when the caller never invokes
  // the returned handle (the normal stdio client shutdown path).
  process.stdin.once("end", closeRegistry)
  process.once("exit", closeRegistry)
  const handle = serveStdio(() => createUslMcpServer({ ...(config.name === undefined ? {} : { name: config.name }), ...(config.version === undefined ? {} : { version: config.version }), policy }), {
    transport, onerror: (error) => console.error(error.message),
  })
  return { close: async () => { closeRegistry(); await handle.close() } }
}

export const runUslMcpCommand = async (args: readonly string[]) => {
  const { values } = parseArgs({ args, allowPositionals: false, options: { config: { type: "string" }, help: { type: "boolean" } } })
  if (values.help) { console.log("usl-mcp [--config FILE.json]"); return }
  await startUslMcpServer(await readMcpConfig(values.config))
}

const isEntrypoint = (): boolean => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href }
  catch { return false }
}
if (isEntrypoint()) {
  void runUslMcpCommand(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
