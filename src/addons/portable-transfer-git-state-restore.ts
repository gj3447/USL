/** Restore a CP03 raw state sidecar over independently verified CP01 Git history. */
import { lstat, mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import { contractIri, contractSnapshot, freezeContract } from "../contract-core.js"
import { gitTransferInternals, type CleanGitRestoreResult } from "./portable-transfer-git.js"
import { verifyGitWorktreeState, type GitWorktreeState } from "./portable-transfer-git-state.js"

const { runGit, git, safeDirectory, regularBytes, safeRestorePath, sha, within, deadline } = gitTransferInternals
const MAX_BYTES = 512 * 1024 * 1024, STATE_BYTES = 64 * 1024 * 1024, METADATA = 16 * 1024 * 1024
const label = z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/u)
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u), oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u)
const leaf = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u).refine(safeRestorePath)
const filePath = z.string().min(1).max(1024).refine(safeRestorePath)
const revision = z.string().regex(/^urn:usl:git-state:[a-f0-9]{64}$/u)
const fileSchema = z.object({ nativeId: label, revisionId: revision, representationId: label, worktreeId: label, path: filePath,
  expectedByteDigest: digest, expectedByteLength: z.number().int().min(0).max(STATE_BYTES) }).strict()
const worktreeSchema = z.object({ worktreeId: label, path: leaf, head: oid, branch: z.string().min(1).max(512).optional(),
  artifactPath: z.string().min(1).max(4096), expectedStateReceiptDigest: digest }).strict()
const requestSchema = z.object({
  schema: z.literal("usl-git-state-import/v1"), bundlePath: z.string().min(1).max(4096), expectedReceiptDigest: digest,
  allowedOwnerNamespace: contractIri.max(512), expectedRepositoryId: label,
  destinationParent: z.string().min(1).max(4096), destinationName: leaf,
  worktrees: z.array(worktreeSchema).min(1).max(16), files: z.array(fileSchema).max(1024),
  freshnessMode: z.enum(["HISTORICAL_SNAPSHOT", "LOCAL_BRANCH"]).default("HISTORICAL_SNAPSHOT"),
  maxStateBytes: z.number().int().min(1).max(STATE_BYTES).optional(), maxStateEntries: z.number().int().min(1).max(10_000).optional(),
  maxBundleBytes: z.number().int().min(1).max(MAX_BYTES).optional(), maxUncompressedBytes: z.number().int().min(1).max(MAX_BYTES).optional(),
  maxCheckoutBytes: z.number().int().min(1).max(MAX_BYTES).optional(), maxObjects: z.number().int().min(1).max(100_000).optional(),
  maxDurationMs: z.number().int().min(1).max(300_000).optional(),
}).strict()

/** Dirty bytes are identified by their state receipt, never by a commit OID alone. */
export const gitStateRevisionId = (receiptDigest: string): string => `urn:usl:git-state:${digest.parse(receiptDigest).slice(7)}`
export interface RestoredGitStateFile {
  readonly nativeId: string; readonly revisionId: string; readonly representationId: string; readonly worktreeId: string
  readonly path: string; readonly restorePath: string; readonly byteDigest: string; readonly bytes: number; readonly mode: string; readonly parentHead: string
}
export interface GitStateRestoreResult extends Omit<CleanGitRestoreResult, "files"> {
  readonly schema: "usl-git-state-restore/v1"
  readonly files: readonly RestoredGitStateFile[]
  readonly stateReceipts: readonly { readonly worktreeId: string; readonly receiptDigest: string; readonly revisionId: string }[]
  readonly scope: "RAW_REGULAR_SELECTED_STATE_ONLY"
  readonly emptyDirectories: "NOT_RECONSTRUCTED"
}
const handles = new WeakMap<object, CleanGitRestoreResult>()
const equalRows = (left: readonly string[], right: readonly string[]) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
const indexRows = (state: GitWorktreeState) => state.index.map(e => `${e.mode} ${e.objectId} ${e.stage}\t${e.path}`)
const treeRows = (entries: readonly { path: string; mode: string; objectId: string }[]) => entries.map(e => `${e.mode} ${e.objectId}\t${e.path}`)

export async function recheckGitStateRestore(result: unknown): Promise<GitStateRestoreResult> {
  const base = result && typeof result === "object" ? handles.get(result) : undefined
  if (!base) throw new Error("unverified Git state restore handle; serialized or cross-profile handles are not accepted")
  await gitTransferInternals.recheckOverlayIntegrity(base)
  return result as GitStateRestoreResult
}

