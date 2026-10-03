/**
 * Strict, read-only checkout preflight for an explicitly selected binding.
 *
 * This is intentionally separate from binding-inspection: a binding report is
 * a best-effort observation, while this optional consumer only passes after
 * an owner policy and an independently supplied local checkout registry agree.
 * It grants no action authority and no observation is atomic with a later use.
 */
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, opendir, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path"
import { contractDigest, contractSnapshot, freezeContract } from "../contract-core.js"
import { parseResourceBindings, resolveResourceRepresentation, selectResourceRepresentation, type ResourceBindings, type ResourceRepresentationSelection } from "../resource-bindings.js"

export type CheckoutExpectedHead =
  | { readonly kind: "COMMIT"; readonly value: string }
  | { readonly kind: "UNBORN" }

export interface CheckoutGuardPolicy {
  readonly resource: string
  readonly representation: string
  readonly checkoutId: string
  readonly expectedHead: CheckoutExpectedHead
  readonly dirtyPolicy: "REQUIRE_CLEAN" | "ALLOW_DIRTY"
  /** Detached HEAD is held unless this owner policy explicitly permits it. */
  readonly allowDetached?: boolean
  /** Sparse checkout is held unless this owner policy explicitly permits it. */
  readonly allowSparse?: boolean
}

export interface CheckoutGuardHost {
  readonly workspaces: Readonly<Record<string, string>>
  readonly checkouts: Readonly<Record<string, { readonly workspace: string; readonly root: string }>>
}

export interface CheckoutGuardFingerprint {
  readonly head: string | null
  readonly status: string
  readonly index: string
  readonly worktree: string
  readonly untracked: string
  readonly submodules: string
  readonly selected: string | null
  readonly scope: string
  readonly digest: string
}

export interface CheckoutGuardObservation {
  readonly root: string
  readonly checkoutRoot: string
  readonly head: string | null
  readonly detached: boolean
  readonly sparse: boolean
  readonly dirty: boolean
  readonly fingerprint: CheckoutGuardFingerprint
  /** Existing file pins are checked only when the selected representation is a regular file. */
  readonly content?: { readonly digest: string; readonly pinStatus: "UNPINNED" | "MATCH" | "MISMATCH" }
}

export interface CheckoutGuardReport {
  readonly schema: "usl-checkout-guard/v1"
  readonly status: "PASS" | "HOLD"
  readonly reasons: readonly string[]
  readonly resource: string
  readonly representation: string
  readonly checkoutId: string
  readonly observation?: CheckoutGuardObservation
  readonly limitation: "READ_ONLY_NON_ATOMIC"
}

export interface PreparedCheckoutGuard {
  readonly schema: "usl-prepared-checkout-guard/v1"
  readonly preparedAt: string
  readonly policy: CheckoutGuardPolicy
  readonly document: ResourceBindings
  readonly selection: Required<ResourceRepresentationSelection>
  readonly host: CheckoutGuardHost
  readonly report: CheckoutGuardReport
  readonly fingerprint: CheckoutGuardFingerprint | null
  readonly limitation: "RECHECK_IMMEDIATELY_BEFORE_OWNER_ACTION;READ_ONLY_NON_ATOMIC"
}

const GIT = process.platform === "win32" ? "git.exe" : "/usr/bin/git"
const PATH = process.platform === "win32" ? process.env.SystemRoot ?? "C:\\Windows" : "/usr/bin:/bin"
const MAX_OUTPUT = 256 * 1024
const TIMEOUT = 15_000
const MAX_TOTAL_BYTES = 1024 * 1024
const MAX_ENTRIES = 4096
const MAX_UNTRACKED_ENTRIES = 256
const identifier = /^[A-Za-z_][A-Za-z0-9_.-]*$/
const commit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const preparedState = new WeakMap<object, Readonly<{ readonly document: ResourceBindings; readonly selection: Required<ResourceRepresentationSelection>; readonly policy: CheckoutGuardPolicy; readonly host: CheckoutGuardHost; readonly fingerprint: CheckoutGuardFingerprint | null; readonly report: CheckoutGuardReport }>>()

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
const exact = (value: Record<string, unknown>, keys: readonly string[], label: string): void => {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`unknown ${label} field: ${key}`)
}
const id = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !identifier.test(value)) throw new Error(`${label} must be an identifier`)
  return value
}
const pathText = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a nonempty path`)
  return value
}
const digest = (value: string): string => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`
const bytesDigest = (value: Uint8Array): string => `sha256:${createHash("sha256").update(value).digest("hex")}`
const within = (root: string, candidate: string): boolean => {
  const value = relative(root, candidate)
  return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
}

