/** Bounded clean Git export and isolated multi-worktree restore. No code execution or authority grant. */
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, opendir, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path"
import { z } from "zod"
import { contractDigest, contractIri, contractSnapshot, freezeContract } from "../contract-core.js"

export const CLEAN_GIT_TRANSFER_SCHEMA = "usl-clean-git-export/v1" as const
export const CLEAN_GIT_IMPORT_SCHEMA = "usl-clean-git-import/v1" as const
const MAX_BYTES = 512 * 1024 * 1024, DEFAULT_BYTES = 64 * 1024 * 1024
const MAX_OBJECTS = 100_000, MAX_DURATION = 300_000, MAX_METADATA = 16 * 1024 * 1024
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u
const validRef = (value: string) => REF.test(value) && !value.includes("..") && value.split("/").every(p => p && !p.startsWith(".") && !p.endsWith(".") && !p.endsWith(".lock"))
const refSchema = z.string().max(512).refine(validRef, "unsupported ref name")
const refsSchema = z.record(refSchema, z.string().regex(OID)).refine(x => Object.keys(x).length > 0 && Object.keys(x).length <= 256, "expected refs count outside bounds")
const label = z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/u)
const identityFields = { ownerNamespace: contractIri.max(512), repositoryId: label, worktreeId: label, issuer: contractIri.max(512), observedAt: z.iso.datetime({ offset: false }) }
const requestSchema = z.object({
  schema: z.literal(CLEAN_GIT_TRANSFER_SCHEMA), sourceRoot: z.string().min(1).max(4096), destinationParent: z.string().min(1).max(4096),
  ...identityFields, expectedHead: z.string().regex(OID), expectedRefs: refsSchema, expectedObjectFormat: z.enum(["sha1", "sha256"]),
  maxBundleBytes: z.number().int().min(1).max(MAX_BYTES).optional(), maxUncompressedBytes: z.number().int().min(1).max(MAX_BYTES).optional(),
  maxObjects: z.number().int().min(1).max(MAX_OBJECTS).optional(), maxDurationMs: z.number().int().min(1).max(MAX_DURATION).optional(),
}).strict()
const LIMITATIONS = ["IGNORED_FILES_NOT_OBSERVED", "NO_CONFIG_HOOK_CREDENTIAL_COPY", "NO_RESTORE_OR_REBIND", "NON_ATOMIC_SOURCE_OBSERVATION"] as const
const limitsSchema = z.object({
  maxBundleBytes: z.number().int().min(1).max(MAX_BYTES), maxUncompressedBytes: z.number().int().min(1).max(MAX_BYTES),
  maxObjects: z.number().int().min(1).max(MAX_OBJECTS), maxDurationMs: z.number().int().min(1).max(MAX_DURATION),
  maxTrackedFiles: z.literal(MAX_OBJECTS), maxMetadataBytes: z.literal(MAX_METADATA),
}).strict()
const manifestSchema = z.object({
  schema: z.literal("usl-clean-git-manifest/v1"), profile: z.literal("CLEAN_GIT_WORKTREE_V1"), ...identityFields,
  objectFormat: z.enum(["sha1", "sha256"]), expectedHead: z.string().regex(OID), expectedRefs: refsSchema,
  observedHead: z.string().regex(OID), observedRefs: refsSchema,
  producer: z.object({ schema: z.literal(CLEAN_GIT_TRANSFER_SCHEMA), gitVersion: z.string().max(256).regex(/^git version [^\r\n\u0000]+$/u), nodeVersion: z.string().max(128).regex(/^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/u) }).strict(),
  limits: limitsSchema,
  bundle: z.object({ path: z.literal("repo.bundle"), version: z.literal(3), prerequisites: z.array(z.string().regex(OID)).length(0), byteDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    bytes: z.number().int().min(1).max(MAX_BYTES), objectCount: z.number().int().min(1).max(MAX_OBJECTS),
    reachableUncompressedBytes: z.number().int().min(1).max(MAX_BYTES), heads: z.record(z.union([z.literal("HEAD"), refSchema]), z.string().regex(OID)),
  }).strict(),
  limitations: z.tuple([z.literal(LIMITATIONS[0]), z.literal(LIMITATIONS[1]), z.literal(LIMITATIONS[2]), z.literal(LIMITATIONS[3])]),
}).strict()
export type CleanGitTransferManifest = Readonly<z.infer<typeof manifestSchema>>
export interface CleanGitTransferResult {
  readonly bundlePath: string; readonly gitBundlePath: string; readonly manifestPath: string; readonly receiptPath: string
  readonly transferPath: string; readonly manifestDigest: string; readonly receiptDigest: string; readonly bundleByteDigest: string
  readonly bytes: number; readonly objectCount: number; readonly manifest: CleanGitTransferManifest
}
type Request = z.infer<typeof requestSchema>
const GIT = process.platform === "win32" ? "git.exe" : "/usr/bin/git"
const nullFile = process.platform === "win32" ? "NUL" : "/dev/null"
const env = {
  PATH: process.platform === "win32" ? process.env.PATH : "/usr/bin:/bin",
  ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: nullFile, GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1",
  GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "", GIT_LFS_SKIP_SMUDGE: "1", LC_ALL: "C",
}
const config = ["-c", `core.hooksPath=${nullFile}`, "-c", "core.fsmonitor=false", "-c", `core.attributesfile=${nullFile}`, "-c", "diff.external=",
  "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "pack.threads=1", "-c", "pack.windowMemory=16m", "-c", "pack.deltaCacheSize=16m"]
const deadline = (end: number) => { if (Date.now() >= end) throw new Error("clean Git export duration budget exceeded") }
const sha = (data: Uint8Array) => "sha256:" + createHash("sha256").update(data).digest("hex")
const stable = (record: Readonly<Record<string, string>>) => Object.fromEntries(Object.keys(record).sort().map(k => [k, record[k]!]))
const equal = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) => JSON.stringify(stable(a)) === JSON.stringify(stable(b))
const within = (root: string, path: string) => { const p = relative(root, path); return !p || (p !== ".." && !p.startsWith(`..${sep}`) && !isAbsolute(p)) }

