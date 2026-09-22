/**
 * A bounded, host-owned registry for capability descriptions and policies.
 * This module is deliberately pure: registration and lookup never install an
 * executor, fetch an inventory, or grant an authority to a caller.
 */
import { z } from "zod"
import {
  capabilitySchema,
  capabilityDiscoveryQuerySchema,
  capabilityInvocationSchema,
  capabilityPolicySchema,
  discoverCapabilities,
  parseCapability,
  preflightCapability,
  type CapabilityDescriptor,
  type CapabilityInvocation,
  type CapabilityPolicy,
} from "./capabilities.js"
import { contractDigest, contractSnapshot, contractText, freezeContract, uniqueContractIds } from "./contract-core.js"

const catalogEntrySchema = z.strictObject({ descriptor: capabilitySchema, policy: capabilityPolicySchema.optional() })
export const capabilityCatalogSchema = z.strictObject({
  schema: z.literal("usl-capability-catalog/v1"), complete: z.boolean(), entries: z.array(catalogEntrySchema).max(4096),
})
export type CapabilityCatalogEntry = Readonly<{ descriptor: CapabilityDescriptor; policy?: CapabilityPolicy }>
export type CapabilityCatalog = Readonly<{ schema: "usl-capability-catalog/v1"; complete: boolean; entries: readonly CapabilityCatalogEntry[] }>

/** Registration binds every supplied policy to the exact immutable descriptor/source snapshots. */
export const parseCapabilityCatalog = (input: unknown, maxBytes = 1024 * 1024): CapabilityCatalog => {
  const raw = capabilityCatalogSchema.parse(contractSnapshot(input, maxBytes))
  const entries = raw.entries.map(entry => {
    const descriptor = parseCapability(entry.descriptor)
    const policy = entry.policy === undefined ? undefined : freezeContract(capabilityPolicySchema.parse(contractSnapshot(entry.policy)))
    if (policy !== undefined) {
      if (policy.connection !== descriptor.connection || policy.capabilityId !== descriptor.id) throw new Error("catalog policy owner binding differs from descriptor")
      if (policy.descriptorDigest !== contractDigest(descriptor)) throw new Error("catalog policy descriptor pin differs")
      if (policy.sourceDigest !== descriptor.sourceDigest) throw new Error("catalog policy source pin differs")
    }
    return policy === undefined ? { descriptor } : { descriptor, policy }
  })
  uniqueContractIds(entries.map(entry => JSON.stringify([entry.descriptor.connection, entry.descriptor.id])), "catalog connection/capability identity")
  return freezeContract({ schema: raw.schema, complete: raw.complete, entries })
}

export const capabilityCatalogDiscoveryQuerySchema = capabilityDiscoveryQuerySchema
export type CapabilityCatalogDiscoveryQuery = z.infer<typeof capabilityCatalogDiscoveryQuerySchema>

/** Policies are intentionally omitted from discovery output; a description is not an authorization. */
export const discoverCapabilityCatalog = (catalogInput: unknown, queryInput: unknown) => {
  const query = capabilityCatalogDiscoveryQuerySchema.parse(contractSnapshot(queryInput))
  const catalog = parseCapabilityCatalog(catalogInput)
  const discovery = discoverCapabilities(catalog.entries.map(entry => entry.descriptor), query, catalog.complete)
  return freezeContract({ ...discovery, catalogDigest: contractDigest(catalog) })
}

export const capabilityCatalogSelectionSchema = z.strictObject({
  connection: contractText, capability: contractText, invocation: capabilityInvocationSchema,
})
export type CapabilityCatalogPreflightSelection = z.infer<typeof capabilityCatalogSelectionSchema>

/** Resolve only one registered descriptor/policy pair. This never invokes an executor. */
export const preflightCapabilityCatalog = (catalogInput: unknown, selectionInput: unknown) => {
  const selection = capabilityCatalogSelectionSchema.parse(contractSnapshot(selectionInput))
  const catalog = parseCapabilityCatalog(catalogInput)
  const entry = catalog.entries.find(candidate => candidate.descriptor.connection === selection.connection && candidate.descriptor.id === selection.capability)
  if (entry === undefined) throw new Error("catalog capability is not registered")
  if (entry.policy === undefined) throw new Error("catalog capability has no host policy")
  const preflight = preflightCapability(entry.descriptor, selection.invocation as CapabilityInvocation, entry.policy)
  return freezeContract({ ...preflight, catalogDigest: contractDigest(catalog) })
}