/** Parses an owner assertion; observed Git facts are never used to fill it. */
export const parseCheckoutGuardPolicy = (input: unknown): CheckoutGuardPolicy => {
  const value = object(contractSnapshot(input), "checkout guard policy")
  exact(value, ["resource", "representation", "checkoutId", "expectedHead", "dirtyPolicy", "allowDetached", "allowSparse"], "checkout guard policy")
  if (typeof value.resource !== "string" || value.resource.length === 0) throw new Error("checkout guard resource must be nonempty")
  const expected = object(value.expectedHead, "checkout guard expectedHead")
  let expectedHead: CheckoutExpectedHead
  if (expected.kind === "COMMIT") {
    exact(expected, ["kind", "value"], "checkout guard COMMIT expectedHead")
    if (typeof expected.value !== "string" || !commit.test(expected.value)) throw new Error("checkout guard COMMIT expectedHead value must be a full hexadecimal commit")
    expectedHead = { kind: "COMMIT", value: expected.value.toLowerCase() }
  } else if (expected.kind === "UNBORN") {
    exact(expected, ["kind"], "checkout guard UNBORN expectedHead")
    expectedHead = { kind: "UNBORN" }
  } else throw new Error("checkout guard expectedHead kind must be COMMIT or UNBORN")
  if (value.dirtyPolicy !== "REQUIRE_CLEAN" && value.dirtyPolicy !== "ALLOW_DIRTY") throw new Error("checkout guard dirtyPolicy is invalid")
  if (value.allowDetached !== undefined && typeof value.allowDetached !== "boolean") throw new Error("checkout guard allowDetached must be boolean")
  if (value.allowSparse !== undefined && typeof value.allowSparse !== "boolean") throw new Error("checkout guard allowSparse must be boolean")
  return freezeContract({ resource: value.resource, representation: id(value.representation, "checkout guard representation"), checkoutId: id(value.checkoutId, "checkout guard checkoutId"), expectedHead,
    dirtyPolicy: value.dirtyPolicy, ...(value.allowDetached === undefined ? {} : { allowDetached: value.allowDetached }), ...(value.allowSparse === undefined ? {} : { allowSparse: value.allowSparse }) })
}

const parseHost = (input: unknown): CheckoutGuardHost => {
  const value = object(contractSnapshot(input), "checkout guard host")
  exact(value, ["workspaces", "checkouts"], "checkout guard host")
  const workspaces = object(value.workspaces, "checkout guard host workspaces")
  const checkouts = object(value.checkouts, "checkout guard host checkouts")
  const parsedWorkspaces: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [key, root] of Object.entries(workspaces)) parsedWorkspaces[id(key, "workspace ID")] = pathText(root, "workspace root")
  const parsedCheckouts: Record<string, { readonly workspace: string; readonly root: string }> = Object.create(null) as Record<string, { readonly workspace: string; readonly root: string }>
  for (const [key, entry] of Object.entries(checkouts)) {
    const record = object(entry, "checkout registry entry")
    exact(record, ["workspace", "root"], "checkout registry entry")
    parsedCheckouts[id(key, "checkout ID")] = { workspace: id(record.workspace, "checkout workspace"), root: pathText(record.root, "checkout root") }
  }
  return freezeContract({ workspaces: parsedWorkspaces, checkouts: parsedCheckouts })
}