/** Capture at most maxOutput bytes. Bundle creation writes stdout, never an unbounded disk file. */
const runGit = (cwd: string, args: readonly string[], end: number, maxOutput = MAX_METADATA, input?: string, allowUnset = false): Promise<Buffer> => {
  deadline(end)
  return new Promise((done, reject) => {
    const processGroup = process.platform !== "win32"
    const child = spawn(GIT, ["-C", cwd, ...config, ...args], { shell: false, env, detached: processGroup, stdio: ["pipe", "pipe", "pipe"] })
    const chunks: Buffer[] = []
    let total = 0, errors = 0, failure: Error | undefined
    const stop = (message: string) => {
      failure ??= new Error(message)
      // Git bundle spawns pack-objects; kill its group too so inherited pipes cannot outlive the budget.
      if (processGroup && child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); return } catch { /* already exited or unavailable */ }
      }
      child.kill("SIGKILL")
    }
    const timer = setTimeout(() => stop("clean Git export duration budget exceeded"), Math.max(1, end - Date.now()))
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return
      total += chunk.length
      if (total > maxOutput) stop("clean Git export object/output byte budget exceeded")
      else chunks.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.length; if (errors > 64 * 1024) stop("clean Git diagnostic byte budget exceeded") })
    child.on("error", () => { failure ??= new Error("clean Git export requires the host Git executable") })
    child.stdin.on("error", () => stop("clean Git input pipe failed"))
    child.on("close", code => {
      clearTimeout(timer)
      if (failure) return reject(failure)
      if (Date.now() >= end) return reject(new Error("clean Git export duration budget exceeded"))
      if (allowUnset && code === 1 && total === 0 && errors === 0) return done(Buffer.alloc(0))
      if (code !== 0) return reject(new Error("clean Git command failed; source facts unavailable"))
      done(Buffer.concat(chunks, total))
    })
    child.stdin.end(input)
  })
}
const git = async (cwd: string, args: readonly string[], end: number, maxOutput = MAX_METADATA, allowUnset = false) =>
  new TextDecoder("utf-8", { fatal: true }).decode(await runGit(cwd, args, end, maxOutput, undefined, allowUnset))
const safeDirectory = async (value: string, end: number) => {
  if (!isAbsolute(value)) throw new Error("source and destination roots must be absolute")
  const path = resolve(value), base = parse(path).root
  let current = base
  for (const part of relative(base, path).split(sep).filter(Boolean)) {
    deadline(end); current = join(current, part)
    const item = await lstat(current)
    if (!item.isDirectory() || item.isSymbolicLink()) throw new Error("directory path contains a symlink or special component")
  }
  return path
}
const regularBytes = async (path: string, bound: number, end: number): Promise<Buffer> => {
  deadline(end)
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size > bound) throw new Error("file type or byte budget mismatch")
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await file.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error("file changed before read")
    const bytes = Buffer.alloc(before.size + 1)
    let at = 0
    while (at < bytes.length) { deadline(end); const r = await file.read(bytes, at, bytes.length - at, null); if (!r.bytesRead) break; at += r.bytesRead }
    const after = await file.stat(), named = await lstat(path)
    if (at !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || named.dev !== before.dev || named.ino !== before.ino) throw new Error("file changed during read")
    return bytes.subarray(0, at)
  } finally { await file.close() }
}
const absent = async (path: string, reason: string) => {
  try { await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error }
  throw new Error(`clean Git profile rejects ${reason}`)
}
const checkObjectStore = async (root: string, end: number) => {
  const stack = [root]; let count = 0
  while (stack.length) {
    deadline(end)
    const directory = stack.pop()!
    for await (const item of await opendir(directory)) {
      deadline(end)
      if (++count > MAX_OBJECTS + 4096) throw new Error("object-store metadata entry budget exceeded")
      if (item.isSymbolicLink() || (!item.isFile() && !item.isDirectory())) throw new Error("object store symlink/special file is unsupported")
      if (item.name.endsWith(".promisor")) throw new Error("clean Git profile rejects promisor pack markers")
      if (item.isDirectory()) stack.push(join(directory, item.name))
    }
  }
}
const checkPins = (head: string, refs: Readonly<Record<string, string>>, format: string) => {
  const length = format === "sha1" ? 40 : 64
  if (head.length !== length || Object.values(refs).some(oid => oid.length !== length)) throw new Error("object format and OID width differ")
}

/** Pure structural/semantic parsing, never a payload or authorization check. */
export const parseCleanGitTransferManifest = (input: unknown): CleanGitTransferManifest => {
  const value = manifestSchema.parse(contractSnapshot(input, 1024 * 1024))
  checkPins(value.expectedHead, value.expectedRefs, value.objectFormat)
  if (value.observedHead !== value.expectedHead || !equal(value.observedRefs, value.expectedRefs) ||
      !equal(value.bundle.heads, { ...value.expectedRefs, HEAD: value.expectedHead })) throw new Error("observed manifest refs, HEAD or bundle heads differ from owner pins")
  if (value.bundle.bytes > value.limits.maxBundleBytes || value.bundle.objectCount > value.limits.maxObjects ||
      value.bundle.reachableUncompressedBytes > value.limits.maxUncompressedBytes) throw new Error("manifest payload exceeds declared limits")
  return freezeContract(value)
}

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u)
const importFileSchema = z.object({ nativeId: label, revisionId: z.string().regex(OID), representationId: label, worktreeId: label,
  path: z.string().min(1).max(1024), expectedByteDigest: digestSchema, expectedByteLength: z.number().int().min(0).max(MAX_BYTES) }).strict()
