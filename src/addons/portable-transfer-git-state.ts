/** CP03 state sidecar: capture and verify raw index/working bytes. No workspace restoration. */
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, opendir, rename, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"
import { contractDigest, contractIri, contractSnapshot, freezeContract } from "../contract-core.js"
import { gitTransferInternals } from "./portable-transfer-git.js"

const { runGit, git, safeDirectory, regularBytes, absent, checkObjectStore, safeRestorePath, sha, within, deadline } = gitTransferInternals
const MAX_BYTES = 64 * 1024 * 1024, DEFAULT_BYTES = 16 * 1024 * 1024, MAX_ENTRIES = 10_000, METADATA = 4 * 1024 * 1024
const MAX_DURATION = 300_000, OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u), oid = z.string().regex(OID)
const label = z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/u), mode = z.enum(["100644", "100755"])
const path = z.string().min(1).max(1024).refine(safeRestorePath)
const identity = { ownerNamespace: contractIri.max(512), repositoryId: label, worktreeId: label, issuer: contractIri.max(512), observedAt: z.iso.datetime({ offset: false }) }
const budgets = { maxBytes: z.number().int().min(1).max(MAX_BYTES).optional(), maxEntries: z.number().int().min(1).max(MAX_ENTRIES).optional(), maxDurationMs: z.number().int().min(1).max(MAX_DURATION).optional() }
const exportSchema = z.object({ schema: z.literal("usl-git-state-export/v1"), sourceRoot: z.string().min(1).max(4096), destinationParent: z.string().min(1).max(4096),
  ...identity, expectedHead: oid, expectedObjectFormat: z.enum(["sha1", "sha256"]), selectedUntracked: z.array(path).max(MAX_ENTRIES), ...budgets }).strict()
const verifySchema = z.object({ schema: z.literal("usl-git-state-verify/v1"), artifactPath: z.string().min(1).max(4096), expectedReceiptDigest: digest,
  allowedOwnerNamespace: contractIri.max(512), expectedRepositoryId: label, expectedWorktreeId: label, expectedHead: oid, ...budgets }).strict()
const SCOPE = {
  restore: "NOT_IMPLEMENTED", bindings: "NOT_IMPLEMENTED", history: "NOT_INCLUDED", stash: "NOT_CAPTURED", reflog: "NOT_CAPTURED",
  ignored: "NOT_CAPTURED", unselectedUntracked: "NOT_CAPTURED", configuration: "NOT_CAPTURED", permissions: "EXECUTABLE_BIT_ONLY",
  observation: "NON_ATOMIC", authority: "NOT_GRANTED", execution: "NOT_REQUESTED",
} as const
const treeEntry = z.object({ path, mode, objectId: oid }).strict()
const indexEntry = treeEntry.extend({ stage: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]), blobDigest: digest }).strict()
const workingEntry = z.discriminatedUnion("kind", [z.object({ path, kind: z.literal("REGULAR"), mode, blobDigest: digest }).strict(), z.object({ path, kind: z.literal("ABSENT") }).strict()])
const stateSchema = z.object({
  schema: z.literal("usl-git-state/v1"), profile: z.literal("RAW_REGULAR_GIT_STATE_V1"), ...identity,
  head: oid, branch: z.string().min(1).max(512).nullable(), objectFormat: z.enum(["sha1", "sha256"]),
  indexObservation: z.object({ byteDigest: digest, version: z.union([z.literal(2), z.literal(3), z.literal(4)]) }).strict(),
  headTree: z.array(treeEntry).max(MAX_ENTRIES), index: z.array(indexEntry).max(MAX_ENTRIES), working: z.array(workingEntry).max(MAX_ENTRIES),
  selectedUntracked: z.array(path).max(MAX_ENTRIES), blobs: z.array(z.object({ digest, bytes: z.number().int().min(0).max(MAX_BYTES), base64: z.string().max(Math.ceil(MAX_BYTES / 3) * 4) }).strict()).max(MAX_ENTRIES * 2),
  scope: z.object(Object.fromEntries(Object.entries(SCOPE).map(([key, value]) => [key, z.literal(value)])) as { [K in keyof typeof SCOPE]: z.ZodLiteral<(typeof SCOPE)[K]> }).strict(),
}).strict()
export type GitWorktreeState = Readonly<z.infer<typeof stateSchema>>
export interface GitWorktreeStateExport {
  readonly artifactPath: string; readonly statePath: string; readonly receiptDigest: string; readonly stateDigest: string; readonly state: GitWorktreeState
}
const receiptSchema = z.object({ schema: z.literal("usl-git-state-receipt/v1"), stateDigest: digest, stateByteDigest: digest,
  bytes: z.number().int().min(1).max(MAX_BYTES * 2 + METADATA), execution: z.literal("LOCAL_CAPTURE_ONLY") }).strict()
