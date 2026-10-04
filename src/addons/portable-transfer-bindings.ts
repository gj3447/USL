/** Owner-selected local bindings for a verified historical restore or explicit local branch. */
import { z } from "zod"
import { contractDigest, contractSnapshot, freezeContract } from "../contract-core.js"
import { bindResourceGraph } from "../integrations/resource-bindings.js"
import { parseResourceBindings, selectResourceRepresentation, type ResourceBindings } from "../resource-bindings.js"
import { importPortableTransfer, recheckPortableRestore } from "./portable-transfer-import.js"

type VerifiedRestore = Awaited<ReturnType<typeof importPortableTransfer>>
export interface PortableRestoreBindingSelection {
  readonly resource: string
  readonly bindingRepresentation: string
  readonly nativeId: string
  readonly revisionId: string
  readonly representationId: string
}
export interface PortableRestoreBindingRequest {
  readonly bindings: ResourceBindings
  readonly workspaceId: string
  readonly selections: readonly PortableRestoreBindingSelection[]
  /** Optional existing graph: only selected resource locators will change. */
  readonly graph?: string
  readonly hostname?: string
}

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/u).max(256)
const requestSchema = z.object({
  bindings: z.unknown(), workspaceId: identifier,
  selections: z.array(z.object({ resource: z.string().min(1).max(4096), bindingRepresentation: identifier,
    nativeId: z.string().min(1).max(256), revisionId: z.string().min(1).max(512), representationId: z.string().min(1).max(512),
  }).strict()).min(1).max(1024),
  graph: z.string().max(1024 * 1024).optional(), hostname: z.string().min(1).max(256).optional(),
}).strict()

/**
 * Returns a local binding proposal. Does not install a host registration, activate
 * current state, grant access, or execute a restored program. A serialized result
 * is not a verification handle: the importer must first verify the local restore.
 */
export async function rebindPortableRestore(restore: VerifiedRestore, input: PortableRestoreBindingRequest) {
  const captured = requestSchema.parse(contractSnapshot(input, 2 * 1024 * 1024))
  const bindings = parseResourceBindings(captured.bindings)
  const selections = captured.selections.map(selection => {
    const selected = selectResourceRepresentation(bindings, { resource: selection.resource, representation: selection.bindingRepresentation })
    if (selected.representation.kind !== "workspace") throw new Error("restored binding selection must name a workspace representation")
    return { ...selection, selected: selected.representation }
  })
  if (new Set(selections.map(item => item.resource)).size !== selections.length) throw new Error("duplicate resource binding selection")
  const selectedIds = new Set(selections.map(item => item.bindingRepresentation))
  for (const resource of bindings.resources) for (const representation of resource.representations) {
    if (representation.kind === "workspace" && representation.workspace === captured.workspaceId && !selectedIds.has(representation.id)) {
      throw new Error("new workspace ID would remap an unselected representation")
    }
  }

  // This accepts only the importer's process-local, frozen verification handles.
  // It rehashes the restored files without needing the original backup location.
  await recheckPortableRestore(restore)
  const updates = new Map<string, { path: string; digest: string }>()
  for (const selection of selections) {
    const restored = restore.restored.find(item => item.nativeId === selection.nativeId && item.revisionId === selection.revisionId && item.representationId === selection.representationId)
    const representation = restore.manifest.representations.find(item => item.id === selection.representationId)
    if (!restored || !representation) throw new Error("explicit restore identity selection does not match the verified bundle")
    const expectedRelation = restore.freshnessMode === "LOCAL_BRANCH" ? "working-copy" : "snapshot"
    if (selection.selected.relation !== expectedRelation) throw new Error(`selected binding must explicitly declare ${expectedRelation}`)
    if (selection.selected.digest !== undefined && selection.selected.digest !== representation.byteDigest) throw new Error("existing binding digest conflicts with restored bytes")
    updates.set(selection.bindingRepresentation, { path: restored.restorePath, digest: representation.byteDigest })
  }
  const rebound = parseResourceBindings({ schema: bindings.schema, resources: bindings.resources.map(resource => ({
    ...resource, representations: resource.representations.map(representation => {
      const update = updates.get(representation.id)
      return update === undefined ? representation : { ...representation, workspace: captured.workspaceId, path: update.path, digest: update.digest }
    }),
  })) })
  const workspaces = { [captured.workspaceId]: restore.destinationPath }
  const bound = captured.graph === undefined ? undefined : await bindResourceGraph(captured.graph, rebound,
    selections.map(selection => ({ resource: selection.resource, representation: selection.bindingRepresentation })),
    { workspaces, ...(captured.hostname === undefined ? {} : { hostname: captured.hostname }) })
  await recheckPortableRestore(restore)
  const body = {
    schema: "usl-portable-restore-bindings/v1", bundleDigest: restore.bundleDigest,
    sourceBindingsDigest: contractDigest(bindings), resultBindingsDigest: contractDigest(rebound),
    bindings: rebound, workspaces, selections: captured.selections,
    freshness: restore.freshness, execution: "NOT_REQUESTED", authority: "NOT_GRANTED",
    registration: "LOCAL_PROPOSAL_ONLY", ...(bound === undefined ? {} : bound),
  }
  return freezeContract({ ...body, digest: contractDigest(body) })
}