const importWorktreeSchema = z.object({ worktreeId: label, path: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u), head: z.string().regex(OID), branch: refSchema.optional() }).strict()
const importRequestSchema = z.object({
  schema: z.literal(CLEAN_GIT_IMPORT_SCHEMA), bundlePath: z.string().min(1).max(4096), destinationParent: z.string().min(1).max(4096), destinationName: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
  expectedReceiptDigest: digestSchema, allowedOwnerNamespace: contractIri.max(512), expectedRepositoryId: label,
  worktrees: z.array(importWorktreeSchema).min(1).max(16), files: z.array(importFileSchema).min(1).max(1024),
  freshnessMode: z.enum(["HISTORICAL_SNAPSHOT", "LOCAL_BRANCH"]).default("HISTORICAL_SNAPSHOT"),
  maxBundleBytes: z.number().int().min(1).max(MAX_BYTES).optional(), maxUncompressedBytes: z.number().int().min(1).max(MAX_BYTES).optional(), maxCheckoutBytes: z.number().int().min(1).max(MAX_BYTES).optional(), maxObjects: z.number().int().min(1).max(MAX_OBJECTS).optional(), maxDurationMs: z.number().int().min(1).max(MAX_DURATION).optional(),
}).strict()
const importReceiptSchema = z.object({ schema: z.literal("usl-clean-git-receipt/v1"), manifestDigest: digestSchema,
  manifestByteDigest: digestSchema, bundleByteDigest: digestSchema, bytes: z.number().int().min(1).max(MAX_BYTES),
  objectCount: z.number().int().min(1).max(MAX_OBJECTS), execution: z.literal("LOCAL_EXPORT_ONLY") }).strict()
export interface RestoredCleanGitFile {
  readonly nativeId: string; readonly revisionId: string; readonly representationId: string; readonly worktreeId: string
  readonly path: string; readonly restorePath: string; readonly byteDigest: string; readonly bytes: number; readonly objectId: string; readonly mode: string
}
export interface CleanGitRestoreResult {
  readonly destinationPath: string; readonly repositoryPath: string; readonly manifest: CleanGitTransferManifest
  readonly manifestDigest: string; readonly bundleDigest: string; readonly receiptDigest: string
  readonly worktrees: readonly Readonly<z.infer<typeof importWorktreeSchema>>[]; readonly files: readonly RestoredCleanGitFile[]
  readonly freshnessMode: "HISTORICAL_SNAPSHOT" | "LOCAL_BRANCH"; readonly authority: "NOT_GRANTED"; readonly execution: "NOT_REQUESTED"
}
const restoreHandles = new WeakMap<object, { result: CleanGitRestoreResult; root: Awaited<ReturnType<typeof lstat>>; fingerprint: string; maxBytes: number; durationMs: number }>()
const safeRestorePath = (value: string) => !isAbsolute(value) && !/[\\:\u0000-\u001f\u007f]/u.test(value) && value.split("/").every(x =>
  !!x && x !== "." && x !== ".." && !/[. ]$/u.test(x) && x.toLowerCase() !== ".git" && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(x))
const decodeJson = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
const sameInode = (a: Awaited<ReturnType<typeof lstat>>, b: Awaited<ReturnType<typeof lstat>>) => a.dev === b.dev && a.ino === b.ino && a.isDirectory() && b.isDirectory() && !b.isSymbolicLink()

/** A content/mode pin of the entire isolated restore, including Git metadata.
 * Recheck performs no Git command until mutable config and gitfiles are checked.
 * Even ignored additions or benign Git metadata writes invalidate this strict handle.
 */
async function restoreFingerprint(root: string, maxBytes: number, end: number) {
  await safeDirectory(root, end)
  const stack = [root], rows: string[] = [JSON.stringify([".", "directory", (await lstat(root)).mode & 0o777])]; let count = 0, total = 0, names = 0
  while (stack.length) {
    const directory = stack.pop()!
    for await (const entry of await opendir(directory)) {
      deadline(end)
      if (++count > MAX_OBJECTS * 3 + 4096) throw new Error("restore entry budget exceeded")
      const file = join(directory, entry.name), name = relative(root, file)
      names += Buffer.byteLength(name); if (names > MAX_METADATA) throw new Error("restore path metadata budget exceeded")
      const info = await lstat(file)
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error("restore contains a symlink or special file")
      if (info.isDirectory()) { rows.push(JSON.stringify([name, "directory", info.mode & 0o777])); stack.push(file); continue }
      total += info.size; if (!Number.isSafeInteger(total) || total > maxBytes) throw new Error("restore byte budget exceeded")
      const bytes = await regularBytes(file, Math.min(MAX_BYTES, maxBytes), end)
      rows.push(JSON.stringify([name, info.mode & 0o777, bytes.length, sha(bytes)]))
    }
  }
  const fingerprint = sha(Buffer.from(rows.sort().join("\n")))
  deadline(end)
  return fingerprint
}
export const recheckCleanGitRestore = async (result: unknown): Promise<CleanGitRestoreResult> => {
  const handle = result && typeof result === "object" ? restoreHandles.get(result) : undefined
  if (!handle) throw new Error("unverified clean Git restore handle; serialized handles are not accepted")
  const end = Date.now() + handle.durationMs
  const root = handle.result.destinationPath
  if (!sameInode(handle.root, await lstat(root))) throw new Error("restore root identity changed")
  if (await restoreFingerprint(root, handle.maxBytes, end) !== handle.fingerprint) throw new Error("restore Git/config/index/HEAD or file state changed; stale verification handle")
  if (!sameInode(handle.root, await lstat(root))) throw new Error("restore root changed during recheck")
  return handle.result
}

