/** Host-bound capabilities: discovery is pure; only an explicitly supplied executor has effects. */
import { z } from "zod"
import { Effect } from "effect"
import { Ajv2020 } from "ajv/dist/2020.js"
import type { AnySchema, ValidateFunction } from "ajv"
import { contractDigest, contractHash, contractIri, contractSnapshot, contractText, freezeContract, uniqueContractIds, type ContractIssue } from "./contract-core.js"

const jsonSchema = z.union([z.boolean(), z.record(z.string(), z.json())])
const port = z.strictObject({ types: z.array(contractIri).max(64), unit: contractIri.optional(), schema: jsonSchema })
export const capabilitySchema = z.strictObject({
  schema: z.literal("usl-capability/v1"), id: contractText, version: contractText,
  connection: contractText, nativeOperation: contractText, sourceDigest: contractHash,
  kind: z.enum(["READ", "ACTION", "SUBSCRIBE"]), effect: z.enum(["READ", "WRITE", "UNKNOWN"]),
  meanings: z.array(contractIri).max(128), requiredScopes: z.array(contractText).max(128),
  input: port, output: port,
  mapping: z.strictObject({ completeness: z.enum(["COMPLETE", "PARTIAL", "UNKNOWN"]),
    losses: z.array(z.strictObject({ path: contractText, reason: contractText })).max(256),
    unsupported: z.array(contractText).max(256) }),
})
export type CapabilityDescriptor = z.infer<typeof capabilitySchema>
export const parseCapability = (value: unknown): CapabilityDescriptor => {
  const descriptor = capabilitySchema.parse(contractSnapshot(value))
  for (const values of [descriptor.meanings, descriptor.requiredScopes, descriptor.input.types, descriptor.output.types]) uniqueContractIds(values, "capability values")
  if (descriptor.kind === "READ" && descriptor.effect === "WRITE") throw new Error("READ capability cannot declare WRITE effect")
  return freezeContract(descriptor)
}

/** Deliberately bounded JSON Schema 2020-12 subset; no refs, regex, remote loads or coercion. */
const scalarKeywords = new Set(["$schema", "title", "description", "type", "enum", "const", "required", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties"])
const singleKeywords = new Set(["items", "additionalProperties", "not"])
const arrayKeywords = new Set(["prefixItems", "allOf", "anyOf", "oneOf"])
const inspectSchema = (schema: unknown, depth = 0): void => {
  if (depth > 32) throw new Error("schema depth exceeds 32")
  if (typeof schema === "boolean") return
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) throw new Error("schema must be boolean or object")
  for (const [key, value] of Object.entries(schema)) {
    if (scalarKeywords.has(key)) continue
    if (singleKeywords.has(key)) { inspectSchema(value, depth + 1); continue }
    if (arrayKeywords.has(key)) {
      if (!Array.isArray(value) || value.length > 64) throw new Error(`invalid ${key}`)
      value.forEach(child => inspectSchema(child, depth + 1)); continue
    }
    if (key === "properties") {
      if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 128) throw new Error("invalid properties")
      Object.values(value).forEach(child => inspectSchema(child, depth + 1)); continue
    }
    throw new Error(`unsupported schema keyword: ${key}`)
  }
}
export const compileCapabilitySchema = (schema: unknown): ValidateFunction => {
  const captured = contractSnapshot(schema, 65536)
  inspectSchema(captured)
  return new Ajv2020({ strict: true, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false }).compile(captured as AnySchema)
}

