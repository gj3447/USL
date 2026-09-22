/** Bounded, IO-free MCP/OpenAPI inventory import. Owner semantics are never inferred from prose. */
import { z } from "zod"
import { Either } from "effect"
import { capabilitySchema, compileCapabilitySchema, parseCapability, type CapabilityDescriptor } from "../capabilities.js"
import { contractDigest, contractHash, contractSnapshot, contractText, freezeContract, uniqueContractIds } from "../contract-core.js"
import { digestSource } from "../language/digest.js"
import { parseResourceGraph, type ResourceGraph } from "./resource-graph.js"
import { parseLocator } from "../locator.js"

export interface InventoryBinding {
  readonly meanings: readonly string[]
  readonly effect: "READ" | "WRITE" | "UNKNOWN"
  readonly requiredScopes: readonly string[]
  readonly inputTypes: readonly string[]
  readonly outputTypes: readonly string[]
  readonly inputUnit?: string | undefined
  readonly outputUnit?: string | undefined
}
export interface InventoryOptions {
  readonly connection: string
  readonly complete: boolean
  /** Host-authored bindings keyed by tool name or METHOD /path; never taken from remote annotations. */
  readonly bindings: Readonly<Record<string, InventoryBinding>>
}
export interface CapabilityInventory {
  readonly schema: "usl-capability-inventory/v1"
  readonly adapter: "mcp-tools/v1" | "openapi-3.1/v1"
  readonly complete: boolean
  readonly sourceDigest: string
  readonly capabilities: readonly CapabilityDescriptor[]
  readonly sourceText: string
}
const optionsSchema = z.strictObject({ connection: contractText, complete: z.boolean(), bindings: z.record(z.string(), z.strictObject({
  meanings: capabilitySchema.shape.meanings, effect: capabilitySchema.shape.effect,
  requiredScopes: capabilitySchema.shape.requiredScopes, inputTypes: capabilitySchema.shape.input.shape.types,
  outputTypes: capabilitySchema.shape.output.shape.types, inputUnit: capabilitySchema.shape.input.shape.unit,
  outputUnit: capabilitySchema.shape.output.shape.unit,
})) })
const inventorySchema = z.strictObject({
  schema: z.literal("usl-capability-inventory/v1"), adapter: z.enum(["mcp-tools/v1", "openapi-3.1/v1"]), complete: z.boolean(),
  sourceDigest: contractHash, capabilities: z.array(capabilitySchema).max(1024), sourceText: z.string(),
})
const source = (raw: string) => {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 1024 * 1024) throw new Error("inventory must be at most 1 MiB of JSON")
  return contractSnapshot(JSON.parse(raw)) as unknown
}
const descriptor = (operation: string, id: string, input: unknown, output: unknown, options: InventoryOptions, sourceDigest: string,
  complete: boolean, unsupported: string[]): CapabilityDescriptor => {
  const binding = Object.hasOwn(options.bindings, operation) ? options.bindings[operation] : undefined
  for (const [label, schema] of [["input", input], ["output", output]] as const) {
    try { compileCapabilitySchema(schema) } catch (error) { unsupported.push(`${label}: ${String(error)}`.slice(0,4096)) }
  }
  return parseCapability({ schema: "usl-capability/v1", id, version: "1", connection: options.connection, nativeOperation: operation,
    sourceDigest, kind: binding?.effect === "READ" ? "READ" : "ACTION", effect: binding?.effect ?? "UNKNOWN",
    meanings: binding?.meanings ?? [], requiredScopes: binding?.requiredScopes ?? [],
    input: { types: binding?.inputTypes ?? [], schema: input, ...(binding?.inputUnit === undefined ? {} : { unit: binding.inputUnit }) },
    output: { types: binding?.outputTypes ?? [], schema: output, ...(binding?.outputUnit === undefined ? {} : { unit: binding.outputUnit }) },
    mapping: { completeness: complete ? "COMPLETE" : "PARTIAL", losses: [], unsupported },
  })
}
export const importMcpTools = (raw: string, supplied: InventoryOptions): CapabilityInventory => {
  const options = optionsSchema.parse(contractSnapshot(supplied)), data = source(raw)
  const parsed = z.object({ tools: z.array(z.object({ name: contractText, inputSchema: z.record(z.string(), z.json()),
    outputSchema: z.record(z.string(), z.json()).optional() }).passthrough()).max(1024), nextCursor: contractText.optional() }).passthrough().parse(data)
  uniqueContractIds(parsed.tools.map(tool => tool.name), "MCP tool name")
  const complete = options.complete && parsed.nextCursor === undefined, digest = digestSource(raw)
  const capabilities = parsed.tools.map(tool => descriptor(tool.name, tool.name, tool.inputSchema, tool.outputSchema ?? true, options, digest, complete, []))
  return freezeContract({ schema: "usl-capability-inventory/v1", adapter: "mcp-tools/v1", complete, sourceDigest: digest, capabilities, sourceText: raw })
}
const record = (input: unknown): Record<string, unknown> | undefined => input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
const hasUnmappedResponseHeaders = (response: Record<string, unknown> | undefined): boolean => {
  if (response?.headers === undefined) return false
  const headers = record(response.headers)
  return headers === undefined || Object.keys(headers).some(name => name.toLowerCase() !== "content-type")
}
const hasUnmappedResponseLinks = (response: Record<string, unknown> | undefined): boolean => {
  if (response?.links === undefined) return false
  const links = record(response.links)
  return links === undefined || Object.keys(links).length > 0
}
const schemaFromContent = (input: unknown, unsupported: string[], where: string): unknown => {
  const container = record(input), content = record(container?.content), json = record(content?.["application/json"])
  if (container?.$ref !== undefined) unsupported.push(`${where}: reference requires a separately verified resolver`)
  if (content && Object.keys(content).length > 1) unsupported.push(`${where}: multiple media types require an explicit binding choice`)
  if (!json || json.schema === undefined) { unsupported.push(`${where}: missing application/json schema`); return true }
  return json.schema
}
export const importOpenApi = (raw: string, supplied: InventoryOptions): CapabilityInventory => {
  const options = optionsSchema.parse(contractSnapshot(supplied)), data = source(raw), document = record(data)
  if (!document || typeof document.openapi !== "string" || !/^3\.1\.\d+$/.test(document.openapi)) throw new Error("OpenAPI 3.1.x is required")
  const paths = record(document.paths)
  if (!paths) throw new Error("OpenAPI paths object is required")
  const capabilities: CapabilityDescriptor[] = [], digest = digestSource(raw)
  for (const [path, value] of Object.entries(paths)) {
    if (!path.startsWith("/")) throw new Error("OpenAPI path must begin with /")
    const item = record(value)
    if (!item || item.$ref !== undefined) throw new Error("referenced/invalid path item is unsupported; inventory would be incomplete")
    for (const method of ["get", "put", "post", "delete", "options", "head", "patch", "trace"]) {
      if (!Object.hasOwn(item, method)) continue
      const operation = record(item[method])
      if (!operation) throw new Error("OpenAPI operation must be an object")
      const key = `${method.toUpperCase()} ${path}`, unsupported: string[] = []
      if (document.jsonSchemaDialect !== undefined && document.jsonSchemaDialect !== "https://json-schema.org/draft/2020-12/schema" && document.jsonSchemaDialect !== "https://spec.openapis.org/oas/3.1/dialect/base") unsupported.push("jsonSchemaDialect: unsupported document dialect")
      // Parameters and request body are distinct inputs. Never flatten collisions silently.
      let input: unknown = { type: "object", additionalProperties: false }
      const inherited = item.parameters ?? [], own = operation.parameters ?? []
      if (!Array.isArray(inherited) || !Array.isArray(own)) throw new Error("parameters must be arrays")
      if (inherited.length || own.length) unsupported.push("parameters: binding serialization is not implemented")
      // OAS path templates require path parameters. This adapter has no parameter serializer,
      // so even an omitted declaration must not become a body-only callable operation.
      if (/\{[^{}]+\}/u.test(path)) unsupported.push("path template: parameter binding serialization is not implemented")
      if (operation.requestBody !== undefined) input = schemaFromContent(operation.requestBody, unsupported, "requestBody")
      const responses = record(operation.responses)
      const successes = responses ? Object.entries(responses).filter(([status]) => /^2(?:\d\d|XX)$/.test(status)) : []
      let output: unknown = true
      if (successes.length !== 1) unsupported.push("responses: require one explicit success response")
      else {
        const selected = successes[0]![1], response = record(selected)
        output = schemaFromContent(selected, unsupported, "response")
        // Response Object headers and links are distinct output/follow-up semantics. Content-Type
        // is explicitly ignored by OAS here; all other declared headers need a host mapping.
        if (hasUnmappedResponseHeaders(response)) unsupported.push("response headers: output header mapping is not implemented")
        if (hasUnmappedResponseLinks(response)) unsupported.push("response links: follow-up operation mapping is not implemented")
      }
      // These semantics cannot be erased when claiming a callable mapping.
      for (const field of ["callbacks", "security"]) if (operation[field] !== undefined || document[field] !== undefined) unsupported.push(`${field}: owner protocol mapping is required`)
      const id = operation.operationId === undefined ? key : contractText.parse(operation.operationId)
      capabilities.push(descriptor(key, id, input, output, options, digest, options.complete, unsupported))
      if (capabilities.length > 1024) throw new Error("inventory exceeds 1024 operations")
    }
  }
  uniqueContractIds(capabilities.map(c => c.id), "OpenAPI operation identity")
  // Webhooks are an additional operation surface that this importer does not cover.
  const complete = options.complete && document.webhooks === undefined
  const normalized = complete ? capabilities : capabilities.map(c => parseCapability({ ...c, mapping: { ...c.mapping, completeness: "PARTIAL" } }))
  return freezeContract({ schema: "usl-capability-inventory/v1", adapter: "openapi-3.1/v1", complete, sourceDigest: digest, capabilities: normalized, sourceText: raw })
}