type TreeFile = { path: string; mode: string; objectId: string; bytes: number }
async function checkoutTree(repository: string, head: string, end: number): Promise<TreeFile[]> {
  const text = await git(repository, ["ls-tree", "-r", "-l", "-z", "--full-tree", head], end)
  const files: TreeFile[] = [], paths = new Map<string, string>()
  for (const row of text.split("\0").filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]+) +([0-9]+)\t(.+)$/su.exec(row)
    if (!match || !safeRestorePath(match[4]!)) throw new Error("unsupported or unsafe checkout tree path/mode (submodule and symlink require another profile)")
    const path = match[4]!
    if (path.split("/").some(x => x.toLowerCase() === ".gitattributes")) throw new Error("checkout attributes and transformations are unsupported in the raw clean restore profile")
    const parts = path.split("/")
    for (let i = 1; i <= parts.length; i++) {
      const name = parts.slice(0, i).join("/"), folded = name.normalize("NFC").toLowerCase()
      if (paths.has(folded) && paths.get(folded) !== name) throw new Error("case/normalization collision in checkout tree")
      paths.set(folded, name)
    }
    files.push({ path, mode: match[1]!, objectId: match[2]!, bytes: Number(match[3]) })
    if (files.length > MAX_OBJECTS) throw new Error("checkout file count budget exceeded")
  }
  return files
}

