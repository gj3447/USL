/** Apply explicitly selected portable representations to an existing resource graph. */
import { Either } from "effect"
import { contractDigest, contractSnapshot, freezeContract } from "../contract-core.js"
import { digestSource } from "../language/digest.js"
import { adaptResourceGraph, parseResourceGraph, type ResourceGraph } from "./resource-graph.js"
import { parseResourceBindings, resolveResourceRepresentation, selectResourceRepresentation, type ResourceBindings, type ResourceRepresentationSelection, type ResolvedResourceRepresentation } from "../resource-bindings.js"

const VALIDATION_NAMESPACE = "usl.resource-bindings.validation"
const MAX_INPUT_BYTES = 1024 * 1024
const unwrap = <T, E>(value: Either.Either<T, E>): T => Either.getOrThrowWith(value, error => error)

export interface ResourceGraphBindingOptions {
  readonly workspaces: Readonly<Record<string, string>>
  readonly hostname?: string
}
export interface ResourceGraphBindingReceipt {
  readonly sourceDigest: string
  readonly bindingsDigest: string
  readonly resultDigest: string
  readonly selections: readonly ResolvedResourceRepresentation[]
  readonly digest: string
}

/**
 * Bind only the caller-selected resource locators. Resource IDs, types,
 * metadata, meanings, links and provenance remain byte-for-value unchanged.
 */
export const bindResourceGraph = async (raw: string, bindings: ResourceBindings,
  selections: readonly ResourceRepresentationSelection[], options: ResourceGraphBindingOptions): Promise<{
    readonly graph: ResourceGraph
    readonly bindingReceipt: ResourceGraphBindingReceipt
  }> => {
  // Capture and validate every caller value before the first resolver await.
  if (typeof raw !== "string") throw new Error("resource graph source must be a string")
  if (Buffer.byteLength(raw, "utf8") > MAX_INPUT_BYTES) throw new Error("resource graph source exceeds 1 MiB")
  const source = unwrap(parseResourceGraph(raw))
  const capturedBindings = parseResourceBindings(bindings)
  const capturedOptions = contractSnapshot(options) as ResourceGraphBindingOptions
  const selectionInput = contractSnapshot(selections)
  if (!Array.isArray(selectionInput) || selectionInput.length > 1024) throw new Error("resource selections must contain at most 1024 entries")
  const capturedSelections = selectionInput.map(selection => {
    const selected = selectResourceRepresentation(capturedBindings, selection)
    return { resource: selected.resource.id, representation: selected.representation.id }
  })
  const graphResources = new Set(source.resources.map(resource => resource.id))
  const selectedResources = new Set<string>()
  for (const selection of capturedSelections) {
    if (!graphResources.has(selection.resource)) throw new Error(`selected resource is absent from graph: ${selection.resource}`)
    if (selectedResources.has(selection.resource)) throw new Error(`duplicate selected resource: ${selection.resource}`)
    selectedResources.add(selection.resource)
  }

  const resolved = await Promise.all(capturedSelections.map(selection => resolveResourceRepresentation(capturedBindings, selection, capturedOptions)))
  const locators = new Map(resolved.map(selection => [selection.resource, selection.locator]))
  const candidate = { ...source, resources: source.resources.map(resource => {
    const locator = locators.get(resource.id)
    return locator === undefined ? resource : { ...resource, locator }
  }) }
  const text = JSON.stringify(candidate)
  // This verifies the final locator grammar through the ordinary graph adapter.
  unwrap(adaptResourceGraph(text, { namespace: VALIDATION_NAMESPACE }))
  const graph = unwrap(parseResourceGraph(text))
  const receiptBody = {
    sourceDigest: digestSource(raw), bindingsDigest: contractDigest(capturedBindings), resultDigest: digestSource(text), selections: resolved,
  }
  return freezeContract({ graph, bindingReceipt: { ...receiptBody, digest: contractDigest(receiptBody) } })
}