/** The caller binds the exact inventory representation to a real locator; no invented protocol URI. */
export const inventoryResourceGraph = (inventoryInput: CapabilityInventory, sourceLocator: string): ResourceGraph => {
  const inventory = inventorySchema.parse(contractSnapshot(inventoryInput)), sourceId = `inventory:${inventory.sourceDigest}`
  if (Either.isLeft(parseLocator(sourceLocator))) throw new Error("inventory representation requires a USL locator")
  if (digestSource(inventory.sourceText) !== inventory.sourceDigest) throw new Error("inventory source digest mismatch")
  const capabilities = inventory.capabilities.map(parseCapability)
  for (const c of capabilities) if (c.sourceDigest !== inventory.sourceDigest) throw new Error("capability source digest mismatch")
  uniqueContractIds(capabilities.map(c => JSON.stringify([c.connection, c.id])), "inventory identities")
  uniqueContractIds(capabilities.map(c => c.nativeOperation), "inventory native operations")
  const connections = [...new Set(capabilities.map(c => c.connection))]
  if (connections.length > 1) throw new Error("inventory capabilities must have one owner connection")
  const bindings: Record<string, InventoryBinding> = Object.create(null)
  for (const c of capabilities) bindings[c.nativeOperation] = {
    meanings: c.meanings, effect: c.effect, requiredScopes: c.requiredScopes,
    inputTypes: c.input.types, outputTypes: c.output.types,
    ...(c.input.unit === undefined ? {} : { inputUnit: c.input.unit }),
    ...(c.output.unit === undefined ? {} : { outputUnit: c.output.unit }),
  }
  // Re-import the pinned representation using only its declared owner bindings. A cloned envelope
  // cannot add operations, swap schemas, or turn an incomplete source into a complete inventory.
  const expected = inventory.adapter === "mcp-tools/v1"
    ? importMcpTools(inventory.sourceText, { connection: connections[0] ?? "empty-inventory", complete: inventory.complete, bindings })
    : importOpenApi(inventory.sourceText, { connection: connections[0] ?? "empty-inventory", complete: inventory.complete, bindings })
  if (expected.complete !== inventory.complete || expected.capabilities.length !== capabilities.length ||
    expected.capabilities.some((c, index) => contractDigest(c) !== contractDigest(capabilities[index]!))) {
    throw new Error("inventory descriptors do not match pinned source representation")
  }
  const graph: ResourceGraph = { schema: "usl-resource-graph/v1", resources: [
    { id: sourceId, types: ["urn:usl:engineering:Inventory"], locator: sourceLocator,
      metadata: { sourceDigest: inventory.sourceDigest, complete: inventory.complete, representation: z.json().parse(source(inventory.sourceText)) } },
    ...capabilities.map(c => ({ id: JSON.stringify([c.connection, c.id]),
      types: ["urn:usl:engineering:Capability"], locator: sourceLocator, metadata: { descriptor: z.json().parse(c), descriptorDigest: contractDigest(c),
        semantics: "OWNER_BINDING_DECLARATION_NOT_UPSTREAM_AUTHORIZATION" } })),
  ], meanings: [{ id: "urn:usl:engineering:exposes", description: "The supplied inventory describes this capability; invocation and authorization remain separate." }],
  links: capabilities.map(c => ({ id: `exposes:${JSON.stringify([c.connection, c.id])}`, meaning: "urn:usl:engineering:exposes",
    participants: [{ role: "inventory", resource: sourceId }, { role: "capability", resource: JSON.stringify([c.connection, c.id]) }] })), provenance: { sources: [sourceId] } }
  return Either.getOrThrow(parseResourceGraph(JSON.stringify(graph)))
}