/** Restore only an independently pinned CP01 bundle into a wholly new local root. */
export const importCleanGitTransfer = async (input: unknown): Promise<CleanGitRestoreResult> => {
  const request = importRequestSchema.parse(contractSnapshot(input, 2 * 1024 * 1024))
  const durationMs = request.maxDurationMs ?? 60_000, end = Date.now() + durationMs
  const maxBundle = request.maxBundleBytes ?? DEFAULT_BYTES, maxObjects = request.maxObjects ?? MAX_OBJECTS
  const maxUncompressed = request.maxUncompressedBytes ?? DEFAULT_BYTES, maxCheckout = request.maxCheckoutBytes ?? DEFAULT_BYTES
  if (!safeRestorePath(request.destinationName) || request.worktrees.some(x => !safeRestorePath(x.path)) || request.files.some(x => !safeRestorePath(x.path))) throw new Error("unsafe restore path")
  const unique = (values: string[], label: string) => { if (new Set(values).size !== values.length) throw new Error(`duplicate ${label}`) }
  unique(request.worktrees.map(x => x.worktreeId), "worktree identity")
  unique(request.worktrees.map(x => x.path.toLowerCase()), "worktree path")
  unique(request.worktrees.flatMap(x => x.branch ? [x.branch] : []), "checked-out branch")
  unique(request.files.map(x => x.representationId), "representation identity")
  unique(request.files.map(x => JSON.stringify([x.worktreeId, x.path.normalize("NFC").toLowerCase()])), "selected file path")
  const bundleRoot = await safeDirectory(request.bundlePath, end), parent = await safeDirectory(request.destinationParent, end)
  const destinationPath = join(parent, request.destinationName)
  if (within(bundleRoot, destinationPath) || within(destinationPath, bundleRoot)) throw new Error("bundle and restore roots must be separate")
  const bundleEntries: string[] = []
  for await (const entry of await opendir(bundleRoot)) {
    deadline(end)
    if (bundleEntries.length === 3) throw new Error("unexpected bundle entry")
    bundleEntries.push(entry.name)
  }
  if (bundleEntries.sort().join("\n") !== "manifest.json\nreceipt.json\nrepo.bundle") throw new Error("unexpected bundle entry")
  const receiptBytes = await regularBytes(join(bundleRoot, "receipt.json"), 1024 * 1024, end)
  if (sha(receiptBytes) !== request.expectedReceiptDigest) throw new Error("independent receipt digest mismatch")
  const receipt = importReceiptSchema.parse(decodeJson(receiptBytes))
  const manifestBytes = await regularBytes(join(bundleRoot, "manifest.json"), 1024 * 1024, end)
  if (sha(manifestBytes) !== receipt.manifestByteDigest) throw new Error("raw manifest digest mismatch")
  const manifest = parseCleanGitTransferManifest(decodeJson(manifestBytes))
  if (contractDigest(manifest) !== receipt.manifestDigest || manifest.ownerNamespace !== request.allowedOwnerNamespace || manifest.repositoryId !== request.expectedRepositoryId) throw new Error("manifest owner/repository/digest mismatch")
  if (receipt.bytes !== manifest.bundle.bytes || receipt.objectCount !== manifest.bundle.objectCount || receipt.bundleByteDigest !== manifest.bundle.byteDigest) throw new Error("receipt and manifest payload facts differ")
  if (manifest.bundle.objectCount > maxObjects || manifest.bundle.reachableUncompressedBytes > maxUncompressed) throw new Error("declared Git closure exceeds import budget")
  const bundleBytes = await regularBytes(join(bundleRoot, "repo.bundle"), maxBundle, end)
  if (sha(bundleBytes) !== receipt.bundleByteDigest || bundleBytes.length !== receipt.bytes) throw new Error("bundle byte pin mismatch")
  // Inspect the PACK object count before invoking index-pack/unbundle on captured bytes.
  const headerEnd = bundleBytes.indexOf("\n\n") + 2
  if (headerEnd < 2 || headerEnd > MAX_METADATA || headerEnd + 12 > bundleBytes.length ||
      bundleBytes.subarray(0, 16).toString("ascii") !== "# v3 git bundle\n" || bundleBytes.subarray(headerEnd, headerEnd + 4).toString("ascii") !== "PACK") throw new Error("invalid bundle/PACK header")
  const packCount = bundleBytes.readUInt32BE(headerEnd + 8)
  if (packCount !== manifest.bundle.objectCount || packCount > maxObjects) throw new Error("PACK object count differs from pin or budget")
  const pinnedHeads = new Set([manifest.expectedHead, ...Object.values(manifest.expectedRefs)])
  for (const wt of request.worktrees) {
    if (!pinnedHeads.has(wt.head) || (wt.branch !== undefined && manifest.expectedRefs[wt.branch] !== wt.head)) throw new Error("worktree HEAD/branch differs from independently pinned bundle roots")
  }
  const byId = new Map(request.worktrees.map(x => [x.worktreeId, x]))
  const nativeRevisions = new Map<string, string>()
  for (const file of request.files) {
    const wt = byId.get(file.worktreeId)
    if (!wt || wt.head !== file.revisionId) throw new Error("native revision/worktree selection mismatch")
    const key = JSON.stringify([file.nativeId, file.revisionId]), descriptor = JSON.stringify([file.path, file.expectedByteDigest, file.expectedByteLength])
    if (nativeRevisions.has(key) && nativeRevisions.get(key) !== descriptor) throw new Error("contradictory native revision descriptor")
    nativeRevisions.set(key, descriptor)
  }
  // Fixed reservation serializes cooperating imports; mkdir reserves the actual name without clobbering an existing path.
  const lock = join(parent, `.usl-clean-git-${sha(Buffer.from(request.destinationName.toLowerCase())).slice(7)}.lock`)
  await mkdir(lock, { mode: 0o700 })
  const lockStat = await lstat(lock), stage = join(lock, "stage")
  let reserved: Awaited<ReturnType<typeof lstat>> | undefined, published: Awaited<ReturnType<typeof lstat>> | undefined
  try {
    await mkdir(destinationPath, { mode: 0o700 }); reserved = await lstat(destinationPath)
    await mkdir(stage, { mode: 0o700 })
    const repository = join(stage, "repository.git"), localBundle = join(stage, "input.bundle")
    await writeFile(localBundle, bundleBytes, { flag: "wx", mode: 0o600 })
    await git(stage, ["init", "--bare", "--template=", `--object-format=${manifest.objectFormat}`, repository], end)
    await git(repository, ["bundle", "verify", localBundle], end)
    const heads: Record<string, string> = Object.create(null)
    for (const row of (await git(repository, ["bundle", "list-heads", localBundle], end)).trim().split("\n")) {
      const match = /^([a-f0-9]+) (HEAD|refs\/heads\/.+)$/u.exec(row)
      if (!match || Object.hasOwn(heads, match[2]!)) throw new Error("invalid bundle heads")
      heads[match[2]!] = match[1]!
    }
    if (!equal(heads, manifest.bundle.heads)) throw new Error("bundle heads differ from manifest pins")
    await git(repository, ["bundle", "unbundle", localBundle], end)
    const objects = await closure(repository, manifest, end, maxObjects, maxUncompressed)
    if (objects.ids.length !== packCount || objects.total !== manifest.bundle.reachableUncompressedBytes) throw new Error("actual Git closure differs from pinned manifest")
    await git(repository, ["fsck", "--strict", "--no-reflogs", "--no-progress", ...objects.tips], end)
    await runGit(repository, ["update-ref", "--stdin"], end, MAX_METADATA, Object.entries(manifest.expectedRefs).map(([ref, oid]) => `create ${ref} ${oid}\n`).join(""))
    await git(repository, ["update-ref", "--no-deref", "HEAD", manifest.expectedHead], end)
    await rm(localBundle)
    const trees = new Map<string, TreeFile[]>(); let checkoutBytes = 0, fileCount = 0
    for (const wt of request.worktrees) {
      const files = await checkoutTree(repository, wt.head, end)
      for (const file of files) { checkoutBytes += file.bytes; fileCount++ }
      if (!Number.isSafeInteger(checkoutBytes) || checkoutBytes > maxCheckout || fileCount > MAX_OBJECTS) throw new Error("checkout file/byte budget exceeded")
      trees.set(wt.worktreeId, files)
    }
    const restored: RestoredCleanGitFile[] = []
    for (const selection of request.files) {
      const file = trees.get(selection.worktreeId)!.find(f => f.path === selection.path)
      if (!file || file.bytes !== selection.expectedByteLength) throw new Error("selected native revision file is absent or size pin differs")
      const bytes = await runGit(repository, ["cat-file", "blob", file.objectId], end, file.bytes + 1)
      if (bytes.length !== file.bytes || sha(bytes) !== selection.expectedByteDigest) throw new Error("selected file byte pin mismatch")
      restored.push({ nativeId: selection.nativeId, revisionId: selection.revisionId, representationId: selection.representationId, worktreeId: selection.worktreeId,
        path: selection.path, restorePath: `worktrees/${byId.get(selection.worktreeId)!.path}/${selection.path}`, byteDigest: sha(bytes), bytes: bytes.length, objectId: file.objectId, mode: file.mode })
    }
    const pointerUpdates: { file: string; content: string }[] = []
    await mkdir(join(stage, "worktrees"), { mode: 0o700 })
    for (const wt of request.worktrees) {
      const target = join(stage, "worktrees", wt.path)
      await git(repository, ["worktree", "add", "--detach", "--no-checkout", target, wt.head], end)
      if (wt.branch) await git(target, ["symbolic-ref", "HEAD", wt.branch], end)
      await git(target, ["read-tree", wt.head], end)
      for (const file of trees.get(wt.worktreeId)!) {
        deadline(end)
        const bytes = await runGit(repository, ["cat-file", "blob", file.objectId], end, file.bytes + 1)
        if (bytes.length !== file.bytes) throw new Error("Git blob size changed")
        const path = join(target, file.path)
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        await writeFile(path, bytes, { flag: "wx", mode: file.mode === "100755" ? 0o700 : 0o600 })
        if (!bytes.equals(await regularBytes(path, file.bytes, end))) throw new Error("materialized file changed")
      }
      await git(target, ["update-index", "--refresh"], end)
      if ((await git(target, ["rev-parse", "HEAD"], end)).trim() !== wt.head || await git(target, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], end)) throw new Error("materialized worktree differs from pinned clean commit")
      const admin = (await git(target, ["rev-parse", "--absolute-git-dir"], end)).trim()
      if (!within(join(repository, "worktrees"), admin) || admin === join(repository, "worktrees")) throw new Error("worktree administration path escaped restore")
      await safeDirectory(admin, end)
      if ((await regularBytes(join(admin, "commondir"), 4096, end)).toString("utf8").trim() !== "../..") throw new Error("unexpected common directory link")
      pointerUpdates.push({ file: join(target, ".git"), content: `gitdir: ${join(destinationPath, relative(stage, admin))}\n` },
        { file: join(admin, "gitdir"), content: join(destinationPath, "worktrees", wt.path, ".git") + "\n" })
    }
    // Replace only fresh generated pointers with their final root; never copy original gitfiles or require manual repair.
    for (const update of pointerUpdates) {
      await regularBytes(update.file, 4096, end)
      await writeFile(update.file, update.content, { flag: "w", mode: 0o600 })
      if (!(await regularBytes(update.file, 4096, end)).equals(Buffer.from(update.content))) throw new Error("generated Git pointer changed")
    }
    await writeFile(join(stage, "restore.json"), JSON.stringify({ schema: "usl-clean-git-restored/v1", manifestDigest: receipt.manifestDigest, sourceReceiptDigest: request.expectedReceiptDigest,
      ownerNamespace: manifest.ownerNamespace, repositoryId: manifest.repositoryId, worktrees: request.worktrees, files: restored, authority: "NOT_GRANTED", execution: "NOT_REQUESTED" }, null, 2) + "\n", { flag: "wx", mode: 0o600 })
    const maxSnapshotBytes = maxBundle + maxCheckout + 4 * MAX_METADATA
    const fingerprint = await restoreFingerprint(stage, maxSnapshotBytes, end)
    await safeDirectory(parent, end)
    if (!sameInode(reserved, await lstat(destinationPath)) || (await readdir(destinationPath)).length) throw new Error("destination reservation changed")
    const stageStat = await lstat(stage)
    deadline(end); await rename(stage, destinationPath); published = stageStat
    for (const wt of request.worktrees) {
      const target = join(destinationPath, "worktrees", wt.path)
      if ((await git(target, ["rev-parse", "--path-format=absolute", "--git-common-dir"], end)).trim() !== join(destinationPath, "repository.git") ||
          (await git(target, ["rev-parse", "HEAD"], end)).trim() !== wt.head ||
          (await git(target, ["symbolic-ref", "-q", "HEAD"], end, MAX_METADATA, true)).trim() !== (wt.branch ?? "")) throw new Error("published Git topology mismatch")
      const admin = (await git(target, ["rev-parse", "--absolute-git-dir"], end)).trim()
      if (!within(join(destinationPath, "repository.git", "worktrees"), admin) ||
          (await regularBytes(join(admin, "gitdir"), 4096, end)).toString("utf8").trim() !== join(target, ".git")) throw new Error("published backlink mismatch")
    }
    if (await restoreFingerprint(destinationPath, maxSnapshotBytes, end) !== fingerprint) throw new Error("published restore changed during verification")
    const result: CleanGitRestoreResult = freezeContract({ destinationPath, repositoryPath: join(destinationPath, "repository.git"), manifest, manifestDigest: receipt.manifestDigest,
      bundleDigest: sha(bundleBytes), receiptDigest: sha(receiptBytes), worktrees: request.worktrees.map(x => ({ ...x, path: `worktrees/${x.path}` })), files: restored,
      freshnessMode: request.freshnessMode, authority: "NOT_GRANTED", execution: "NOT_REQUESTED" })
    restoreHandles.set(result, { result, root: published, fingerprint, maxBytes: maxSnapshotBytes, durationMs })
    return result
  } catch (error) {
    const owned = published ?? reserved
    if (owned) {
      try {
        if (sameInode(owned, await lstat(destinationPath))) {
          if (published) await rm(destinationPath, { recursive: true })
          else await rmdir(destinationPath) // refuses a reservation populated by another writer
        }
      } catch (cleanupError) { if (!['ENOENT', 'ENOTEMPTY'].includes((cleanupError as NodeJS.ErrnoException).code ?? '')) throw cleanupError }
    }
    throw error
  } finally {
    if (sameInode(lockStat, await lstat(lock))) await rm(lock, { recursive: true, force: true })
  }
}

