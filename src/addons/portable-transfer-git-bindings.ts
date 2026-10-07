/** Owner-selected binding proposals over a freshly verified local Git restore. */
import { z } from "zod"
import { join } from "node:path"
import { contractDigest, contractSnapshot, freezeContract } from "../contract-core.js"
import { bindResourceGraph } from "../integrations/resource-bindings.js"
import { parseResourceBindings, selectResourceRepresentation, type ResourceBindings } from "../resource-bindings.js"
import { importCleanGitTransfer, recheckCleanGitRestore } from "./portable-transfer-git.js"

type VerifiedRestore = Awaited<ReturnType<typeof importCleanGitTransfer>>
export interface CleanGitRestoreBindingSelection {
  readonly resource: string
  readonly bindingRepresentation: string
  readonly nativeId: string
  readonly revisionId: string
  readonly representationId: string
  readonly worktreeId: string
}
export interface CleanGitRestoreBindingRequest {
  readonly bindings: ResourceBindings
  /** Single selected worktree convenience; multi-worktree selections use workspaces. */
  readonly workspaceId?: string
  readonly workspaces?: Readonly<Record<string, string>>
  readonly selections: readonly CleanGitRestoreBindingSelection[]
  readonly graph?: string
  readonly hostname?: string
}
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/u).max(256)
const label = z.string().min(1).max(512)
const requestSchema = z.object({
  bindings: z.unknown(), workspaceId: identifier.optional(), workspaces: z.record(label, identifier).optional(),
  selections: z.array(z.object({ resource: z.string().min(1).max(4096), bindingRepresentation: identifier,
    nativeId: label, revisionId: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64}|urn:usl:git-state:[a-f0-9]{64})$/u), representationId: label, worktreeId: label,
  }).strict()).min(1).max(1024),
  graph: z.string().max(1024 * 1024).optional(), hostname: z.string().min(1).max(256).optional(),
}).strict().refine(x => (x.workspaceId === undefined) !== (x.workspaces === undefined), "select workspaceId or an explicit worktree-to-workspace mapping")