const hold = (reason: string): never => { throw new Error(`HOLD_GIT_STATE: ${reason}`) }
const sorted = (values: readonly string[]) => [...values].sort()
const sameStrings = (a: readonly string[], b: readonly string[]) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))
const blobOid = (bytes: Buffer, format: "sha1" | "sha256") => createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
// Same sorted-key JSON digest algorithm as contractDigest, with this sidecar's bounded binary budget.
const stateDigest = (state: GitWorktreeState) => {
  const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered) : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered((value as Record<string, unknown>)[key])])) : value
  return sha(Buffer.from(JSON.stringify(ordered(state))))
}
const protectedPath = (name: string) => name.split("/").some(p => /^(?:\.env(?:\..*)?|\.gitconfig|\.git-credentials|\.npmrc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/iu.test(p))
const assertPath = (name: string) => {
  if (!safeRestorePath(name) || protectedPath(name)) hold("unsafe or private configuration path")
  if (name.split("/").some(p => p.toLowerCase() === ".gitattributes")) hold("attributes require a separate transformation profile")
}
function checkPaths(names: readonly string[]) {
  const folded = new Map<string, string>(), files = new Set(names)
  for (const name of names) {
    assertPath(name)
    const parts = name.split("/")
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/"), key = prefix.normalize("NFC").toLowerCase()
      if (folded.has(key) && folded.get(key) !== prefix) hold("case/normalization path collision")
      folded.set(key, prefix)
      if (i < parts.length && files.has(prefix)) hold("file/directory path collision")
    }
  }
}
function validateState(input: unknown, maxBytes: number, maxEntries: number, end: number): GitWorktreeState {
  const state = stateSchema.parse(contractSnapshot(input, maxBytes * 2 + METADATA))
  const length = state.objectFormat === "sha1" ? 40 : 64
  if (state.head.length !== length || [...state.headTree, ...state.index].some(e => e.objectId.length !== length)) hold("OID width differs from object format")
  if (state.branch !== null && (!state.branch.startsWith("refs/heads/") || /[\s~^:?*\[\\]/u.test(state.branch) || state.branch.includes("..") || state.branch.includes("@{") || state.branch.split("/").some(p => !p || p.startsWith(".") || p.endsWith(".") || p.endsWith(".lock")))) hold("unsupported branch attachment")
  if ([state.headTree, state.index, state.working, state.selectedUntracked].some(rows => rows.length > maxEntries)) hold("entry budget exceeded")
  checkPaths([...state.headTree, ...state.index, ...state.working].map(e => e.path).concat(state.selectedUntracked))
  const unique = (values: string[]) => { if (new Set(values).size !== values.length) hold("duplicate state entry") }
  unique(state.headTree.map(e => e.path)); unique(state.index.map(e => JSON.stringify([e.path, e.stage])))
  unique(state.working.map(e => e.path)); unique(state.selectedUntracked); unique(state.blobs.map(e => e.digest))
  const indexPaths = new Set(state.index.map(e => e.path))
  const unmergedPaths = new Set(state.index.filter(e => e.stage !== 0).map(e => e.path))
  if (state.index.some(e => e.stage === 0 && unmergedPaths.has(e.path))) hold("stage zero mixed with conflict stages")
  if (state.selectedUntracked.some(p => indexPaths.has(p)) || !sameStrings(state.working.map(e => e.path), [...indexPaths, ...state.selectedUntracked])) hold("working path set differs from index and explicit selection")
  const blobs = new Map<string, Buffer>(); let total = 0
  for (const blob of state.blobs) {
    deadline(end)
    total += blob.bytes
    if (!Number.isSafeInteger(total) || total > maxBytes) hold("blob byte budget exceeded")
    const bytes = Buffer.from(blob.base64, "base64")
    if (bytes.length !== blob.bytes || bytes.toString("base64") !== blob.base64 || sha(bytes) !== blob.digest) hold("noncanonical or corrupted blob bytes")
    if (bytes.subarray(0, 80).toString("utf8").startsWith("version https://git-lfs.github.com/spec/v1")) hold("LFS content needs a closure profile")
    blobs.set(blob.digest, bytes)
  }
  const used = new Set<string>()
  for (const entry of state.index) {
    deadline(end)
    const bytes = blobs.get(entry.blobDigest)
    if (!bytes || blobOid(bytes, state.objectFormat) !== entry.objectId) hold("index blob OID or payload mismatch")
    used.add(entry.blobDigest)
  }
  for (const entry of state.working) {
    if (entry.kind === "REGULAR") {
      if (!blobs.has(entry.blobDigest)) hold("working blob missing")
      used.add(entry.blobDigest)
    } else if (state.selectedUntracked.includes(entry.path)) hold("selected untracked file absent")
  }
  if (used.size !== blobs.size) hold("unreferenced blob would disclose unselected content")
  deadline(end)
  return freezeContract(state)
}

/** Source Git probes do not compare files through filters or copy configuration/history. */
async function observe(root: string, request: z.infer<typeof exportSchema>, destination: string, end: number) {
  if ((await git(root, ["rev-parse", "--is-inside-work-tree"], end)).trim() !== "true" || resolve((await git(root, ["rev-parse", "--show-toplevel"], end)).trim()) !== root) hold("source must be an exact worktree root")
  const common = await safeDirectory((await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], end)).trim(), end)
  const admin = await safeDirectory((await git(root, ["rev-parse", "--absolute-git-dir"], end)).trim(), end)
  if (within(common, destination) || within(admin, destination)) hold("destination is inside Git administration")
  const local = await git(root, ["config", "--local", "--no-includes", "--null", "--list"], end, METADATA)
  const includes = /(?:^|\0)(?:include\.path|includeif\.[^\n]*\.path)\n/iu
  if (includes.test(local)) hold("configuration includes")
  const worktreeConfig = (await git(root, ["config", "--local", "--no-includes", "--bool", "--get", "extensions.worktreeConfig"], end, METADATA, true)).trim()
  // --worktree is an error for ordinary linked worktrees unless this extension is enabled.
  const worktree = worktreeConfig === "true" ? await git(root, ["config", "--worktree", "--no-includes", "--null", "--list"], end, METADATA) : ""
  if (includes.test(worktree)) hold("configuration includes")
  const unsupported = await git(root, ["config", "--get-regexp", "^(remote\\..*\\.(promisor|partialclonefilter)|extensions\\.partialclone|filter\\..*\\.(clean|smudge|process))$"], end, METADATA, true)
  if (unsupported) hold("partial clone or executable filter")
  const sparse = (await git(root, ["config", "--bool", "core.sparseCheckout"], end, METADATA, true)).trim()
  if (sparse && sparse !== "false") hold("sparse checkout")
  if ((await git(root, ["rev-parse", "--is-shallow-repository"], end)).trim() !== "false") hold("shallow history")
  if ((await git(root, ["rev-parse", "--shared-index-path"], end)).trim()) hold("split index")
  for (const p of [join(common, "info", "grafts"), join(common, "objects", "info", "alternates"), join(common, "objects", "info", "http-alternates"), join(common, "info", "attributes")]) await absent(p, "unsupported Git dependencies or attributes")
  await checkObjectStore(await safeDirectory(join(common, "objects"), end), end)
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_START", "sequencer", "AUTO_MERGE", "index.lock"]) await absent(join(admin, name), "in-progress state or index lock")
  if ((await git(root, ["for-each-ref", "--format=%(refname)", "refs/replace"], end)).trim()) hold("replace refs")
  const format = (await git(root, ["rev-parse", "--show-object-format"], end)).trim()
  const head = (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"], end)).trim()
  if (format !== request.expectedObjectFormat || head !== request.expectedHead) hold("HEAD/object format differs from owner pin")
  const attachment = (await git(root, ["symbolic-ref", "-q", "HEAD"], end, METADATA, true)).trim()
  const rawIndex = await regularBytes(join(admin, "index"), METADATA, end)
  const hashBytes = format === "sha1" ? 20 : 32
  if (rawIndex.length < 12 + hashBytes) hold("truncated index")
  const version = rawIndex.readUInt32BE(4)
  if (rawIndex.subarray(0, 4).toString("ascii") !== "DIRC" || ![2, 3, 4].includes(version) ||
      !createHash(format).update(rawIndex.subarray(0, -hashBytes)).digest().equals(rawIndex.subarray(-hashBytes))) hold("unsupported or corrupted index encoding")
  const maxEntries = request.maxEntries ?? MAX_ENTRIES, maxBytes = request.maxBytes ?? DEFAULT_BYTES
  if (rawIndex.readUInt32BE(8) > maxEntries) hold("index entry budget exceeded")
  const flags = (await git(root, ["ls-files", "-v", "-z"], end, METADATA)).split("\0").filter(Boolean)
  if (flags.some(row => !["H", "M"].includes(row[0]!))) hold("skip-worktree or assume-unchanged flags")
  const indexText = await git(root, ["ls-files", "--stage", "-z"], end, METADATA)
  const indexRows = indexText.split("\0").filter(Boolean).map(row => {
    const m = /^(100644|100755) ([a-f0-9]+) ([0-3])\t(.+)$/su.exec(row)
    if (!m) return hold("non-regular index entry")
    return { path: m[4]!, mode: m[1]! as "100644" | "100755", objectId: m[2]!, stage: Number(m[3]) as 0 | 1 | 2 | 3 }
  })
  if (indexRows.length !== rawIndex.readUInt32BE(8) || indexRows.length > maxEntries) hold("index entry count mismatch")
  // --debug has no stable format promise. Accept only this exact recognized framing, otherwise HOLD.
  let debug = await git(root, ["ls-files", "--debug", "-z"], end, METADATA)
  for (const entry of indexRows) {
    const prefix = entry.path + "\0"
    if (!debug.startsWith(prefix)) hold("unrecognized index flag framing")
    debug = debug.slice(prefix.length)
    const m = /^  ctime: [0-9]+:[0-9]+\n  mtime: [0-9]+:[0-9]+\n  dev: [0-9]+\tino: [0-9]+\n  uid: [0-9]+\tgid: [0-9]+\n  size: [0-9]+\tflags: ([a-f0-9]+)\n/u.exec(debug)
    if (!m || parseInt(m[1]!, 16) !== entry.stage * 4096) hold("intent-to-add or unsupported index flags")
    debug = debug.slice(m![0].length)
  }
  if (debug || await git(root, ["ls-files", "--resolve-undo", "-z"], end, METADATA)) hold("unrecognized index or resolve-undo metadata")
  const treeText = await git(root, ["ls-tree", "-r", "-z", "--full-tree", head], end, METADATA)
  const headTree = treeText.split("\0").filter(Boolean).map(row => {
    const m = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/su.exec(row)
    if (!m) return hold("non-regular HEAD tree")
    return { path: m[3]!, mode: m[1]! as "100644" | "100755", objectId: m[2]! }
  })
  if (headTree.length > maxEntries) hold("HEAD entry budget exceeded")
  checkPaths([...headTree, ...indexRows].map(e => e.path).concat(request.selectedUntracked))
  const indexPaths = new Set(indexRows.map(e => e.path))
  if (request.selectedUntracked.some(p => indexPaths.has(p)) || new Set(request.selectedUntracked).size !== request.selectedUntracked.length) hold("untracked selection overlaps index or duplicates")
  if (request.selectedUntracked.length && (await runGit(root, ["-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "-z", "--stdin"], end, METADATA, request.selectedUntracked.join("\0") + "\0", true)).length) hold("selected untracked path is ignored")
  const blobMap = new Map<string, { digest: string; bytes: number; base64: string }>(); let total = 0
  const addBlob = (bytes: Buffer) => {
    const digest = sha(bytes)
    if (!blobMap.has(digest)) {
      total += bytes.length
      if (total > maxBytes) hold("blob byte budget exceeded")
      blobMap.set(digest, { digest, bytes: bytes.length, base64: bytes.toString("base64") })
    }
    return digest
  }
  const index: z.infer<typeof indexEntry>[] = [], byOid = new Map<string, string>()
  for (const entry of indexRows) {
    assertPath(entry.path)
    let blobDigest = byOid.get(entry.objectId)
    if (!blobDigest) {
      const bytes = await runGit(root, ["cat-file", "blob", entry.objectId], end, maxBytes + 1)
      if (blobOid(bytes, request.expectedObjectFormat) !== entry.objectId) hold("source blob OID mismatch")
      blobDigest = addBlob(bytes); byOid.set(entry.objectId, blobDigest)
    }
    index.push({ ...entry, blobDigest })
  }
  const working: z.infer<typeof workingEntry>[] = []
  const workPaths = sorted([...indexPaths, ...request.selectedUntracked])
  if (workPaths.length > maxEntries) hold("working path entry budget exceeded")
  const missingParent = async (name: string) => {
    let folder = root
    for (const part of name.split("/").slice(0, -1)) {
      folder = join(folder, part)
      try { await safeDirectory(folder, end) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error }
    }
    return false
  }
  for (const name of workPaths) {
    deadline(end); assertPath(name)
    if (await missingParent(name)) { working.push({ path: name, kind: "ABSENT" }); continue }
    const file = join(root, name)
    let before: Awaited<ReturnType<typeof lstat>>
    try { before = await lstat(file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      working.push({ path: name, kind: "ABSENT" }); continue
    }
    if (!before.isFile() || before.isSymbolicLink()) hold("working symlink or special file")
    const bytes = await regularBytes(file, maxBytes, end), after = await lstat(file)
    if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) hold("working file changed during capture")
    working.push({ path: name, kind: "REGULAR", mode: before.mode & 0o100 ? "100755" : "100644", blobDigest: addBlob(bytes) })
  }
  const state = validateState({ schema: "usl-git-state/v1", profile: "RAW_REGULAR_GIT_STATE_V1", ownerNamespace: request.ownerNamespace,
    repositoryId: request.repositoryId, worktreeId: request.worktreeId, issuer: request.issuer, observedAt: request.observedAt, head, branch: attachment || null,
    objectFormat: format, indexObservation: { byteDigest: sha(rawIndex), version }, headTree, index, working, selectedUntracked: sorted(request.selectedUntracked),
    blobs: [...blobMap.values()].sort((a, b) => a.digest.localeCompare(b.digest)), scope: SCOPE }, maxBytes, maxEntries, end)
  return { state, fingerprint: contractDigest({ common, admin, local: sha(Buffer.from(local)), worktree: sha(Buffer.from(worktree)), state: stateDigest(state) }) }
}

/** Captures a bounded sidecar, not Git history, credentials or an executable workspace. */
export async function exportGitWorktreeState(input: unknown): Promise<GitWorktreeStateExport> {
  const request = exportSchema.parse(contractSnapshot(input, METADATA))
  const end = Date.now() + (request.maxDurationMs ?? 60_000)
  const root = await safeDirectory(request.sourceRoot, end), destination = await safeDirectory(request.destinationParent, end)
  if (within(root, destination) || within(destination, root)) hold("source and destination must be separate")
  const before = await observe(root, request, destination, end)
  const stateBytes = Buffer.from(JSON.stringify(before.state) + "\n"), capturedDigest = stateDigest(before.state)
  const receiptBytes = Buffer.from(JSON.stringify({ schema: "usl-git-state-receipt/v1", stateDigest: capturedDigest, stateByteDigest: sha(stateBytes), bytes: stateBytes.length, execution: "LOCAL_CAPTURE_ONLY" }) + "\n")
  const stage = join(destination, `.usl-git-state-stage-${randomUUID()}`), artifactPath = join(destination, `usl-git-state-${randomUUID()}`)
  await mkdir(stage, { mode: 0o700 })
  try {
    await writeFile(join(stage, "state.json"), stateBytes, { flag: "wx", mode: 0o600 })
    await writeFile(join(stage, "receipt.json"), receiptBytes, { flag: "wx", mode: 0o600 })
    const after = await observe(root, request, destination, end)
    if (before.fingerprint !== after.fingerprint) hold("source changed during non-atomic capture")
    for (const [name, bytes] of [["state.json", stateBytes], ["receipt.json", receiptBytes]] as const)
      if (!bytes.equals(await regularBytes(join(stage, name), bytes.length, end))) hold("staged artifact changed")
    await assertEntries(stage, end)
    await safeDirectory(stage, end); await safeDirectory(destination, end); await absent(artifactPath, "existing state artifact")
    deadline(end); await rename(stage, artifactPath)
    return freezeContract({ artifactPath, statePath: join(artifactPath, "state.json"), receiptDigest: sha(receiptBytes), stateDigest: capturedDigest, state: before.state })
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error }
}
async function assertEntries(root: string, end: number) {
  const entries: string[] = []
  for await (const e of await opendir(root)) { deadline(end); if (entries.length === 2) hold("unexpected artifact entry"); entries.push(e.name) }
  if (!sameStrings(entries, ["receipt.json", "state.json"])) hold("unexpected artifact entry")
}
/** Independent receipt pin is required; success verifies selected state, never restoration/access. */
export async function verifyGitWorktreeState(input: unknown): Promise<GitWorktreeState> {
  const request = verifySchema.parse(contractSnapshot(input, METADATA)), end = Date.now() + (request.maxDurationMs ?? 60_000)
  const root = await safeDirectory(request.artifactPath, end)
  await assertEntries(root, end)
  const receiptBytes = await regularBytes(join(root, "receipt.json"), METADATA, end)
  if (sha(receiptBytes) !== request.expectedReceiptDigest) hold("independent receipt digest mismatch")
  const decode = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  const receipt = receiptSchema.parse(decode(receiptBytes))
  const maxBytes = request.maxBytes ?? DEFAULT_BYTES
  const stateBytes = await regularBytes(join(root, "state.json"), maxBytes * 2 + METADATA, end)
  if (sha(stateBytes) !== receipt.stateByteDigest || stateBytes.length !== receipt.bytes) hold("state byte pin mismatch")
  const state = validateState(decode(stateBytes), maxBytes, request.maxEntries ?? MAX_ENTRIES, end)
  if (stateDigest(state) !== receipt.stateDigest || state.ownerNamespace !== request.allowedOwnerNamespace || state.repositoryId !== request.expectedRepositoryId ||
      state.worktreeId !== request.expectedWorktreeId || state.head !== request.expectedHead) hold("state digest or owner/repository/worktree/HEAD pin mismatch")
  return state
}