const observe = async (source: string, destination: string, request: Request, end: number) => {
  if ((await git(source, ["rev-parse", "--is-inside-work-tree"], end)).trim() !== "true" ||
      resolve((await git(source, ["rev-parse", "--show-toplevel"], end)).trim()) !== source) throw new Error("sourceRoot must be the selected Git worktree root")
  const common = await safeDirectory((await git(source, ["rev-parse", "--path-format=absolute", "--git-common-dir"], end)).trim(), end)
  const privateDir = await safeDirectory((await git(source, ["rev-parse", "--absolute-git-dir"], end)).trim(), end)
  if (within(common, destination) || within(privateDir, destination)) throw new Error("destination is inside Git administration directory")
  const settings = await git(source, ["config", "--local", "--no-includes", "--null", "--list"], end)
  if (/(?:^|\0)(?:include\.path|includeif\.[^\n]*\.path)\n/iu.test(settings)) throw new Error("local config includes are unsupported")
  const unsupported = await git(source, ["config", "--get-regexp", "^(remote\\..*\\.(promisor|partialclonefilter)|extensions\\.partialclone|filter\\..*\\.(clean|smudge|process))$"], end, MAX_METADATA, true)
  if (unsupported) throw new Error("clean Git profile rejects promisor or filter drivers")
  const sparse = (await git(source, ["config", "--bool", "core.sparseCheckout"], end, MAX_METADATA, true)).trim()
  if (sparse && sparse !== "false") throw new Error("clean Git profile rejects sparse checkout")
  if ((await git(source, ["rev-parse", "--is-shallow-repository"], end)).trim() !== "false") throw new Error("clean Git profile rejects shallow repositories")
  for (const path of [join(common, "info", "grafts"), join(common, "objects", "info", "alternates"), join(common, "objects", "info", "http-alternates")]) await absent(path, "grafts or alternates")
  const objects = await safeDirectory(join(common, "objects"), end)
  await checkObjectStore(objects, end)
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_START"]) await absent(join(privateDir, name), "in-progress operation state")
  if ((await git(source, ["for-each-ref", "--format=%(refname)", "refs/replace"], end)).trim()) throw new Error("clean Git profile rejects replace refs")
  const flags = (await git(source, ["ls-files", "-v", "-z"], end)).split("\0").filter(Boolean)
  if (flags.some(row => row[0] !== "H")) throw new Error("clean Git profile rejects skip-worktree or assume-unchanged index flags")
  const index = await git(source, ["ls-files", "--stage", "-z"], end)
  const rows = index.split("\0").filter(Boolean)
  if (rows.length > MAX_OBJECTS) throw new Error("tracked entry budget exceeded")
  for (const row of rows) {
    const match = /^(100644|100755) [a-f0-9]+ 0\t(.+)$/su.exec(row)
    if (!match) throw new Error("submodule, symlink or non-regular index entry is unsupported")
    const name = match[2]!
    if (isAbsolute(name) || name.includes("\\") || name.split("/").some(p => !p || p === "." || p === "..")) throw new Error("unsafe tracked path")
    await safeDirectory(resolve(source, name, ".."), end)
    const info = await lstat(join(source, name))
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("special tracked file is unsupported")
  }
  // Filters and index masking flags were rejected before commands that compare working bytes.
  if (await git(source, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], end)) throw new Error("clean Git profile requires clean index, worktree, and no untracked files")
  const head = (await git(source, ["rev-parse", "--verify", "HEAD^{commit}"], end)).trim()
  if (head !== request.expectedHead) throw new Error("observed HEAD differs from owner pin")
  if ((await git(source, ["rev-parse", "--show-object-format"], end)).trim() !== request.expectedObjectFormat) throw new Error("observed object format differs from owner pin")
  const actual: Record<string, string> = Object.create(null)
  const lines = (await git(source, ["for-each-ref", "--format=%(refname)%00%(objectname)", ...Object.keys(request.expectedRefs)], end)).split("\n").filter(Boolean)
  for (const line of lines) { const [name, oid] = line.split("\0"); if (!name || !oid || !validRef(name) || !OID.test(oid) || Object.hasOwn(actual, name)) throw new Error("invalid ref observation"); actual[name] = oid }
  if (!equal(actual, request.expectedRefs)) throw new Error("observed refs differ from owner pins")
  const attachment = await git(source, ["symbolic-ref", "-q", "HEAD"], end, MAX_METADATA, true)
  return { head, refs: stable(actual), fingerprint: contractDigest({ common, privateDir, settings, index, attachment, flags }) }
}