/** No registration writes, owner-head activation, permission grants or restored code execution. */
export async function rebindCleanGitRestore(restore: VerifiedRestore, input: CleanGitRestoreBindingRequest) {
  return proposeBindings(restore, input, { schema: "usl-clean-git-restore-bindings/v1", freshness: "PINNED_HISTORICAL_REVISION", recheck: recheckCleanGitRestore })
}
interface BindingRestoreView {
  readonly destinationPath: string; readonly manifestDigest: string; readonly bundleDigest: string
  readonly freshnessMode: "LOCAL_BRANCH" | "HISTORICAL_SNAPSHOT"
  readonly worktrees: readonly { readonly worktreeId: string; readonly path: string }[]
  readonly files: readonly { readonly nativeId: string; readonly revisionId: string; readonly representationId: string; readonly worktreeId: string; readonly path: string; readonly byteDigest: string }[]
  readonly stateReceipts?: readonly { readonly worktreeId: string; readonly receiptDigest: string; readonly revisionId: string }[]
}
async function proposeBindings(restore: BindingRestoreView, input: CleanGitRestoreBindingRequest, options: {
  schema: string; freshness: string; recheck: (value: unknown) => Promise<unknown>
  includeStateReceipts?: boolean
}) {
  const captured = requestSchema.parse(contractSnapshot(input, 2 * 1024 * 1024))
  const bindings = parseResourceBindings(captured.bindings)
  const selections = captured.selections.map(selection => {
    const selected = selectResourceRepresentation(bindings, { resource: selection.resource, representation: selection.bindingRepresentation })
    if (selected.representation.kind !== "workspace") throw new Error("Git restore binding must select a workspace representation")
    return { ...selection, selected: selected.representation }
  })
  if (new Set(selections.map(item => item.resource)).size !== selections.length ||
      new Set(selections.map(item => item.bindingRepresentation)).size !== selections.length) throw new Error("duplicate resource or representation selection")
  const worktreeIds = [...new Set(selections.map(item => item.worktreeId))]
  if (captured.workspaceId !== undefined && worktreeIds.length !== 1) throw new Error("multiple worktrees require explicit workspaces mapping")
  const workspaceIds = captured.workspaceId === undefined ? captured.workspaces! : { [worktreeIds[0]!]: captured.workspaceId }
  if (Object.keys(workspaceIds).length !== worktreeIds.length || worktreeIds.some(id => !Object.hasOwn(workspaceIds, id)) ||
      new Set(Object.values(workspaceIds)).size !== worktreeIds.length) throw new Error("workspaces mapping must cover exactly the selected worktrees with unique workspace IDs")
  const newWorkspaceIds = new Set(Object.values(workspaceIds))
  const selectedIds = new Set(selections.map(item => item.bindingRepresentation))
  for (const resource of bindings.resources) for (const representation of resource.representations) {
    if (representation.kind === "workspace" && newWorkspaceIds.has(representation.workspace) && !selectedIds.has(representation.id))
      throw new Error("new workspace ID would remap an unselected representation")
  }
  await options.recheck(restore)
  const updates = new Map<string, { path: string; digest: string; workspace: string }>()
  const workspaces: Record<string, string> = Object.create(null)
  for (const selection of selections) {
    const file = restore.files.find(item => item.nativeId === selection.nativeId && item.revisionId === selection.revisionId &&
      item.representationId === selection.representationId && item.worktreeId === selection.worktreeId)
    if (!file) throw new Error("explicit Git restore identity selection does not match verified files")
    const worktree = restore.worktrees.find(item => item.worktreeId === file.worktreeId)
    if (!worktree) throw new Error("verified worktree is absent")
    const relation = restore.freshnessMode === "LOCAL_BRANCH" ? "working-copy" : "snapshot"
    if (selection.selected.relation !== relation) throw new Error(`Git restore binding must explicitly declare ${relation}`)
    if (selection.selected.digest !== undefined && selection.selected.digest !== file.byteDigest) throw new Error("existing binding digest conflicts with restored bytes")
    const workspace = workspaceIds[file.worktreeId]!
    workspaces[workspace] = join(restore.destinationPath, worktree.path)
    updates.set(selection.bindingRepresentation, { path: file.path, digest: file.byteDigest, workspace })
  }
  const rebound = parseResourceBindings({ schema: bindings.schema, resources: bindings.resources.map(resource => ({
    ...resource, representations: resource.representations.map(representation => {
      const update = updates.get(representation.id)
      return update === undefined ? representation : { ...representation, workspace: update.workspace, path: update.path, digest: update.digest }
    }),
  })) })
  const bound = captured.graph === undefined ? undefined : await bindResourceGraph(captured.graph, rebound,
    selections.map(selection => ({ resource: selection.resource, representation: selection.bindingRepresentation })),
    { workspaces, ...(captured.hostname === undefined ? {} : { hostname: captured.hostname }) })
  // A wrong HEAD with identical selected bytes is still a stale restore.
  await options.recheck(restore)
  const body = {
    schema: options.schema, manifestDigest: restore.manifestDigest, bundleDigest: restore.bundleDigest,
    sourceBindingsDigest: contractDigest(bindings), resultBindingsDigest: contractDigest(rebound),
    bindings: rebound, workspaces, selections: captured.selections, freshness: options.freshness,
    ...(options.includeStateReceipts ? { stateReceipts: restore.stateReceipts! } : {}),
    execution: "NOT_REQUESTED", authority: "NOT_GRANTED", registration: "LOCAL_PROPOSAL_ONLY", ...(bound === undefined ? {} : bound),
  }
  return freezeContract({ ...body, digest: contractDigest(body) })
}
/** @internal The caller supplies a profile-specific opaque-handle recheck, never user callbacks. */
export const gitRestoreBindingInternals = Object.freeze({ proposeBindings })
