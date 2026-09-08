#!/usr/bin/env node
/** Local, read-only MCP façade over the shared USL application boundary. */
import { McpServer } from "@modelcontextprotocol/server"
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import * as z from "zod/v4"
import { pathToFileURL } from "node:url"
import { realpathSync } from "node:fs"
import { DEFAULT_USL_POLICY, executeUslOperation, type UslOperation, type UslOperationPolicy } from "./application.js"
import { openProgramRegistry } from "./program-store.js"

export interface UslMcpServerConfig {
  readonly name?: string
  readonly version?: string
  /** Fixed at startup. Tool arguments can only narrow these limits. */
  readonly policy?: UslOperationPolicy
  /** Administrator-owned ID → source-file map, opened once at server startup. */
  readonly programs?: Readonly<Record<string, string>>
}

/** Read only startup-controlled settings; client requests never reach this path. */
export const readMcpConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): UslMcpServerConfig => {
  const encoded = env.USL_MCP_POLICY
  if (encoded === undefined || encoded === "") return { policy: DEFAULT_USL_POLICY, programs: {} }
  let value: unknown
  try { value = JSON.parse(encoded) } catch { throw new Error("USL_MCP_POLICY must be JSON") }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("USL_MCP_POLICY must be an object")
  const data = value as Record<string, unknown>
  const expected = ["allowedLocators", "maxResources", "maxInputBytes", "maxOutputBytes", "programs"]
  for (const key of Object.keys(data)) if (!expected.includes(key)) throw new Error(`unknown USL_MCP_POLICY field: ${key}`)
  for (const key of expected) if (!(key in data)) throw new Error(`USL_MCP_POLICY.${key} is required`)
  if (!Array.isArray(data.allowedLocators) || !data.allowedLocators.every((entry) => typeof entry === "string")) throw new Error("USL_MCP_POLICY.allowedLocators must be a string array")
  const limit = (key: "maxResources" | "maxInputBytes" | "maxOutputBytes") => {
    const candidate = data[key]
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) throw new Error(`USL_MCP_POLICY.${key} must be a nonnegative safe integer`)
    return candidate
  }
  if (data.programs === null || typeof data.programs !== "object" || Array.isArray(data.programs) || !Object.values(data.programs).every((entry) => typeof entry === "string")) throw new Error("USL_MCP_POLICY.programs must be an ID-to-path object")
  return { policy: { allowedLocators: [...data.allowedLocators], maxResources: limit("maxResources"), maxInputBytes: limit("maxInputBytes"), maxOutputBytes: limit("maxOutputBytes") }, programs: { ...(data.programs as Record<string, string>) } }
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
  check: "Compile USL source or an administrator-registered program and return its identity.",
  compile: "Compile USL source or a registered program without reading resources.",
  context: "Return bounded graph context from USL source or a registered program.",
  observe: "Observe only policy-allowed selected resources; the server starts deny-all by default.",
  compare: "Compare two observation reports without reading a resource.",
  validate_observation: "Validate an observation report's schema, digests and internal consistency.",
  graph_import: "Import a raw GEIP GraphSpec plus explicit USL bindings; this does not execute the graph.",
  hswm_prepare: "Prepare a pure HSWM handoff argument bundle; this does not contact HSWM.",
  project: "Produce a semantic projection from USL source or a registered program; this server performs no KG write.",
}
const annotations = (operation: UslOperation) => ({ readOnlyHint: true, destructiveHint: false, idempotentHint: operation !== "observe", openWorldHint: operation === "observe" })

const frozenPolicy = (supplied: UslOperationPolicy | undefined): UslOperationPolicy => {
  const policy = supplied ?? DEFAULT_USL_POLICY
  return Object.freeze({ allowedLocators: Object.freeze([...policy.allowedLocators]), maxResources: policy.maxResources,
    maxInputBytes: policy.maxInputBytes, maxOutputBytes: policy.maxOutputBytes,
    ...(policy.resolvers === undefined ? {} : { resolvers: policy.resolvers }),
    ...(policy.getProgram === undefined ? {} : { getProgram: policy.getProgram }),
    ...(policy.getConnection === undefined ? {} : { getConnection: policy.getConnection }) })
}
const response = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> })
const failure = (error: unknown) => ({ content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true })

/** Build an in-process server for tests or a caller-owned stdio transport. */
export const createUslMcpServer = (config: UslMcpServerConfig = {}): McpServer => {
  const policy = frozenPolicy(config.policy)
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
  const basePolicy = frozenPolicy(config.policy)
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

const isEntrypoint = (): boolean => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href }
  catch { return false }
}
if (isEntrypoint()) {
  void startUslMcpServer(readMcpConfigFromEnv())
}
