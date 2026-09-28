/** Read-only, bounded inspection of one explicitly selected representation. */
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import { dirname, resolve as resolvePath } from "node:path"
import { contractSnapshot, freezeContract } from "./contract-core.js"
import { readBytesBounded } from "./bounded-read.js"
import { parseResourceBindings, resolveResourceRepresentation, selectResourceRepresentation, type RepresentationRelation, type ResourceBindings, type ResourceRepresentationSelection } from "./resource-bindings.js"

/** All limits apply to this one inspection; Git metadata has a separate total budget. */
export interface BindingInspectionOptions {
  readonly workspaces: Readonly<Record<string, string>>
  readonly hostname?: string
  readonly maxBytes?: number
  readonly maxMetadataBytes?: number
  readonly timeoutMs?: number
}

/** A remote address candidate with secrets removed; it is not an identity claim. */
export interface SanitizedGitOrigin {
  readonly transport: "http" | "https" | "ssh" | "git"
  readonly host: string
  readonly port: string | null
  readonly path: string
  readonly queryDigest: string | null
  readonly fragmentDigest: string | null
  readonly credentialsRedacted: boolean
}
export interface BindingGitObservationBudget {
  readonly bytes: number
  readonly maxBytes: number
  readonly timeoutMs: number
}
export interface NoRepositoryBindingGitObservation {
  readonly state: "NO_REPOSITORY"
  readonly observation: BindingGitObservationBudget
}
export interface RepositoryBindingGitObservation {
  readonly state: "REPOSITORY"
  readonly root: string
  readonly worktree: string
  readonly commonGitDir: string
  readonly head: string | null
  readonly dirty: boolean
  readonly origin: SanitizedGitOrigin | null
  readonly identity: "OWNER_ASSERTED_UNVERIFIED_REMOTE"
  readonly observation: BindingGitObservationBudget
}
/** Local Git is either absent or observed; operational failures reject instead. */
export type BindingGitObservation = NoRepositoryBindingGitObservation | RepositoryBindingGitObservation
export interface BindingInspectionContent {
  readonly kind: "file" | "directory" | "locator"
  readonly digest: string | null
  readonly bytes: number | null
  readonly expectedDigest: string | null
  readonly pinStatus: "NOT_CHECKED" | "UNPINNED" | "MATCH" | "MISMATCH"
}
export interface BindingInspectionReport {
  readonly schema: "usl-resource-binding-inspection/v1"
  readonly resource: string
  readonly representation: string
  readonly relation: RepresentationRelation
  readonly locator: string
  readonly inspectedAt: string
  readonly consistency: "BEST_EFFORT_OBSERVATION"
  readonly content: BindingInspectionContent
  /** null when the selected representation is non-local. */
  readonly git: BindingGitObservation | null
}

const MAX_CONTENT_BYTES = 16 * 1024 * 1024
const MAX_METADATA_BYTES = 1024 * 1024
const MAX_TIMEOUT_MS = 60_000
const DEFAULT_CONTENT_BYTES = 1024 * 1024
const DEFAULT_METADATA_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 15_000
const gitPath = process.platform === "win32" ? "git.exe" : "/usr/bin/git"
const systemPath = process.platform === "win32" ? process.env.SystemRoot ?? "C:\\Windows" : "/usr/bin:/bin"

const hash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`
const textDigest = (value: string): string => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`
const object = (input: unknown, label: string): Record<string, unknown> => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error(`${label} must be an object`)
  return input as Record<string, unknown>
}
const exactKeys = (input: Record<string, unknown>, keys: readonly string[], label: string): void => {
  for (const key of Object.keys(input)) if (!keys.includes(key)) throw new Error(`unknown ${label} field: ${key}`)
}
const boundedInteger = (value: unknown, fallback: number, maximum: number, label: string): number => {
  const result = value === undefined ? fallback : value
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0 || result > maximum) throw new Error(`${label} must be a safe integer from 0 to ${maximum}`)
  return result
}