const policySchema = z.strictObject({
  connection: contractText, capabilityId: contractText, descriptorDigest: contractHash, sourceDigest: contractHash,
  allowedEffects: z.array(z.enum(["READ", "WRITE"])).max(2), allowedScopes: z.array(contractText).max(128),
  allowLossy: z.boolean(), maxInputBytes: z.number().int().min(0).max(1024 * 1024),
  maxOutputBytes: z.number().int().min(0).max(1024 * 1024), timeoutMs: z.number().int().min(1).max(300000),
})
export type CapabilityPolicy = z.infer<typeof policySchema>
const invocationSchema = z.strictObject({
  descriptorDigest: contractHash, sourceDigest: contractHash,
  input: z.strictObject({ types: z.array(contractIri).max(64), unit: contractIri.optional(), value: z.json() }),
})
export type CapabilityInvocation = z.infer<typeof invocationSchema>
export interface CapabilityPreflight {
  readonly status: "READY" | "REJECTED"
  readonly issues: readonly ContractIssue[]
  readonly descriptorDigest: string
  readonly sourceDigest: string
  readonly requestDigest: string
  readonly execution: "NOT_EXECUTED"
  readonly semanticTruth: "NOT_EVALUATED"
}
export const preflightCapability = (descriptorInput: unknown, requestInput: unknown, policyInput: unknown): CapabilityPreflight => {
  const descriptor = parseCapability(descriptorInput), request = invocationSchema.parse(contractSnapshot(requestInput))
  const policy = policySchema.parse(contractSnapshot(policyInput)), descriptorDigest = contractDigest(descriptor)
  const issues: ContractIssue[] = []
  const issue = (code: string, detail: string) => { issues.push({ code, at: descriptor.id, detail }) }
  if (descriptor.id !== policy.capabilityId || descriptor.connection !== policy.connection) issue("WRONG_BINDING", "owner binding differs")
  if (descriptorDigest !== policy.descriptorDigest || descriptorDigest !== request.descriptorDigest) issue("STALE_DESCRIPTOR", "descriptor pin differs")
  if (descriptor.sourceDigest !== request.sourceDigest || descriptor.sourceDigest !== policy.sourceDigest) issue("STALE_SOURCE", "source snapshot pin differs")
  if (descriptor.effect === "UNKNOWN" || !policy.allowedEffects.includes(descriptor.effect)) issue("EFFECT_DENIED", "effect is unknown or not granted by owner")
  if (descriptor.kind === "SUBSCRIBE") issue("UNSUPPORTED_OPERATION", "stream lifecycle is not implemented")
  for (const scope of descriptor.requiredScopes) if (!policy.allowedScopes.includes(scope)) issue("SCOPE_DENIED", scope)
  if (descriptor.meanings.length === 0) issue("UNBOUND_MEANING", "owner must bind an explicit meaning")
  if (descriptor.mapping.completeness !== "COMPLETE") issue("INCOMPLETE_MAPPING", descriptor.mapping.completeness)
  if (descriptor.mapping.unsupported.length) issue("UNSUPPORTED_MAPPING", descriptor.mapping.unsupported.join(", "))
  if (descriptor.mapping.losses.length && !policy.allowLossy) issue("LOSS_NOT_ACCEPTED", "owner has not accepted the declared losses")
  for (const type of descriptor.input.types) if (!request.input.types.includes(type)) issue("INPUT_TYPE", type)
  if (descriptor.input.unit !== request.input.unit) issue("INPUT_UNIT", "unit mismatch requires an explicit conversion")
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > policy.maxInputBytes) issue("INPUT_BUDGET", "invocation exceeds maxInputBytes")
  try {
    const input = compileCapabilitySchema(descriptor.input.schema)
    // Compile both schemas before any effect, so unsupported output contracts fail closed too.
    compileCapabilitySchema(descriptor.output.schema)
    if (!input(request.input.value)) issue("INPUT_SCHEMA", JSON.stringify(input.errors))
  } catch (error) { issue("UNSUPPORTED_SCHEMA", String(error)) }
  return freezeContract({ status: issues.length ? "REJECTED" : "READY", issues, descriptorDigest, sourceDigest: descriptor.sourceDigest,
    requestDigest: contractDigest(request), execution: "NOT_EXECUTED", semanticTruth: "NOT_EVALUATED" })
}

const discoveryQuery = z.strictObject({ meaning: contractIri, inputType: contractIri.optional(),
  connection: contractText.optional(), maxResults: z.number().int().min(1).max(256), maxInspected: z.number().int().min(1).max(4096) })
