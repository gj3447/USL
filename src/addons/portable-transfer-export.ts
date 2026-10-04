/** Bounded, owner-snapshot export for portable-transfer v1. */
import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { constants } from "node:fs"
import { mkdir, open, opendir, rename, rm, stat, lstat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, parse as parsePath, relative, resolve, sep } from "node:path"
import { createPortableTransferEnvelope, parsePortableTransferEnvelope, parsePortableTransferManifest, portableTransferEnvelopeSchema, portableTransferManifestSchema, RAW_BYTES_DIGEST_ALGORITHM } from "./portable-transfer.js"
import { contractDigest } from "../contract-core.js"
import { assertJsonData } from "../json-data.js"

export const PORTABLE_TRANSFER_EXPORT_SCHEMA = "usl-portable-transfer-export/v1" as const
export type DependencyClass = "PACKAGED" | "EXTERNAL_REQUIRED" | "OPTIONAL"

export interface FrozenPortableTransferFile {
  /** Relative to sourceRoot.  The owner, rather than this module, selected it. */
  readonly sourcePath: string
  readonly payloadPath: string
  readonly nativeId: string
  readonly revisionId: string
  readonly representationId: string
  readonly expectedByteDigest: string
  readonly expectedByteLength: number
  readonly required?: boolean
  readonly parents?: readonly string[]
}
export interface PortableTransferDependency {
  readonly id: string
  readonly class: DependencyClass
  readonly required: boolean
  /** Actual representation IDs in this bundle which close this dependency. */
  readonly packagedRepresentationIds?: readonly string[]
  readonly reason: string
}
export interface FrozenPortableTransferOwner {
  readonly snapshotId: string
  /** Must reject if its owner lock/export snapshot is no longer the selected snapshot. */
  readonly assertConsistent?: () => void | Promise<void>
}
export type PortableTransferSnapshotProfile = "OWNER_FROZEN" | "PINNED_BYTE_SET"
export interface PortableTransferExportRequest {
  readonly schema: typeof PORTABLE_TRANSFER_EXPORT_SCHEMA
  readonly sourceRoot: string
  readonly destinationParent: string
  readonly ownerNamespace: string
  readonly issuer: string
  readonly observedAt: string
  readonly owner: FrozenPortableTransferOwner
  /** PINNED_BYTE_SET is an explicitly non-atomic filesystem capture, never an owner freeze. */
  readonly snapshotProfile?: PortableTransferSnapshotProfile
  /** Independent pin of the declared file/restore-path/dependency closure, checked before copying. */
  readonly expectedClosureDigest?: string
  readonly files: readonly FrozenPortableTransferFile[]
  readonly dependencies?: readonly PortableTransferDependency[]
  readonly restoreProfile: string
  /** A public, portable mapping only.  Values must never contain local roots or credentials. */
  readonly aliasDictionary?: Readonly<Record<string, string>>
  readonly maxTotalBytes?: number
  readonly maxDurationMs?: number
}
export interface PortableTransferExportResult {
  readonly bundlePath: string
  readonly snapshotId: string
  readonly manifestDigest: string
  readonly receiptDigest: string
  readonly selfContained: boolean
  readonly files: number
  readonly bytes: number
}