async function closure(root: string, request: Pick<Request, "expectedHead" | "expectedRefs">, end: number, maxObjects: number, maxBytes: number) {
  const tips = [...new Set([request.expectedHead, ...Object.values(request.expectedRefs)])]
  const ids = (await git(root, ["rev-list", "--objects", "--no-object-names", ...tips], end, Math.min(MAX_METADATA, (maxObjects + 1) * 66))).trim().split("\n").filter(Boolean)
  if (!ids.length || ids.length > maxObjects || new Set(ids).size !== ids.length || ids.some(x => !OID.test(x))) throw new Error("reachable object closure exceeds object budget")
  const data = await runGit(root, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], end, MAX_METADATA, ids.join("\n") + "\n")
  const lines = new TextDecoder("utf-8", { fatal: true }).decode(data).trim().split("\n")
  if (lines.length !== ids.length) throw new Error("incomplete object sizing")
  const blobs: { id: string; bytes: number }[] = []
  let total = 0
  for (let i = 0; i < lines.length; i++) {
    const match = /^([a-f0-9]+) (commit|tree|blob|tag) ([0-9]+)$/u.exec(lines[i]!)
    if (!match || match[1] !== ids[i]) throw new Error("invalid object sizing response")
    const bytes = Number(match[3]); total += bytes
    if (!Number.isSafeInteger(total) || total > maxBytes) throw new Error("reachable closure exceeds uncompressed byte budget")
    if (match[2] === "blob") blobs.push({ id: match[1]!, bytes })
  }
  // Examine bounded reachable blob bytes even when LFS is not configured locally.
  if (blobs.length) {
    const raw = await runGit(root, ["cat-file", "--batch"], end, total + blobs.length * 100 + 1, blobs.map(b => b.id).join("\n") + "\n")
    let at = 0
    for (const blob of blobs) {
      const eol = raw.indexOf(10, at)
      if (eol < 0 || raw.subarray(at, eol).toString("ascii") !== `${blob.id} blob ${blob.bytes}`) throw new Error("invalid blob framing")
      at = eol + 1
      if (raw.subarray(at, at + Math.min(blob.bytes, 80)).toString("utf8").startsWith("version https://git-lfs.github.com/spec/v1")) throw new Error("clean Git profile rejects LFS pointer closure")
      at += blob.bytes
      if (raw[at++] !== 10) throw new Error("truncated object payload")
    }
    if (at !== raw.length) throw new Error("unexpected object bytes")
  }
  return { ids, total, tips }
}