interface Budget { remaining: number; readonly deadline: number; entries: number }
interface GitResult { readonly code: number | null; readonly stdout: string; readonly stderr: string }
const consume = (budget: Budget, bytes: number): void => {
  if (bytes > budget.remaining) throw new Error("checkout guard observation exceeded its total byte bound")
  budget.remaining -= bytes
}
const git = async (cwd: string, args: readonly string[], budget: Budget): Promise<GitResult> => {
  const remainingMs = budget.deadline - Date.now()
  if (remainingMs < 1 || budget.remaining < 1) throw new Error("checkout guard observation exceeded its shared bound")
  const result = await new Promise<GitResult>((done, reject) => {
    execFile(GIT, ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesfile=/dev/null", "-c", "diff.external=", ...args], {
      shell: false, timeout: remainingMs, maxBuffer: Math.min(MAX_OUTPUT, budget.remaining), encoding: "utf8",
      env: { PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") return reject(new Error("checkout guard requires the host Git executable"))
      if (error && ((error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || (error as NodeJS.ErrnoException & { killed?: boolean }).killed)) return reject(new Error("checkout guard Git observation exceeded its bound"))
      const errorCode = error === null ? 0 : (error as NodeJS.ErrnoException).code
      done({ code: typeof errorCode === "number" ? errorCode : null, stdout: String(stdout), stderr: String(stderr) })
    })
  })
  consume(budget, Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8"))
  if (result.stdout.includes("\ufffd") || result.stderr.includes("\ufffd")) throw new Error("checkout guard Git output is not valid UTF-8")
  return result
}

const requiredGit = async (cwd: string, args: readonly string[], budget: Budget): Promise<string> => {
  const result = await git(cwd, args, budget)
  if (result.code !== 0) throw new Error("checkout guard Git observation is unavailable")
  return result.stdout
}
const unbornHead = (result: GitResult): boolean => result.code === 128 && /(needed a single revision|unknown revision|bad revision|ambiguous argument ['`]HEAD)/i.test(result.stderr)
const optionalHead = async (cwd: string, budget: Budget): Promise<string | null> => {
  const result = await git(cwd, ["rev-parse", "--verify", "HEAD"], budget)
  if (result.code === 0 && commit.test(result.stdout.trim())) return result.stdout.trim()
  if (unbornHead(result)) return null
  throw new Error("checkout guard HEAD fact is unavailable")
}
const detachedHead = async (cwd: string, budget: Budget): Promise<boolean> => {
  const result = await git(cwd, ["symbolic-ref", "-q", "HEAD"], budget)
  if (result.code === 0 && result.stdout.trim().startsWith("refs/")) return false
  if (result.code === 1 && result.stdout === "") return true
  throw new Error("checkout guard HEAD attachment fact is unavailable")
}
const sparseCheckout = async (cwd: string, budget: Budget): Promise<boolean> => {
  const result = await git(cwd, ["config", "--bool", "core.sparseCheckout"], budget)
  if (result.code === 1 && result.stdout === "") return false
  const value = result.stdout.trim().toLowerCase()
  if (result.code === 0 && (value === "true" || value === "false")) return value === "true"
  throw new Error("checkout guard sparse checkout fact is unavailable")
}
const rejectActiveFilters = async (cwd: string, budget: Budget): Promise<void> => {
  const result = await git(cwd, ["config", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$"], budget)
  if (result.code === 1 && result.stdout === "") return
  if (result.code === 0 && result.stdout.length > 0) throw new Error("checkout guard active Git filters are unsupported")
  throw new Error("checkout guard filter configuration is unavailable")
}

const nul = (value: string): readonly string[] => value.split("\0").filter(Boolean)
const fileDigest = async (root: string, path: string, budget: Budget): Promise<string> => {
  const initial = await lstat(path)
  if (!initial.isFile() || initial.isSymbolicLink()) throw new Error("checkout guard requires a regular non-symlink file")
  const canonical = await realpath(path)
  if (!within(root, canonical)) throw new Error("checkout guard file resolves outside checkout root")
  // O_NOFOLLOW and O_NONBLOCK make unsupported replacement objects fail
  // closed instead of following a symlink or blocking on a FIFO.
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.dev !== initial.dev || info.ino !== initial.ino) throw new Error("checkout guard file changed while opening")
    const chunks: Buffer[] = []
    let total = 0
    while (total <= budget.remaining) {
      if (Date.now() >= budget.deadline) throw new Error("checkout guard observation exceeded its shared deadline")
      const size = Math.min(64 * 1024, budget.remaining + 1 - total)
      const chunk = Buffer.allocUnsafe(size)
      const { bytesRead } = await handle.read(chunk, 0, size, total)
      if (bytesRead === 0) break
      chunks.push(chunk.subarray(0, bytesRead)); total += bytesRead
    }
    if (total > budget.remaining) throw new Error("checkout guard observation exceeded its total byte bound")
    consume(budget, total)
    const final = await handle.stat()
    if (final.dev !== info.dev || final.ino !== info.ino || final.size !== info.size) throw new Error("checkout guard file changed while reading")
    return bytesDigest(Buffer.concat(chunks, total))
  } finally { await handle.close() }
}
const untrackedDigest = async (root: string, names: readonly string[], budget: Budget): Promise<string> => {
  const entries: string[] = []
  for (const name of names) {
    budget.entries += 1
    if (budget.entries > MAX_ENTRIES) throw new Error("checkout guard entry count exceeded its bound")
    if (resolvePath(name) === name) throw new Error("checkout guard untracked path must be relative")
    const candidate = resolvePath(root, name)
    if (!within(root, candidate)) throw new Error("checkout guard untracked path escapes checkout root")
    const info = await lstat(candidate)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("checkout guard untracked scope contains an unsupported entry")
    if (!within(root, await realpath(candidate))) throw new Error("checkout guard untracked path resolves outside checkout root")
    entries.push(`${name}\u0000${await fileDigest(root, candidate, budget)}`)
  }
  return digest(entries.sort().join("\n"))
}

/** Git can omit FIFOs and unsupported directory entries from --others. Walk the
 * registered checkout with a hard entry cap so such entries never become PASS. */
const validateFilesystemScope = async (root: string, tracked: ReadonlySet<string>, untracked: ReadonlySet<string>, budget: Budget, directory = root): Promise<void> => {
  const handle = await opendir(directory)
  for await (const entry of handle) {
    if (directory === root && entry.name === ".git") continue
    budget.entries += 1
    if (budget.entries > MAX_ENTRIES || Date.now() >= budget.deadline) throw new Error("checkout guard filesystem scope exceeded its bound")
    const candidate = join(directory, entry.name), portable = relative(root, candidate).split(sep).join("/")
    if (!tracked.has(portable)) {
      const ignored = await git(root, ["check-ignore", "-q", "--", portable], budget)
      if (ignored.code === 0) continue
      if (ignored.code !== 1) throw new Error("checkout guard ignore scope is unavailable")
    }
    const info = await lstat(candidate)
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error("checkout guard filesystem scope contains an unsupported entry")
    if (info.isDirectory()) {
      if (tracked.has(portable)) throw new Error("checkout guard submodule scope is unsupported")
      try { await lstat(join(candidate, ".git")); throw new Error("checkout guard filesystem scope contains a nested repository") } catch (error) {
        if (!(error as NodeJS.ErrnoException).code || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      if (!within(root, await realpath(candidate))) throw new Error("checkout guard directory resolves outside checkout root")
      await validateFilesystemScope(root, tracked, untracked, budget, candidate)
    } else if (!tracked.has(portable) && !untracked.has(portable)) throw new Error("checkout guard filesystem scope contains an unenumerated file")
  }
}

const observe = async (root: string, scope: string, selectedPath: string | undefined, budget: Budget): Promise<CheckoutGuardObservation> => {
  const actualRoot = await realpath(root)
  if (!(await stat(actualRoot)).isDirectory()) throw new Error("checkout guard checkout root is not a directory")
  const gitRoot = (await requiredGit(actualRoot, ["rev-parse", "--show-toplevel"], budget)).trim()
  if (!gitRoot) throw new Error("checkout guard could not determine repository root")
  const canonicalGitRoot = await realpath(gitRoot)
  const firstHead = await optionalHead(actualRoot, budget)
  const detached = await detachedHead(actualRoot, budget)
  const sparse = await sparseCheckout(actualRoot, budget)
  // Sparse, assume-unchanged and skip-worktree can omit tracked bytes from a
  // filesystem observation. This profile does not claim a complete pin there.
  if (sparse) throw new Error("checkout guard sparse scope is unsupported")
  await rejectActiveFilters(actualRoot, budget)
  const flags = await requiredGit(actualRoot, ["ls-files", "-v", "-z"], budget)
  if (nul(flags).some(entry => /^[a-zS]/.test(entry))) throw new Error("checkout guard index contains hidden-worktree flags")
  const index = await requiredGit(actualRoot, ["ls-files", "-s", "-z"], budget)
  if (nul(index).some(record => record.startsWith("160000 "))) throw new Error("checkout guard submodule scope is unsupported")
  const firstStatus = await requiredGit(actualRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], budget)
  const worktree = await requiredGit(actualRoot, ["diff", "--no-ext-diff", "--no-textconv", "--binary", ...(firstHead === null ? [] : ["HEAD"])], budget)
  const trackedNames = new Set(nul(index).map(record => record.slice(record.indexOf("\t") + 1)))
  const untrackedNames = nul(await requiredGit(actualRoot, ["ls-files", "--others", "--exclude-standard", "-z"], budget))
  if (untrackedNames.length > MAX_UNTRACKED_ENTRIES) throw new Error("checkout guard untracked entry count exceeded its bound")
  await validateFilesystemScope(actualRoot, trackedNames, new Set(untrackedNames), budget)
  const untracked = await untrackedDigest(actualRoot, untrackedNames, budget)
  const submodules = digest("")
  let content: CheckoutGuardObservation["content"] | undefined
  let selected = null
  if (selectedPath !== undefined) {
    const info = await lstat(selectedPath)
    if (info.isFile() && !info.isSymbolicLink()) {
      const value = await fileDigest(actualRoot, selectedPath, budget)
      selected = value
      content = { digest: value, pinStatus: "UNPINNED" }
    }
    else if (!info.isDirectory()) throw new Error("checkout guard selected representation is unsupported")
  }
  const finalHead = await optionalHead(actualRoot, budget)
  const finalStatus = await requiredGit(actualRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], budget)
  const finalIndex = await requiredGit(actualRoot, ["ls-files", "-s", "-z"], budget)
  if (firstHead !== finalHead || firstStatus !== finalStatus || index !== finalIndex) throw new Error("checkout guard changed during observation")
  const fingerprint = freezeContract({ head: firstHead, status: digest(firstStatus), index: digest(index), worktree: digest(worktree), untracked, submodules, selected, scope,
    digest: contractDigest({ head: firstHead, status: digest(firstStatus), index: digest(index), worktree: digest(worktree), untracked, submodules, selected, scope, detached, sparse }) })
  if (content !== undefined) content = { ...content, pinStatus: "UNPINNED" }
  return freezeContract({ root: canonicalGitRoot, checkoutRoot: actualRoot, head: firstHead, detached, sparse, dirty: firstStatus.length > 0, fingerprint,
    ...(content === undefined ? {} : { content }) })
}

const report = async (document: ResourceBindings, selection: Required<ResourceRepresentationSelection>, policy: CheckoutGuardPolicy, host: CheckoutGuardHost): Promise<CheckoutGuardReport> => {
  const reasons: string[] = []
  const base = { schema: "usl-checkout-guard/v1" as const, resource: policy.resource, representation: policy.representation, checkoutId: policy.checkoutId, limitation: "READ_ONLY_NON_ATOMIC" as const }
  const selected = selectResourceRepresentation(document, selection)
  if (selected.resource.id !== policy.resource || selected.representation.id !== policy.representation) reasons.push("POLICY_SELECTION_MISMATCH")
  if (selected.representation.kind !== "workspace") reasons.push("REPRESENTATION_NOT_LOCAL_WORKSPACE")
  const registered = host.checkouts[policy.checkoutId]
  if (!registered) reasons.push("CHECKOUT_NOT_REGISTERED")
  if (registered && selected.representation.kind === "workspace" && registered.workspace !== selected.representation.workspace) reasons.push("CHECKOUT_WORKSPACE_MISMATCH")
  if (registered && host.workspaces[registered.workspace] !== registered.root) reasons.push("CHECKOUT_REGISTRY_ROOT_MISMATCH")
  if (reasons.length) return freezeContract({ ...base, status: "HOLD" as const, reasons })
  const entry = registered!
  try {
    const routingBudget: Budget = { remaining: MAX_TOTAL_BYTES, deadline: Date.now() + TIMEOUT, entries: 0 }
    const [registryRoot, workspaceRoot] = await Promise.all([realpath(entry.root), realpath(host.workspaces[entry.workspace]!)])
    if (registryRoot !== workspaceRoot) reasons.push("CHECKOUT_ROOT_NOT_CURRENT_WORKSPACE_ROOT")
    const registeredGitRoot = await realpath((await requiredGit(registryRoot, ["rev-parse", "--show-toplevel"], routingBudget)).trim())
    if (registeredGitRoot !== registryRoot) reasons.push("GIT_ROOT_DOES_NOT_MATCH_REGISTERED_CHECKOUT_ROOT")
    if (reasons.length) return freezeContract({ ...base, status: "HOLD" as const, reasons })
    const resolved = await resolveResourceRepresentation(document, selection, { workspaces: host.workspaces })
    if (resolved.kind !== "workspace" || resolved.path === undefined) reasons.push("REPRESENTATION_NOT_LOCAL_WORKSPACE")
    const selectedInfo = resolved.path === undefined ? undefined : await stat(resolved.path)
    const selectedCwd = selectedInfo?.isDirectory() ? resolved.path : resolved.path === undefined ? undefined : dirname(resolved.path)
    if (selectedCwd !== undefined) {
      const selectedGitRoot = await realpath((await requiredGit(selectedCwd, ["rev-parse", "--show-toplevel"], routingBudget)).trim())
      if (selectedGitRoot !== registryRoot) reasons.push("SELECTED_REPRESENTATION_GIT_ROOT_MISMATCH")
    }
    // A registry root which is merely a directory beneath a repository is not
    // a checkout root. Stop before path-relative Git output can be interpreted
    // against that non-root directory.
    if (reasons.length) return freezeContract({ ...base, status: "HOLD" as const, reasons })
    const scope = contractDigest({ checkoutId: policy.checkoutId, workspace: entry.workspace, root: registryRoot, selection, policy: { resource: policy.resource, representation: policy.representation } })
    const observed = await observe(registryRoot, scope, resolved.path, routingBudget)
    if (observed.root !== registryRoot) reasons.push("GIT_ROOT_DOES_NOT_MATCH_REGISTERED_CHECKOUT_ROOT")
    if (policy.expectedHead.kind === "COMMIT" && observed.head !== policy.expectedHead.value) reasons.push("HEAD_MISMATCH")
    if (policy.expectedHead.kind === "UNBORN" && observed.head !== null) reasons.push("HEAD_NOT_UNBORN")
    if (observed.detached && policy.allowDetached !== true) reasons.push("DETACHED_HEAD_NOT_ALLOWED")
    if (observed.sparse) reasons.push(policy.allowSparse === true ? "SPARSE_SCOPE_UNSUPPORTED" : "SPARSE_CHECKOUT_NOT_ALLOWED")
    if (observed.dirty && policy.dirtyPolicy === "REQUIRE_CLEAN") reasons.push("DIRTY_CHECKOUT")
    let content = observed.content
    if (content !== undefined && resolved.expectedDigest !== undefined) {
      content = { ...content, pinStatus: content.digest === resolved.expectedDigest ? "MATCH" : "MISMATCH" }
      if (content.pinStatus === "MISMATCH") reasons.push("CONTENT_PIN_MISMATCH")
    }
    if (resolved.expectedDigest !== undefined && content === undefined) reasons.push("CONTENT_PIN_NOT_OBSERVABLE")
    const observation = freezeContract({ ...observed, ...(content === undefined ? {} : { content }) })
    return freezeContract({ ...base, status: reasons.length ? "HOLD" as const : "PASS" as const, reasons,
      observation })
  } catch (error) {
    // Broken gitfiles, inaccessible paths, output bounds, and other unknown
    // facts cannot be promoted to PASS.
    const reason = error instanceof Error && /sparse scope/.test(error.message) ? "SPARSE_CHECKOUT_NOT_ALLOWED" : "GIT_FACTS_UNAVAILABLE"
    return freezeContract({ ...base, status: "HOLD" as const, reasons: [...reasons, reason] })
  }
}

const captured = (documentInput: ResourceBindings, selectionInput: ResourceRepresentationSelection, policyInput: CheckoutGuardPolicy | unknown, hostInput: CheckoutGuardHost | unknown) => {
  const document = parseResourceBindings(contractSnapshot(documentInput))
  const rawSelection = object(contractSnapshot(selectionInput), "checkout guard selection")
  exact(rawSelection, ["resource", "representation"], "checkout guard selection")
  if (typeof rawSelection.resource !== "string" || typeof rawSelection.representation !== "string") throw new Error("checkout guard requires an explicit resource and representation selection")
  const selection = freezeContract({ resource: rawSelection.resource, representation: rawSelection.representation })
  const policy = parseCheckoutGuardPolicy(policyInput), host = parseHost(hostInput)
  return { document, selection, policy, host }
}

/** Observe and decide once. It has no action callback and grants no authority. */
export const inspectCheckoutGuard = async (documentInput: ResourceBindings, selectionInput: ResourceRepresentationSelection, policyInput: CheckoutGuardPolicy | unknown, hostInput: CheckoutGuardHost | unknown): Promise<CheckoutGuardReport> => {
  const { document, selection, policy, host } = captured(documentInput, selectionInput, policyInput, hostInput)
  return report(document, selection, policy, host)
}

/** Prepare an immutable process-local preflight; recheck it immediately before any owner action. */
export const prepareCheckoutGuard = async (documentInput: ResourceBindings, selectionInput: ResourceRepresentationSelection, policyInput: CheckoutGuardPolicy | unknown, hostInput: CheckoutGuardHost | unknown): Promise<PreparedCheckoutGuard> => {
  const { document, selection, policy, host } = captured(documentInput, selectionInput, policyInput, hostInput)
  const result = await report(document, selection, policy, host)
  const prepared = freezeContract({ schema: "usl-prepared-checkout-guard/v1" as const, preparedAt: new Date().toISOString(), policy, document, selection, host, report: result,
    fingerprint: result.observation?.fingerprint ?? null, limitation: "RECHECK_IMMEDIATELY_BEFORE_OWNER_ACTION;READ_ONLY_NON_ATOMIC" as const })
  preparedState.set(prepared, freezeContract({ document, selection, policy, host, fingerprint: prepared.fingerprint, report: result }))
  return prepared
}

/** Freshly observe the checkout and reject a prepared plan whose fingerprint changed. */
export const recheckCheckoutGuard = async (preparedInput: PreparedCheckoutGuard, hostInput?: CheckoutGuardHost): Promise<CheckoutGuardReport> => {
  if (preparedInput === null || typeof preparedInput !== "object") throw new Error("prepared checkout guard was not created by this runtime")
  const state = preparedState.get(preparedInput)
  if (!state) throw new Error("prepared checkout guard was not created by this runtime")
  if (state.report.status !== "PASS") return state.report
  const host = hostInput === undefined ? state.host : parseHost(hostInput)
  const fresh = await inspectCheckoutGuard(state.document, state.selection, state.policy, host)
  if (state.fingerprint !== null && fresh.observation !== undefined && state.fingerprint.digest !== fresh.observation.fingerprint.digest) {
    return freezeContract({ ...fresh, status: "HOLD" as const, reasons: [...fresh.reasons, "PREPARED_FINGERPRINT_STALE"] })
  }
  if (state.fingerprint !== null && fresh.observation === undefined) return freezeContract({ ...fresh, status: "HOLD" as const, reasons: [...fresh.reasons, "PREPARED_FINGERPRINT_UNAVAILABLE"] })
  return fresh
}