/** No existing workspace is edited: failed imports only clean their own new reservation. */
export async function importGitWorktreeState(input: unknown): Promise<GitStateRestoreResult> {
  const request = requestSchema.parse(contractSnapshot(input, 2 * 1024 * 1024))
  const duration = request.maxDurationMs ?? 60_000, end = Date.now() + duration
  const maxState = request.maxStateBytes ?? 16 * 1024 * 1024, maxEntries = request.maxStateEntries ?? 10_000
  const maxCheckout = request.maxCheckoutBytes ?? 64 * 1024 * 1024
  const unique = (values: string[], name: string) => { if (new Set(values).size !== values.length) throw new Error(`duplicate ${name}`) }
  unique(request.worktrees.map(w => w.worktreeId), "worktree identity")
  unique(request.worktrees.map(w => w.path.toLowerCase()), "worktree path")
  unique(request.worktrees.flatMap(w => w.branch ? [w.branch] : []), "checked-out branch")
  unique(request.files.map(f => f.representationId), "representation identity")
  unique(request.files.map(f => JSON.stringify([f.worktreeId, f.path.normalize("NFC").toLowerCase()])), "selected file path")
  const parent = await safeDirectory(request.destinationParent, end), destination = join(parent, request.destinationName)
  const states = new Map<string, GitWorktreeState>(), payloads = new Map<string, Map<string, Buffer>>()
  let totalBytes = 0, workingBytes = 0, entries = 0
  for (const wt of request.worktrees) {
    const artifact = await safeDirectory(wt.artifactPath, end)
    if (within(artifact, destination) || within(destination, artifact)) throw new Error("state artifact and restore destination must be separate")
    deadline(end)
    const state = await verifyGitWorktreeState({ schema: "usl-git-state-verify/v1", artifactPath: artifact, expectedReceiptDigest: wt.expectedStateReceiptDigest,
      allowedOwnerNamespace: request.allowedOwnerNamespace, expectedRepositoryId: request.expectedRepositoryId, expectedWorktreeId: wt.worktreeId, expectedHead: wt.head,
      maxBytes: maxState, maxEntries, maxDurationMs: Math.max(1, end - Date.now()) })
    if (state.branch !== (wt.branch ?? null)) throw new Error("state branch/detached attachment differs from restore selection")
    for (const blob of state.blobs) totalBytes += blob.bytes
    entries += state.index.length + state.working.length + state.headTree.length
    if (totalBytes > maxState || entries > maxEntries) throw new Error("aggregate state byte/entry budget exceeded")
    const bytes = new Map(state.blobs.map(b => [b.digest, Buffer.from(b.base64, "base64")]))
    for (const file of state.working) if (file.kind === "REGULAR") workingBytes += bytes.get(file.blobDigest)!.length
    if (!Number.isSafeInteger(workingBytes) || workingBytes > maxCheckout) throw new Error("aggregate state checkout byte budget exceeded")
    states.set(wt.worktreeId, state); payloads.set(wt.worktreeId, bytes)
  }
  const restored: RestoredGitStateFile[] = [], nativeRevisions = new Map<string, string>()
  for (const file of request.files) {
    const wt = request.worktrees.find(w => w.worktreeId === file.worktreeId)
    if (!wt || file.revisionId !== gitStateRevisionId(wt.expectedStateReceiptDigest)) throw new Error("selected state revision/worktree identity mismatch")
    const working = states.get(wt.worktreeId)!.working.find(f => f.path === file.path)
    if (!working || working.kind !== "REGULAR") throw new Error("selected state binding needs a present working file")
    const bytes = payloads.get(wt.worktreeId)!.get(working.blobDigest)!
    if (working.blobDigest !== file.expectedByteDigest || bytes.length !== file.expectedByteLength) throw new Error("selected working file byte pin mismatch")
    const key = JSON.stringify([file.nativeId, file.revisionId]), descriptor = JSON.stringify([file.path, file.expectedByteDigest, file.expectedByteLength])
    if (nativeRevisions.has(key) && nativeRevisions.get(key) !== descriptor) throw new Error("contradictory native state revision descriptor")
    nativeRevisions.set(key, descriptor)
    restored.push({ nativeId: file.nativeId, revisionId: file.revisionId, representationId: file.representationId, worktreeId: file.worktreeId,
      path: file.path, restorePath: `worktrees/${wt.path}/${file.path}`, byteDigest: working.blobDigest, bytes: bytes.length, mode: working.mode, parentHead: wt.head })
  }
  const stateReceipts = request.worktrees.map(w => ({ worktreeId: w.worktreeId, receiptDigest: w.expectedStateReceiptDigest, revisionId: gitStateRevisionId(w.expectedStateReceiptDigest) }))
  const base = await gitTransferInternals.importWithOverlay({
    schema: "usl-clean-git-import/v1", bundlePath: request.bundlePath, expectedReceiptDigest: request.expectedReceiptDigest,
    destinationParent: request.destinationParent, destinationName: request.destinationName, allowedOwnerNamespace: request.allowedOwnerNamespace, expectedRepositoryId: request.expectedRepositoryId,
    worktrees: request.worktrees.map(({ worktreeId, path, head, branch }) => ({ worktreeId, path, head, ...(branch === undefined ? {} : { branch }) })),
    files: [], freshnessMode: request.freshnessMode,
    ...Object.fromEntries(["maxBundleBytes", "maxUncompressedBytes", "maxCheckoutBytes", "maxObjects", "maxDurationMs"].filter(key => Object.hasOwn(request, key)).map(key => [key, request[key as keyof typeof request]])),
  }, {
    maxExtraBytes: maxState + METADATA, deadline: end,
    async apply({ stage, repository, manifest, trees, worktrees, end }) {
      // Prove HEAD tree descriptors against the independent object closure before overlay writes.
      for (const wt of worktrees) {
        const state = states.get(wt.worktreeId)!
        if (state.objectFormat !== manifest.objectFormat || !equalRows(treeRows(state.headTree), treeRows(trees.get(wt.worktreeId)!))) throw new Error("state HEAD tree/object format differs from independently verified Git history")
      }
      const inserted = new Set<string>()
      for (const wt of worktrees) {
        const state = states.get(wt.worktreeId)!, blobs = payloads.get(wt.worktreeId)!, target = join(stage, "worktrees", wt.path)
        await safeDirectory(target, end)
        for (const entry of state.index) if (!inserted.has(entry.objectId)) {
          const actual = (await runGit(repository, ["hash-object", "-w", "--no-filters", "--stdin"], end, 128, blobs.get(entry.blobDigest)!)).toString("ascii").trim()
          if (actual !== entry.objectId) throw new Error("restored native blob OID mismatch")
          inserted.add(actual)
        }
        // Private worktree index only; no checkout/reset can overwrite the recorded working bytes.
        await git(target, ["read-tree", "--empty"], end)
        if (state.index.length) await runGit(target, ["update-index", "-z", "--index-info"], end, METADATA, indexRows(state).join("\0") + "\0")
        for (const file of trees.get(wt.worktreeId)!) {
          await safeDirectory(dirname(join(target, file.path)), end)
          await regularBytes(join(target, file.path), file.bytes, end)
          await rm(join(target, file.path))
        }
        for (const file of state.working) if (file.kind === "REGULAR") {
          deadline(end)
          const path = join(target, file.path), bytes = blobs.get(file.blobDigest)!
          await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await safeDirectory(dirname(path), end)
          await writeFile(path, bytes, { flag: "wx", mode: file.mode === "100755" ? 0o700 : 0o600 })
        }
        if (!equalRows((await git(target, ["ls-files", "--stage", "-z"], end)).split("\0").filter(Boolean), indexRows(state))) throw new Error("restored index stage/mode/OID differs from captured state")
        for (const file of state.working) {
          const path = join(target, file.path)
          if (file.kind === "ABSENT") {
            try { await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error }
            throw new Error("restored working deletion is present")
          }
          const bytes = blobs.get(file.blobDigest)!, info = await lstat(path)
          if (sha(await regularBytes(path, bytes.length, end)) !== file.blobDigest || (info.mode & 0o100 ? "100755" : "100644") !== file.mode) throw new Error("restored working bytes/mode differ from captured state")
        }
      }
      return { profile: "RAW_REGULAR_GIT_STATE_V1", scope: "RAW_REGULAR_SELECTED_STATE_ONLY", stateReceipts, files: restored,
        indexEncoding: "REGENERATED", emptyDirectories: "NOT_RECONSTRUCTED", history: "INDEPENDENT_BASE_BUNDLE", permissions: "EXECUTABLE_BIT_ONLY", authority: "NOT_GRANTED", execution: "NOT_REQUESTED" }
    },
  })
  const result: GitStateRestoreResult = freezeContract({ ...base, schema: "usl-git-state-restore/v1", files: restored, stateReceipts, scope: "RAW_REGULAR_SELECTED_STATE_ONLY", emptyDirectories: "NOT_RECONSTRUCTED" })
  handles.set(result, base)
  return result
}