export const exportCleanGitTransfer = async (input: unknown): Promise<CleanGitTransferResult> => {
  const request = requestSchema.parse(contractSnapshot(input, 128 * 1024))
  checkPins(request.expectedHead, request.expectedRefs, request.expectedObjectFormat)
  const end = Date.now() + (request.maxDurationMs ?? 60_000)
  const maxBundle = request.maxBundleBytes ?? DEFAULT_BYTES, maxUncompressed = request.maxUncompressedBytes ?? DEFAULT_BYTES
  const source = await safeDirectory(request.sourceRoot, end), destination = await safeDirectory(request.destinationParent, end)
  if (within(source, destination) || within(destination, source)) throw new Error("source and destination roots must be separate")
  const gitVersion = (await git(source, ["--version"], end, 256)).trim()
  const before = await observe(source, destination, request, end)
  const objects = await closure(source, request, end, request.maxObjects ?? MAX_OBJECTS, maxUncompressed)
  const stage = join(destination, `.usl-clean-git-stage-${randomUUID()}`), finalPath = join(destination, `usl-clean-git-${randomUUID()}`)
  await mkdir(stage, { mode: 0o700 })
  try {
    const payload = await runGit(source, ["bundle", "create", "--version=3", "-", ...Object.keys(request.expectedRefs), "HEAD"], end, maxBundle)
    const bundle = join(stage, "repo.bundle"), bundleByteDigest = sha(payload)
    await writeFile(bundle, payload, { flag: "wx", mode: 0o600 })
    const verify = join(stage, "verify.git")
    await git(stage, ["init", "--bare", "--template=", `--object-format=${request.expectedObjectFormat}`, verify], end)
    await git(verify, ["bundle", "verify", bundle], end)
    const heads: Record<string, string> = Object.create(null)
    for (const line of (await git(verify, ["bundle", "list-heads", bundle], end)).trim().split("\n")) {
      const match = /^([a-f0-9]+) (HEAD|refs\/heads\/.+)$/u.exec(line)
      if (!match || Object.hasOwn(heads, match[2]!)) throw new Error("invalid bundle heads")
      heads[match[2]!] = match[1]!
    }
    if (!equal(heads, { ...request.expectedRefs, HEAD: request.expectedHead })) throw new Error("bundle heads differ from independent pins")
    // Unbundle and fsck check actual objects, not merely the bundle header.
    await git(verify, ["bundle", "unbundle", bundle], end)
    await git(verify, ["fsck", "--strict", "--no-reflogs", "--no-progress", ...objects.tips], end)
    const verified = await closure(verify, request, end, request.maxObjects ?? MAX_OBJECTS, maxUncompressed)
    if (verified.total !== objects.total || [...verified.ids].sort().join("\n") !== [...objects.ids].sort().join("\n")) throw new Error("independent object closure differs")
    const after = await observe(source, destination, request, end)
    if (after.fingerprint !== before.fingerprint) throw new Error("source state changed during non-atomic export")
    await rm(verify, { recursive: true })
    const manifest = parseCleanGitTransferManifest({
      schema: "usl-clean-git-manifest/v1", profile: "CLEAN_GIT_WORKTREE_V1", ownerNamespace: request.ownerNamespace,
      repositoryId: request.repositoryId, worktreeId: request.worktreeId, issuer: request.issuer, observedAt: request.observedAt,
      objectFormat: request.expectedObjectFormat, expectedHead: request.expectedHead, expectedRefs: stable(request.expectedRefs), observedHead: after.head, observedRefs: after.refs,
      producer: { schema: CLEAN_GIT_TRANSFER_SCHEMA, gitVersion, nodeVersion: process.version },
      limits: { maxBundleBytes: maxBundle, maxUncompressedBytes: maxUncompressed, maxObjects: request.maxObjects ?? MAX_OBJECTS, maxDurationMs: request.maxDurationMs ?? 60_000, maxTrackedFiles: MAX_OBJECTS, maxMetadataBytes: MAX_METADATA },
      bundle: { path: "repo.bundle", version: 3, prerequisites: [], byteDigest: bundleByteDigest, bytes: payload.length, objectCount: objects.ids.length, reachableUncompressedBytes: objects.total, heads: stable(heads) }, limitations: LIMITATIONS,
    })
    const manifestDigest = contractDigest(manifest), manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n")
    const receiptBytes = Buffer.from(JSON.stringify({ schema: "usl-clean-git-receipt/v1", manifestDigest, manifestByteDigest: sha(manifestBytes), bundleByteDigest, bytes: payload.length, objectCount: objects.ids.length, execution: "LOCAL_EXPORT_ONLY" }, null, 2) + "\n")
    await writeFile(join(stage, "manifest.json"), manifestBytes, { flag: "wx", mode: 0o600 })
    await writeFile(join(stage, "receipt.json"), receiptBytes, { flag: "wx", mode: 0o600 })
    for (const [name, expected] of [["repo.bundle", payload], ["manifest.json", manifestBytes], ["receipt.json", receiptBytes]] as const)
      if (!expected.equals(await regularBytes(join(stage, name), expected.length, end))) throw new Error("staged artifact changed before publication")
    if ((await readdir(stage)).sort().join("\n") !== "manifest.json\nreceipt.json\nrepo.bundle") throw new Error("unexpected staged entry")
    await safeDirectory(destination, end); await safeDirectory(stage, end)
    await absent(finalPath, "existing destination")
    deadline(end)
    await rename(stage, finalPath)
    return freezeContract({ bundlePath: finalPath, gitBundlePath: join(finalPath, "repo.bundle"), manifestPath: join(finalPath, "manifest.json"), receiptPath: join(finalPath, "receipt.json"), transferPath: finalPath, manifestDigest, receiptDigest: sha(receiptBytes), bundleByteDigest, bytes: payload.length, objectCount: objects.ids.length, manifest })
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error }
}