/** Only supplied descriptors are searched; partial inventory is never reported as global absence. */
export const discoverCapabilities = (input: readonly unknown[], queryInput: unknown, inventoryComplete: boolean) => {
  if (typeof inventoryComplete !== "boolean") throw new Error("inventoryComplete must be explicit")
  const descriptors = z.array(z.unknown()).max(4096).parse(contractSnapshot(input)).map(parseCapability)
  uniqueContractIds(descriptors.map(d => JSON.stringify([d.connection, d.id])), "connection/capability identity")
  const query = discoveryQuery.parse(contractSnapshot(queryInput))
  const matches: Array<{ descriptor: CapabilityDescriptor; descriptorDigest: string }> = []
  let inspected = 0, truncated = false
  for (const descriptor of descriptors) {
    if (inspected >= query.maxInspected) { truncated = true; break }
    inspected++
    if (!descriptor.meanings.includes(query.meaning) || query.connection !== undefined && descriptor.connection !== query.connection || query.inputType !== undefined && !descriptor.input.types.includes(query.inputType)) continue
    if (matches.length >= query.maxResults) { truncated = true; break }
    matches.push({ descriptor, descriptorDigest: contractDigest(descriptor) })
  }
  const complete = inventoryComplete && !truncated
  return freezeContract({ schema: "usl-capability-discovery/v1", matches, coverage: { complete, inspected, scope: "SUPPLIED_INVENTORY" },
    status: matches.length ? "FOUND" : complete ? "NOT_FOUND_IN_SCOPE" : "UNKNOWN_WITHIN_LIMITS", authorization: "NOT_EVALUATED", execution: "NOT_EXECUTED" })
}

export interface CapabilityExecutionResult {
  readonly schema: "usl-capability-execution/v1"
  readonly status: "REJECTED" | "SUCCEEDED" | "INDETERMINATE"
  readonly preflight: CapabilityPreflight
  readonly sourceDigest: string
  readonly output?: unknown
  readonly error?: string
  readonly attempts: number
  readonly semanticTruth: "NOT_EVALUATED"
  readonly receiptDigest: string
}
/** Policy and code are host-owned. Data cannot install a handler, grant scopes, or trigger retries. */
export const connectCapability = <E, R>(config: {
  descriptor: CapabilityDescriptor; policy: CapabilityPolicy;
  execute: (value: unknown, context: { expectedSourceDigest: string }) => Effect.Effect<unknown, E, R>
}) => {
  const descriptor = parseCapability(config.descriptor), policy = freezeContract(policySchema.parse(contractSnapshot(config.policy))), execute = config.execute
  if (typeof execute !== "function") throw new Error("host executor is required")
  const result = (body: Omit<CapabilityExecutionResult, "receiptDigest">): CapabilityExecutionResult => freezeContract({ ...body, receiptDigest: contractDigest(body) })
  return Object.freeze({
    describe: () => descriptor,
    invoke: (input: CapabilityInvocation): Effect.Effect<CapabilityExecutionResult, Error, R> => Effect.gen(function* () {
      const request = yield* Effect.try({ try: () => invocationSchema.parse(contractSnapshot(input)), catch: e => new Error(String(e)) })
      const preflight = preflightCapability(descriptor, request, policy)
      const base = { schema: "usl-capability-execution/v1" as const, preflight, sourceDigest: descriptor.sourceDigest, semanticTruth: "NOT_EVALUATED" as const }
      if (preflight.status === "REJECTED") return result({ ...base, status: "REJECTED", attempts: 0 })
      const attempted = Effect.suspend(() => execute(request.input.value, { expectedSourceDigest: descriptor.sourceDigest })).pipe(
        Effect.flatMap(output => Effect.try(() => {
          const captured = contractSnapshot(output, policy.maxOutputBytes)
          const validate = compileCapabilitySchema(descriptor.output.schema)
          if (!validate(captured)) throw new Error(`OUTPUT_SCHEMA: ${JSON.stringify(validate.errors)}`)
          return captured
        })), Effect.timeout(policy.timeoutMs),
        Effect.matchCause({ onFailure: () => result({ ...base, status: "INDETERMINATE", attempts: 1,
          error: "Executor failed, timed out, or returned an invalid result; effects may have occurred. No automatic retry." }),
          onSuccess: output => result({ ...base, status: "SUCCEEDED", attempts: 1, output }) }),
      )
      return yield* attempted
    }),
  })
}