const MAX_METADATA_BYTES = 2 * 1024 * 1024
const MAX_FILES = 1024, DEFAULT_MAX_BYTES = 512 * 1024 * 1024, MAX_DURATION_MS = 5 * 60 * 1000
const GIT_EXTERNAL_CLOSURE = ["git-common-objects-refs-admin", "git-worktree-head-index-config", "git-dirty-untracked", "git-submodules", "git-lfs", "git-alternates"] as const
const exportInputSchema = z.object({
  schema: z.literal(PORTABLE_TRANSFER_EXPORT_SCHEMA), sourceRoot: z.string().min(1).max(4096), destinationParent: z.string().min(1).max(4096), ownerNamespace: z.string().min(1).max(512), issuer: z.string().min(1).max(512), observedAt: z.string().min(1).max(64),
  snapshotProfile: z.enum(["OWNER_FROZEN", "PINNED_BYTE_SET"]).optional(), expectedClosureDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u).optional(), restoreProfile: z.enum(["PINNED_FILES", "GIT_WORKTREE"]),
  files: z.array(z.object({ sourcePath: z.string().min(1).max(1024), payloadPath: z.string().min(1).max(1024), nativeId: z.string().min(1).max(256), revisionId: z.string().min(1).max(512), representationId: z.string().min(1).max(512), expectedByteDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u), expectedByteLength: z.number().int().min(0).max(DEFAULT_MAX_BYTES), required: z.boolean().optional(), parents: z.array(z.string().min(1).max(512)).max(64).optional() }).strict()).min(1).max(MAX_FILES),
  dependencies: z.array(z.object({ id: z.string().min(1).max(256), class: z.enum(["PACKAGED", "EXTERNAL_REQUIRED", "OPTIONAL"]), required: z.boolean(), packagedRepresentationIds: z.array(z.string().min(1).max(512)).max(MAX_FILES).optional(), reason: z.string().min(1).max(1024) }).strict()).max(MAX_FILES).optional(),
  aliasDictionary: z.record(z.string().min(1).max(256), z.string().min(1).max(1024)).optional(), maxTotalBytes: z.number().int().min(0).max(DEFAULT_MAX_BYTES).optional(), maxDurationMs: z.number().int().min(1).max(MAX_DURATION_MS).optional(),
}).strict()
const rawDigest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const safeRelative = (value: string, label: string) => {
  if (!value || isAbsolute(value) || value.includes("\\") || value.split("/").some(part => !part || part === "." || part === "..")) throw new Error(`unsafe ${label}`)
  return value
}
const plainDataRecord = (value: unknown, label: string) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error(`${label} must be a plain data object`)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) throw new Error(`${label} must contain plain data properties, not accessors or symbols`)
  }
}
const onlyKeys = (value: object, label: string, allowed: readonly string[]) => { for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`unknown ${label} field: ${key}`) }
const safePayload = (value: string) => {
  safeRelative(value, "payload path")
  if (value.split("/").some(part => !/^[A-Za-z0-9._-]+$/u.test(part) || /[. ]$/u.test(part) || /^(con|prn|aux|nul|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu.test(part))) throw new Error("unsafe portable ASCII payload path")
}
const inside = (root: string, child: string) => {
  const rel = relative(root, child)
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("path escapes selected source root")
}
const noSymlinkComponents = async (root: string, path: string) => {
  const parts = relative(root, path).split(sep); let current = root
  for (const part of parts) { current = resolve(current, part); if ((await lstat(current)).isSymbolicLink()) throw new Error("source path contains a symlink component") }
}
const regular = async (path: string, label: string) => {
  const entry = await lstat(path)
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`${label} must be a regular non-symlink file`)
  return entry
}
const sameStat = (a: Awaited<ReturnType<typeof stat>>, b: Awaited<ReturnType<typeof stat>>) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs

/** Stable pin for a finite selected restore closure; it is not a filesystem snapshot claim. */
const normalizedDependencies = (restoreProfile: string, dependencies: readonly PortableTransferDependency[]) => {
  const result = [...dependencies]
  if (restoreProfile === "GIT_WORKTREE") for (const id of GIT_EXTERNAL_CLOSURE) result.push({ id, class: "EXTERNAL_REQUIRED", required: true, reason: "Git closure bundling is unavailable in this exporter" })
  return result
}
export const portableTransferClosureDigest = (restoreProfile: string, files: readonly FrozenPortableTransferFile[], dependencies: readonly PortableTransferDependency[]) => contractDigest({ schema: PORTABLE_TRANSFER_EXPORT_SCHEMA, version: 1, restoreProfile,
  files: files.map(file => ({ restorePath: file.sourcePath, payloadPath: file.payloadPath, nativeId: file.nativeId, revisionId: file.revisionId, representationId: file.representationId, expectedByteDigest: file.expectedByteDigest, expectedByteLength: file.expectedByteLength, ...(file.required === undefined ? {} : { required: file.required }), ...(file.parents === undefined ? {} : { parents: [...file.parents] }) })),
  dependencies: normalizedDependencies(restoreProfile, dependencies).map(dependency => ({ id: dependency.id, class: dependency.class, required: dependency.required, reason: dependency.reason, ...(dependency.packagedRepresentationIds === undefined ? {} : { packagedRepresentationIds: [...dependency.packagedRepresentationIds] }) })) })