const captureOptions = (input: BindingInspectionOptions) => {
  const value = object(contractSnapshot(input), "binding inspection options")
  exactKeys(value, ["workspaces", "hostname", "maxBytes", "maxMetadataBytes", "timeoutMs"], "binding inspection options")
  const workspaces = object(value.workspaces, "workspaces")
  for (const [id, root] of Object.entries(workspaces)) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(id) || typeof root !== "string" || root.length === 0) throw new Error("workspaces must map workspace IDs to nonempty paths")
  }
  if (value.hostname !== undefined && (typeof value.hostname !== "string" || value.hostname.length === 0)) throw new Error("hostname must be a nonempty string")
  const timeoutMs = boundedInteger(value.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, "timeoutMs")
  if (timeoutMs === 0) throw new Error("timeoutMs must be a safe integer from 1 to 60000")
  return freezeContract({
    workspaces: Object.freeze({ ...workspaces }) as Readonly<Record<string, string>>,
    ...(value.hostname === undefined ? {} : { hostname: value.hostname }),
    maxBytes: boundedInteger(value.maxBytes, DEFAULT_CONTENT_BYTES, MAX_CONTENT_BYTES, "maxBytes"),
    maxMetadataBytes: boundedInteger(value.maxMetadataBytes, DEFAULT_METADATA_BYTES, MAX_METADATA_BYTES, "maxMetadataBytes"),
    timeoutMs,
  })
}

interface GitResult { readonly code: number | null; readonly stdout: string; readonly stderr: string }
interface GitBudget { remainingBytes: number; readonly deadline: number }

