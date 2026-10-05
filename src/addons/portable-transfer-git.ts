/** Bounded clean commit-object export. CP02, not this module, restores worktrees. */
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, opendir, readdir, rename, rm, writeFile } from "node:fs/promises"
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path"
import { z } from "zod"
import { contractDigest, contractIri, contractSnapshot, freezeContract } from "../contract-core.js"

export const CLEAN_GIT_TRANSFER_SCHEMA = "usl-clean-git-export/v1" as const
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

async function closure(root: string, request: Request, end: number, maxObjects: number, maxBytes: number) {
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