const checkDeadline = (deadline: number) => { if (Date.now() > deadline) throw new Error("export duration budget exceeded") }
const safeRestorePath = (value: string) => {
  safeRelative(value, "source path")
  const parts = value.split("/")
  if (parts.length > 16 || parts.some(part => Buffer.byteLength(part) > 255 || /[\u0000-\u001f\u007f<>:"|?*]/u.test(part) || /[. ]$/u.test(part) || /^(con|prn|aux|nul|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu.test(part))) throw new Error("unsafe portable restore path")
}
const checkPathCollisions = (paths: readonly string[], label: string) => {
  const entries = new Map<string, { spelling: string; file: boolean }>()
  for (const path of paths) {
    const parts = path.split("/")
    for (let i = 0; i < parts.length; i++) {
      const spelling = parts.slice(0, i + 1).join("/"), key = spelling.normalize("NFC").toLowerCase(), file = i === parts.length - 1
      const prior = entries.get(key)
      if (prior && (prior.spelling !== spelling || prior.file || file)) throw new Error(`${label} path collision`)
      entries.set(key, { spelling, file })
    }
  }
}
const safeDirectory = async (path: string) => {
  let current = parsePath(path).root
  for (const part of relative(current, path).split(sep).filter(Boolean)) {
    current = resolve(current, part)
    const entry = await lstat(current)
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("directory path contains a symlink or non-directory component")
  }
  return lstat(path)
}

async function copyVerified(root: string, source: string, destination: string, expectedDigest: string, expectedLength: number, deadline: number) {
  checkDeadline(deadline)
  await noSymlinkComponents(root, source)
  const before = await regular(source, "source payload")
  if (before.size !== expectedLength) throw new Error("source payload differs from owner-frozen expected size or budget")
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  const hash = createHash("sha256"); let total = 0
  try {
    const opened = await input.stat()
    if (!sameStat(before, opened) || !opened.isFile()) throw new Error("source changed before safe open")
    const output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024)
      for (;;) {
        checkDeadline(deadline)
        const read = await input.read(buffer, 0, buffer.length, null)
        if (!read.bytesRead) break
        total += read.bytesRead
        if (total > expectedLength) throw new Error("export byte budget exceeded")
        hash.update(buffer.subarray(0, read.bytesRead))
        let written = 0
        while (written < read.bytesRead) {
          checkDeadline(deadline)
          const result = await output.write(buffer, written, read.bytesRead - written)
          if (result.bytesWritten < 1) throw new Error("partial payload write")
          written += result.bytesWritten
        }
      }
      if (!sameStat(before, await input.stat())) throw new Error("source changed during copy")
    } finally { await output.close() }
  } finally { await input.close() }
  await noSymlinkComponents(root, source)
  const digest = `sha256:${hash.digest("hex")}`, after = await regular(source, "source payload")
  if (!sameStat(before, after) || total !== expectedLength || digest !== expectedDigest) throw new Error("source changed during copy or differs from owner-frozen bytes")
  const copied = await hashRegularFile(destination, expectedLength, deadline)
  if (copied.byteLength !== total || copied.digest !== digest) throw new Error("copied payload verification failed")
  return { digest, total }
}

async function hashRegularFile(path: string, maxBytes: number, deadline: number) {
  checkDeadline(deadline)
  const entry = await regular(path, "copied payload")
  if (entry.size > maxBytes) throw new Error("copied payload exceeds byte budget")
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  const hash = createHash("sha256"); let byteLength = 0
  try {
    const opened = await file.stat()
    if (!opened.isFile() || !sameStat(entry, opened)) throw new Error("copied payload changed before open")
    const buffer = Buffer.allocUnsafe(64 * 1024)
    for (;;) {
      checkDeadline(deadline)
      const read = await file.read(buffer, 0, buffer.length, null)
      if (!read.bytesRead) break
      byteLength += read.bytesRead
      if (byteLength > maxBytes) throw new Error("copied payload exceeds byte budget")
      hash.update(buffer.subarray(0, read.bytesRead))
    }
    if (!sameStat(entry, await file.stat())) throw new Error("copied payload changed during verification")
  } finally { await file.close() }
  if (!sameStat(entry, await regular(path, "copied payload"))) throw new Error("copied payload changed during verification")
  return { digest: `sha256:${hash.digest("hex")}`, byteLength }
}

async function exactTree(root: string, files: readonly string[], deadline: number) {
  const expected = new Map<string, "file" | "directory">()
  for (const file of files) {
    const parts = file.split("/")
    for (let i = 1; i < parts.length; i++) expected.set(parts.slice(0, i).join("/"), "directory")
    expected.set(file, "file")
  }
  const visited = new Set<string>(), pending = [""]
  while (pending.length) {
    checkDeadline(deadline)
    const base = pending.pop()!, directory = await opendir(resolve(root, base))
    for await (const entry of directory) {
      checkDeadline(deadline)
      const path = base ? `${base}/${entry.name}` : entry.name
      if (!expected.has(path) || visited.has(path)) throw new Error("unexpected file or directory in export staging")
      visited.add(path)
      if (expected.get(path) === "directory" && entry.isDirectory()) pending.push(path)
      else if (expected.get(path) !== "file" || !entry.isFile()) throw new Error("special file in export staging")
    }
  }
  if (visited.size !== expected.size) throw new Error("missing file in export staging")
}

/**
 * Exports only the finite files frozen by an owner snapshot.  This never scans a
 * source tree, discovers databases, or claims that a normal filesystem scan is atomic.
 */
export async function exportPortableTransfer(input: PortableTransferExportRequest): Promise<PortableTransferExportResult> {
  // Capture mutable caller collections before the first await.  Bytes still need their
  // independent owner pins and are rechecked during copying.
  plainDataRecord(input, "export request")
  plainDataRecord(input.owner, "owner")
  onlyKeys(input, "export request", ["schema", "sourceRoot", "destinationParent", "ownerNamespace", "issuer", "observedAt", "owner", "snapshotProfile", "expectedClosureDigest", "files", "dependencies", "restoreProfile", "aliasDictionary", "maxTotalBytes", "maxDurationMs"])
  onlyKeys(input.owner, "owner", ["snapshotId", "assertConsistent"])
  assertJsonData(input.files); if (input.dependencies !== undefined) assertJsonData(input.dependencies); if (input.aliasDictionary !== undefined) assertJsonData(input.aliasDictionary)
  for (const file of input.files) onlyKeys(file, "file", ["sourcePath", "payloadPath", "nativeId", "revisionId", "representationId", "expectedByteDigest", "expectedByteLength", "required", "parents"])
  for (const dependency of input.dependencies ?? []) onlyKeys(dependency, "dependency", ["id", "class", "required", "packagedRepresentationIds", "reason"])
  const parsed = exportInputSchema.safeParse({ schema: input.schema, sourceRoot: input.sourceRoot, destinationParent: input.destinationParent, ownerNamespace: input.ownerNamespace, issuer: input.issuer, observedAt: input.observedAt, snapshotProfile: input.snapshotProfile, expectedClosureDigest: input.expectedClosureDigest, restoreProfile: input.restoreProfile, files: input.files, dependencies: input.dependencies, aliasDictionary: input.aliasDictionary, maxTotalBytes: input.maxTotalBytes, maxDurationMs: input.maxDurationMs })
  if (!parsed.success) throw new Error(`invalid portable transfer export request: ${parsed.error.issues[0]?.message ?? "schema"}`)
  if (Buffer.byteLength(JSON.stringify(parsed.data)) > MAX_METADATA_BYTES) throw new Error("export metadata exceeds 2 MiB")
  if (Object.keys(input.aliasDictionary ?? {}).length > MAX_FILES) throw new Error("alias dictionary exceeds bound")
  if (input.owner.assertConsistent !== undefined && typeof input.owner.assertConsistent !== "function") throw new Error("owner consistency assertion must be a function")
  const files = Object.freeze(input.files.map(file => Object.freeze(file.parents === undefined ? { ...file } : { ...file, parents: Object.freeze([...file.parents]) })))
  const request: PortableTransferExportRequest = Object.freeze({ ...input, owner: Object.freeze({ ...input.owner }), files, ...(input.dependencies === undefined ? {} : { dependencies: Object.freeze(input.dependencies.map(dependency => Object.freeze(dependency.packagedRepresentationIds === undefined ? { ...dependency } : { ...dependency, packagedRepresentationIds: Object.freeze([...dependency.packagedRepresentationIds]) }))) }), ...(input.aliasDictionary === undefined ? {} : { aliasDictionary: Object.freeze({ ...input.aliasDictionary }) }) })
  if (request.schema !== PORTABLE_TRANSFER_EXPORT_SCHEMA) throw new Error("unsupported portable transfer export schema")
  if (!Array.isArray(request.files) || request.files.length < 1 || request.files.length > MAX_FILES) throw new Error("export needs a bounded non-empty file list")
  if (!request.restoreProfile || request.restoreProfile.length > 256) throw new Error("invalid restore profile")
  const snapshotProfile = request.snapshotProfile ?? "OWNER_FROZEN"
  if (snapshotProfile !== "OWNER_FROZEN" && snapshotProfile !== "PINNED_BYTE_SET") throw new Error("unsupported snapshot profile")
  if (snapshotProfile === "PINNED_BYTE_SET" && request.expectedClosureDigest === undefined) throw new Error("PINNED_BYTE_SET requires an expected closure digest")
  if (typeof request.owner.snapshotId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/u.test(request.owner.snapshotId)) throw new Error("invalid snapshot ID")
  const maxTotal = request.maxTotalBytes ?? DEFAULT_MAX_BYTES
  if (!Number.isSafeInteger(maxTotal) || maxTotal < 0 || maxTotal > DEFAULT_MAX_BYTES) throw new Error("invalid export byte budget")
  const duration = request.maxDurationMs
  if (duration !== undefined && (!Number.isSafeInteger(duration) || duration < 1 || duration > MAX_DURATION_MS)) throw new Error("invalid export duration budget")
  const deadline = Date.now() + (duration ?? MAX_DURATION_MS)
  const root = resolve(request.sourceRoot), parent = resolve(request.destinationParent)
  const rootStat = await safeDirectory(root), parentStat = await safeDirectory(parent)
  if (parent === root || parent.startsWith(`${root}${sep}`) || root.startsWith(`${parent}${sep}`)) throw new Error("source and destination parent must not contain one another")
  if (request.restoreProfile !== "PINNED_FILES" && request.restoreProfile !== "GIT_WORKTREE") throw new Error("unsupported restore profile")
  if (snapshotProfile === "OWNER_FROZEN" && request.owner.assertConsistent === undefined) throw new Error("OWNER_FROZEN export requires an owner consistency assertion")
  const nativeIds = new Set<string>(), revisionIds = new Set<string>(), representationIds = new Set<string>(), paths = new Set<string>(), restorePaths = new Set<string>(); let expectedTotal = 0
  for (const file of request.files) {
    safeRestorePath(file.sourcePath); safePayload(file.payloadPath)
    if ((file.parents?.length ?? 0) !== 0) throw new Error("parent revision closure is unsupported by the singleton-content exporter")
    const restoreFold = file.sourcePath.normalize("NFC").toLowerCase(); if (restorePaths.has(restoreFold)) throw new Error("source restore path collision"); restorePaths.add(restoreFold)
    if (file.sourcePath.split("/").some((part: string) => /^(?:\.git|\.ssh|\.aws|\.npmrc|\.gitconfig|\.netrc|\.env(?:\..*)?)$/iu.test(part))) throw new Error("selected source path names a local registration or credential location")
    const payloadFold = file.payloadPath.toLowerCase(); if (paths.has(payloadFold)) throw new Error("payload path collision"); paths.add(payloadFold)
    for (const [set, id] of [[nativeIds, file.nativeId], [revisionIds, file.revisionId], [representationIds, file.representationId]] as const) if (!id || set.has(id)) throw new Error("duplicate or missing native/revision/representation ID"); else set.add(id)
    if (!/^sha256:[0-9a-f]{64}$/u.test(file.expectedByteDigest) || !Number.isSafeInteger(file.expectedByteLength) || file.expectedByteLength < 0) throw new Error("invalid expected payload digest or length")
    expectedTotal += file.expectedByteLength; if (expectedTotal > maxTotal) throw new Error("owner-frozen selection exceeds byte budget")
    const source = resolve(root, file.sourcePath); inside(root, source); await noSymlinkComponents(root, source)
  }
  checkPathCollisions(request.files.map(file => file.sourcePath), "restore")
  checkPathCollisions(request.files.map(file => file.payloadPath), "payload")
  const dependencies = [...(request.dependencies ?? [])]
  if (dependencies.length > MAX_FILES) throw new Error("dependency inventory exceeds bound")
  const dependencyIds = new Set<string>()
  for (const dependency of dependencies) {
    if (!dependency.id || dependencyIds.has(dependency.id) || !["PACKAGED", "EXTERNAL_REQUIRED", "OPTIONAL"].includes(dependency.class) || !dependency.reason) throw new Error("invalid dependency inventory")
    if (request.restoreProfile === "GIT_WORKTREE" && GIT_EXTERNAL_CLOSURE.includes(dependency.id as typeof GIT_EXTERNAL_CLOSURE[number])) throw new Error("Git closure dependency IDs are reserved by the exporter")
    if (dependency.class === "PACKAGED" && (!dependency.packagedRepresentationIds?.length || dependency.packagedRepresentationIds.some(id => !representationIds.has(id)))) throw new Error("PACKAGED dependency needs bundled representation evidence")
    if (dependency.class === "EXTERNAL_REQUIRED" && !dependency.required || dependency.class === "OPTIONAL" && dependency.required) throw new Error("dependency class conflicts with required status")
    if (dependency.class !== "PACKAGED" && dependency.packagedRepresentationIds !== undefined) throw new Error("external dependency cannot claim packaged representations")
    if (dependency.packagedRepresentationIds && new Set(dependency.packagedRepresentationIds).size !== dependency.packagedRepresentationIds.length) throw new Error("duplicate packaged representation")
    dependencyIds.add(dependency.id)
  }
  dependencies.splice(0, dependencies.length, ...normalizedDependencies(request.restoreProfile, dependencies))
  if (request.expectedClosureDigest !== undefined && request.expectedClosureDigest !== portableTransferClosureDigest(request.restoreProfile, request.files, request.dependencies ?? [])) throw new Error("selected restore closure differs from its expected digest")
  const dictionary = request.aliasDictionary ?? {}
  for (const [key, value] of Object.entries(dictionary)) {
    if (/(?:password|secret|token|credential|bearer)/iu.test(key)) throw new Error("unsafe public alias dictionary")
    try { safePayload(value) } catch { throw new Error("unsafe public alias dictionary") }
    if (!request.files.some(file => file.payloadPath === value)) throw new Error("alias dictionary references an absent payload")
  }
  // Validate the complete manifest and metadata before invoking the owner or creating files.
  const manifest = parsePortableTransferManifest({ schema: "usl-portable-transfer/v1", ownerNamespace: request.ownerNamespace, issuer: request.issuer, observedAt: request.observedAt,
    resources: request.files.map(file => ({ ownerNamespace: request.ownerNamespace, nativeId: file.nativeId })),
    revisions: request.files.map(file => ({ id: file.revisionId, resource: { ownerNamespace: request.ownerNamespace, nativeId: file.nativeId }, kind: "CONTENT", parents: [], issuer: request.issuer })),
    representations: request.files.map(file => ({ id: file.representationId, revision: file.revisionId, payloadPath: `payload/${file.payloadPath}`, byteDigestAlgorithm: RAW_BYTES_DIGEST_ALGORITHM, byteDigest: file.expectedByteDigest, byteLength: file.expectedByteLength })),
    historyBoundary: { mode: "CLOSED_V1", externalParents: [] } })
  const envelope = parsePortableTransferEnvelope(createPortableTransferEnvelope(manifest))
  const selfContained = dependencies.every(d => !d.required || (d.class === "PACKAGED" && !!d.packagedRepresentationIds?.length))
  await request.owner.assertConsistent?.()
  checkDeadline(deadline)
  const bundleName = `usl-transfer-${randomUUID()}`, bundle = resolve(parent, bundleName), stage = resolve(bundle, ".staging")
  // Reserve an importer-owned name first; no existing bundle can be replaced.
  await mkdir(bundle, { mode: 0o700 })
  try {
    await mkdir(stage, { mode: 0o700 })
    let copiedBytes = 0
    for (const file of request.files) {
      if (Date.now() > deadline) throw new Error("export duration budget exceeded")
      const copied = await copyVerified(root, resolve(root, file.sourcePath), resolve(stage, "payload", file.payloadPath), file.expectedByteDigest, file.expectedByteLength, deadline)
      copiedBytes += copied.total
    }
    await request.owner.assertConsistent?.()
    checkDeadline(deadline)
    const artifacts: Record<string, unknown> = {
      "manifest.json": manifest, "envelope.json": envelope,
      "policy.json": { schema: PORTABLE_TRANSFER_EXPORT_SCHEMA, version: 1, snapshotId: request.owner.snapshotId, snapshotProfile,
        ownerConsistency: request.owner.assertConsistent === undefined ? "NOT_ASSERTED_BY_CLI" : "ASSERTED_BY_HOST_NOT_INDEPENDENTLY_VERIFIED",
        expectedClosureDigest: request.expectedClosureDigest ?? null, closureDigest: portableTransferClosureDigest(request.restoreProfile, request.files, request.dependencies ?? []),
        restoreProfile: request.restoreProfile, selfContained, dependencyClasses: ["PACKAGED", "EXTERNAL_REQUIRED", "OPTIONAL"] },
      "dictionary.json": dictionary,
      "inventory.json": { dependencies, files: request.files.map(file => ({ sourcePath: file.sourcePath, restorePath: file.sourcePath, payloadPath: file.payloadPath,
        nativeId: file.nativeId, revisionId: file.revisionId, representationId: file.representationId, byteDigest: file.expectedByteDigest,
        byteLength: file.expectedByteLength, ...(file.required === undefined ? {} : { required: file.required }), ...(file.parents === undefined ? {} : { parents: file.parents }) })) },
      "schema.json": { schema: PORTABLE_TRANSFER_EXPORT_SCHEMA, version: 1, restoreProfiles: ["PINNED_FILES", "GIT_WORKTREE"],
        manifest: z.toJSONSchema(portableTransferManifestSchema), envelope: z.toJSONSchema(portableTransferEnvelopeSchema) },
    }
    const metadata: Record<string, { byteDigest: string; byteLength: number }> = {}
    for (const [name, artifact] of Object.entries(artifacts)) {
      checkDeadline(deadline)
      const bytes = Buffer.from(json(artifact))
      if (bytes.length > MAX_METADATA_BYTES) throw new Error("export metadata exceeds 2 MiB")
      await writeFile(resolve(stage, name), bytes, { mode: 0o600, flag: "wx" })
      metadata[name] = { byteDigest: rawDigest(bytes), byteLength: bytes.length }
    }
    await exactTree(stage, [...Object.keys(artifacts), ...request.files.map(file => `payload/${file.payloadPath}`)], deadline)
    // Recheck staged bytes after the final owner callback, before publishing any complete receipt.
    for (const file of request.files) {
      const copied = await hashRegularFile(resolve(stage, "payload", file.payloadPath), file.expectedByteLength, deadline)
      if (copied.digest !== file.expectedByteDigest || copied.byteLength !== file.expectedByteLength) throw new Error("copied payload verification failed")
    }
    for (const [name, pin] of Object.entries(metadata)) {
      const actual = await hashRegularFile(resolve(stage, name), pin.byteLength, deadline)
      if (actual.digest !== pin.byteDigest || actual.byteLength !== pin.byteLength) throw new Error("copied metadata verification failed")
    }
    const currentRoot = await safeDirectory(root), currentParent = await safeDirectory(parent)
    if (rootStat.dev !== currentRoot.dev || rootStat.ino !== currentRoot.ino || parentStat.dev !== currentParent.dev || parentStat.ino !== currentParent.ino) throw new Error("export root changed")
    checkDeadline(deadline)
    await rename(stage, resolve(bundle, "payload-bundle"))
    // Written last: consumers treat a bundle without this receipt as incomplete.
    const receipt = resolve(bundle, "receipt.json"), receiptStaging = resolve(bundle, ".receipt-staging")
    const receiptData = json({ schema: PORTABLE_TRANSFER_EXPORT_SCHEMA, snapshotId: request.owner.snapshotId, manifestDigest: envelope.manifestDigest, metadata, selfContained, files: request.files.length, bytes: copiedBytes })
    await writeFile(receiptStaging, receiptData, { mode: 0o600, flag: "wx" })
    checkDeadline(deadline)
    await rename(receiptStaging, receipt)
    return Object.freeze({ bundlePath: bundle, snapshotId: request.owner.snapshotId, manifestDigest: envelope.manifestDigest, receiptDigest: rawDigest(Buffer.from(receiptData)), selfContained, files: request.files.length, bytes: copiedBytes })
  } catch (error) { await rm(bundle, { recursive: true, force: true }); throw error }
}