const runGit = async (cwd: string, args: readonly string[], budget: GitBudget): Promise<GitResult> => {
  const remainingMs = budget.deadline - Date.now()
  if (remainingMs < 1) throw new Error("git metadata observation exceeded timeoutMs")
  if (budget.remainingBytes < 1) throw new Error("git metadata observation exceeded maxMetadataBytes")
  const result = await new Promise<GitResult>((resolve, reject) => {
    execFile(gitPath, ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
      shell: false,
      timeout: remainingMs,
      maxBuffer: budget.remainingBytes,
      encoding: "utf8",
      env: { PATH: systemPath, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") return reject(new Error("git metadata observation requires the host Git executable"))
      if (error && ((error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || (error as NodeJS.ErrnoException & { killed?: boolean }).killed)) {
        return reject(new Error("git metadata observation exceeded its configured budget"))
      }
      const code = error === null ? 0 : typeof (error as NodeJS.ErrnoException).code === "number" ? Number((error as NodeJS.ErrnoException).code) : null
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
  const observed = Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8")
  if (observed > budget.remainingBytes) throw new Error("git metadata observation exceeded maxMetadataBytes")
  budget.remainingBytes -= observed
  return result
}

const noRepository = (result: GitResult): boolean => result.code === 128 && /not a git repository/i.test(result.stderr)
const missingOrigin = (result: GitResult): boolean => result.code === 2 && /no such remote ['`]origin['`]/i.test(result.stderr)
const unbornHead = (result: GitResult): boolean => result.code === 128 && /(needed a single revision|unknown revision|bad revision|ambiguous argument ['`]HEAD)/i.test(result.stderr)
const requiredGit = async (cwd: string, args: readonly string[], budget: GitBudget, operation: string): Promise<string> => {
  const result = await runGit(cwd, args, budget)
  if (result.code !== 0) throw new Error(`git metadata observation failed during ${operation}`)
  return result.stdout.trim()
}

/** A sanitized remote candidate only; it does not establish repository identity. */
const origin = (value: string): SanitizedGitOrigin | null => {
  if (!value || /[\u0000-\u001f\u007f\s]/u.test(value)) return null
  try {
    const url = new URL(value)
    const transport = url.protocol.slice(0, -1).toLowerCase()
    if (!(transport === "https" || transport === "http" || transport === "ssh" || transport === "git")) return null
    if (!url.hostname) return null
    const path = url.pathname.replace(/^\/+/, "").replace(/\.git$/i, "")
    if (!path) return null
    // Query and fragment text can carry access tokens. Hashing preserves the
    // fact that two candidates differ without publishing those values.
    return freezeContract({ transport, host: url.hostname.toLowerCase(), port: url.port || null, path,
      queryDigest: url.search ? textDigest(url.search.slice(1)) : null,
      fragmentDigest: url.hash ? textDigest(url.hash.slice(1)) : null,
      credentialsRedacted: Boolean(url.username || url.password) })
  } catch {
    // SCP-style syntax has no query, fragment, port, or credentials in output.
    const match = /^(?:([^@/:\s]+)@)?([A-Za-z0-9.-]+):\/?([^\s?#]+)$/.exec(value)
    if (!match) return null
    const path = match[3]!.replace(/^\/+/, "").replace(/\.git$/i, "")
    return path ? freezeContract({ transport: "ssh", host: match[2]!.toLowerCase(), port: null, path,
      queryDigest: null, fragmentDigest: null, credentialsRedacted: match[1] !== undefined }) : null
  }
}

/**
 * Inspect content and local Git facts for exactly one representation.
 *
 * This is a BEST_EFFORT_OBSERVATION. It never follows a remote, proves that
 * an origin identifies the selected resource, or equates two representations.
 */
export const inspectResourceBinding = async (document: ResourceBindings, selection: ResourceRepresentationSelection, input: BindingInspectionOptions): Promise<BindingInspectionReport> => {
  // Snapshot every caller input before selecting, resolving, touching the
  // filesystem, or awaiting. This prevents mutable inputs changing targets.
  const capturedDocument = parseResourceBindings(contractSnapshot(document))
  const capturedSelection = contractSnapshot(selection)
  const options = captureOptions(input)
  if (capturedSelection.representation === undefined) throw new Error("binding inspection requires an explicit representation")
  const selected = selectResourceRepresentation(capturedDocument, capturedSelection)
  const resolved = await resolveResourceRepresentation(capturedDocument, capturedSelection, { workspaces: options.workspaces, ...(options.hostname === undefined ? {} : { hostname: options.hostname }) })
  const base = { schema: "usl-resource-binding-inspection/v1" as const, resource: selected.resource.id, representation: selected.representation.id,
    relation: selected.representation.relation, locator: resolved.locator, inspectedAt: new Date().toISOString() }
  if (resolved.kind !== "workspace" || resolved.path === undefined) return freezeContract({ ...base, consistency: "BEST_EFFORT_OBSERVATION" as const,
    content: { kind: "locator" as const, digest: null, bytes: null, expectedDigest: resolved.expectedDigest ?? null, pinStatus: "NOT_CHECKED" as const }, git: null })
  const info = await stat(resolved.path)
  if (!info.isFile() && !info.isDirectory()) throw new Error("workspace representation must resolve to a regular file or directory")
  const bytes = info.isFile() ? await readBytesBounded(resolved.path, options.maxBytes, { limitName: "maxBytes" }) : null
  const cwd = info.isDirectory() ? resolved.path : dirname(resolved.path)
  const budget: GitBudget = { remainingBytes: options.maxMetadataBytes, deadline: Date.now() + options.timeoutMs }
  const rootResult = await runGit(cwd, ["rev-parse", "--show-toplevel"], budget)
  let repository: BindingGitObservation
  if (noRepository(rootResult)) {
    repository = { state: "NO_REPOSITORY" as const, observation: { bytes: options.maxMetadataBytes - budget.remainingBytes, maxBytes: options.maxMetadataBytes, timeoutMs: options.timeoutMs } }
  } else if (rootResult.code !== 0) {
    throw new Error("git metadata observation failed during repository discovery")
  } else {
    const root = rootResult.stdout.trim()
    const worktree = await requiredGit(cwd, ["rev-parse", "--show-toplevel"], budget, "worktree discovery")
    const commonRaw = await requiredGit(cwd, ["rev-parse", "--git-common-dir"], budget, "common Git directory discovery")
    const commonGitDir = await realpath(resolvePath(cwd, commonRaw)).catch(() => resolvePath(cwd, commonRaw))
    const headResult = await runGit(cwd, ["rev-parse", "--verify", "HEAD"], budget)
    if (headResult.code !== 0 && !unbornHead(headResult)) throw new Error("git metadata observation failed during HEAD discovery")
    const status = await requiredGit(cwd, ["status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=all"], budget, "status discovery")
    const remoteResult = await runGit(cwd, ["remote", "get-url", "origin"], budget)
    if (remoteResult.code !== 0 && !missingOrigin(remoteResult)) throw new Error("git metadata observation failed during origin discovery")
    repository = {
      state: "REPOSITORY" as const, root, worktree, commonGitDir, head: headResult.code === 0 ? headResult.stdout.trim() : null,
      dirty: status.length > 0, origin: remoteResult.code === 0 ? origin(remoteResult.stdout.trim()) : null,
      identity: "OWNER_ASSERTED_UNVERIFIED_REMOTE" as const,
      observation: { bytes: options.maxMetadataBytes - budget.remainingBytes, maxBytes: options.maxMetadataBytes, timeoutMs: options.timeoutMs },
    }
  }
  const actualDigest = bytes === null ? null : hash(bytes)
  return freezeContract({ ...base, consistency: "BEST_EFFORT_OBSERVATION" as const,
    content: { kind: info.isFile() ? "file" as const : "directory" as const, digest: actualDigest, bytes: bytes?.byteLength ?? null,
      expectedDigest: resolved.expectedDigest ?? null, pinStatus: actualDigest === null ? "NOT_CHECKED" as const : resolved.expectedDigest === undefined ? "UNPINNED" as const : actualDigest === resolved.expectedDigest ? "MATCH" as const : "MISMATCH" as const }, git: repository })
}
