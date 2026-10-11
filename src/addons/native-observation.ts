/** Read-only native facts for one explicitly selected local binding. */
import { execFile } from "node:child_process"
import { lstat, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path"
import { contractDigest, contractSnapshot, freezeContract } from "../contract-core.js"
import { inspectResourceBinding, type BindingInspectionContent } from "../binding-inspection.js"
import { inspectCheckoutGuard, parseCheckoutGuardPolicy, type CheckoutGuardHost, type CheckoutGuardPolicy } from "./checkout-guard.js"
import { parseResourceBindings, resolveResourceRepresentation, selectResourceRepresentation, type ResourceBindings, type ResourceRepresentationSelection } from "../resource-bindings.js"

export interface NativeCheckoutOptions {
  readonly policy: CheckoutGuardPolicy
  readonly checkouts: CheckoutGuardHost["checkouts"]
}
export interface NativeObservationOptions {
  readonly workspaces: Readonly<Record<string, string>>
  readonly checkout?: NativeCheckoutOptions
  readonly maxBytes?: number
  readonly timeoutMs?: number
}
export interface NativeGitObservation {
  readonly root: string
  readonly worktree: string
  readonly commonGitDir: string
  readonly head: string | null
  readonly ref: string | null
  readonly objectFormat: "sha1" | "sha256"
  readonly dirty: boolean
  readonly fingerprint: string
}
export interface NativeObservationReport {
  readonly schema: "usl-native-observation/v1"
  readonly status: "PASS" | "HOLD"
  readonly selection: Readonly<{ readonly resource: string; readonly representation: string }>
  readonly observedAt: string
  readonly content: BindingInspectionContent
  readonly git?: NativeGitObservation
  readonly capabilities: Readonly<{ readonly localRead: true; readonly remoteRead: false; readonly execution: false; readonly authority: "NOT_GRANTED"; readonly checkoutGuard: boolean }>
  readonly reasons: readonly string[]
  readonly consistency: "READ_ONLY_NON_ATOMIC"
  /** Stable facts only: excludes observedAt. */
  readonly digest: string
}
export interface PreparedNativeObservation {
  readonly schema: "usl-prepared-native-observation/v1"
  readonly report: NativeObservationReport
  readonly preparedAt: string
  readonly limitation: "PROCESS_LOCAL_HANDLE;READ_ONLY_NON_ATOMIC"
}

const MAX_BYTES = 16 * 1024 * 1024
const MAX_TIMEOUT = 60_000
const MAX_GIT_OUTPUT = 256 * 1024
const GIT = process.platform === "win32" ? "git.exe" : "/usr/bin/git"
const PATH = process.platform === "win32" ? process.env.SystemRoot ?? "C:\\Windows" : "/usr/bin:/bin"
const prepared = new WeakMap<object, Readonly<{ readonly bindings: ResourceBindings; readonly selection: Required<ResourceRepresentationSelection>; readonly options: NativeObservationOptions; readonly digest: string; readonly status: NativeObservationReport["status"] }>>()

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
const exact = (value: Record<string, unknown>, keys: readonly string[], label: string): void => {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`unknown ${label} field: ${key}`)
}
const bounded = (value: unknown, fallback: number, maximum: number, label: string): number => {
  const result: unknown = value === undefined ? fallback : value
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error(`${label} must be a safe integer from 1 to ${maximum}`)
  return result
}
const capture = (bindingsInput: ResourceBindings, selectionInput: ResourceRepresentationSelection, input: NativeObservationOptions) => {
  const bindings = parseResourceBindings(contractSnapshot(bindingsInput))
  const raw = object(contractSnapshot(selectionInput), "native observation selection")
  exact(raw, ["resource", "representation"], "native observation selection")
  if (typeof raw.resource !== "string" || typeof raw.representation !== "string") throw new Error("native observation requires an explicit resource and representation")
  const selection = freezeContract({ resource: raw.resource, representation: raw.representation })
  const optionsRaw = object(contractSnapshot(input), "native observation options")
  exact(optionsRaw, ["workspaces", "checkout", "maxBytes", "timeoutMs"], "native observation options")
  const workspaces = object(optionsRaw.workspaces, "native observation workspaces")
  const copiedWorkspaces: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [key, root] of Object.entries(workspaces)) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key) || typeof root !== "string" || !root) throw new Error("workspaces must map IDs to nonempty paths")
    copiedWorkspaces[key] = root
  }
  let checkout: NativeCheckoutOptions | undefined
  if (optionsRaw.checkout !== undefined) {
    const value = object(optionsRaw.checkout, "native observation checkout")
    exact(value, ["policy", "checkouts"], "native observation checkout")
    checkout = freezeContract({ policy: parseCheckoutGuardPolicy(value.policy), checkouts: contractSnapshot(value.checkouts) as CheckoutGuardHost["checkouts"] })
  }
  return { bindings, selection, options: freezeContract({ workspaces: copiedWorkspaces, ...(checkout === undefined ? {} : { checkout }), maxBytes: bounded(optionsRaw.maxBytes, 1024 * 1024, MAX_BYTES, "maxBytes"), timeoutMs: bounded(optionsRaw.timeoutMs, 15_000, MAX_TIMEOUT, "timeoutMs") }) }
}

interface Budget { remaining: number; readonly deadline: number }
const runGit = async (cwd: string, args: readonly string[], budget: Budget): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> => {
  const timeout = budget.deadline - Date.now()
  if (timeout < 1 || budget.remaining < 1) throw new Error("native Git observation exceeded its shared budget")
  const result = await new Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>((done, reject) => {
    execFile(GIT, ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesfile=/dev/null", "-c", "diff.external=", ...args], {
      shell: false, timeout, maxBuffer: Math.min(MAX_GIT_OUTPUT, budget.remaining), encoding: "utf8",
      env: { PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") return reject(new Error("native observation requires Git"))
      if (error && ((error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || (error as NodeJS.ErrnoException & { killed?: boolean }).killed)) return reject(new Error("native Git observation exceeded its shared budget"))
      const code = error === null ? 0 : (error as NodeJS.ErrnoException).code
      done({ code: typeof code === "number" ? code : null, stdout: String(stdout), stderr: String(stderr) })
    })
  })
  const used = Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8")
  if (used > budget.remaining || result.stdout.includes("\ufffd") || result.stderr.includes("\ufffd")) throw new Error("native Git observation exceeded its shared budget")
  budget.remaining -= used
  return result
}
const required = async (cwd: string, args: readonly string[], budget: Budget): Promise<string> => {
  const value = await runGit(cwd, args, budget)
  if (value.code !== 0) throw new Error("native Git fact is unavailable")
  return value.stdout.trim()
}
const bareContent = (expectedDigest?: string): BindingInspectionContent => ({ kind: "locator", digest: null, bytes: null, expectedDigest: expectedDigest ?? null, pinStatus: "NOT_CHECKED" })
const stable = (report: Omit<NativeObservationReport, "observedAt" | "digest">): string => contractDigest(report)
const finalize = (input: Omit<NativeObservationReport, "observedAt" | "digest">): NativeObservationReport => {
  const stableInput = { schema: input.schema, status: input.status, selection: input.selection, content: input.content,
    ...(input.git === undefined ? {} : { git: input.git }), capabilities: input.capabilities, reasons: input.reasons, consistency: input.consistency }
  return freezeContract({ ...stableInput, observedAt: new Date().toISOString(), digest: stable(stableInput) })
}
const within = (root: string, candidate: string): boolean => {
  const value = relative(root, candidate)
  return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`))
}
/** Reject a local symlink before the existing resolver can canonicalize it away. */
const localEntry = async (bindings: ResourceBindings, selection: Required<ResourceRepresentationSelection>, workspaces: Readonly<Record<string, string>>, deadline: number): Promise<void> => {
  const selected = selectResourceRepresentation(bindings, selection)
  if (selected.representation.kind !== "workspace") return
  const configured = workspaces[selected.representation.workspace]
  if (typeof configured !== "string" || !configured) throw new Error("workspace is not registered")
  const root = resolvePath(configured), rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("workspace root must be a non-symlink directory")
  const target = resolvePath(root, selected.representation.path)
  if (!within(root, target)) throw new Error("workspace path escapes its root")
  let current = root
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    if (Date.now() > deadline) throw new Error("native local path observation exceeded timeoutMs")
    current = resolvePath(current, part)
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new Error("workspace path contains a symlink")
  }
  const targetInfo = await lstat(target)
  if (!targetInfo.isFile() && !targetInfo.isDirectory()) throw new Error("workspace entry must be a regular file or directory")
}

/** Observes one selected representation. It does not infer authority or perform an action. */
export const observeNativeBinding = async (bindingsInput: ResourceBindings, selectionInput: ResourceRepresentationSelection, optionsInput: NativeObservationOptions): Promise<NativeObservationReport> => {
  const { bindings, selection, options } = capture(bindingsInput, selectionInput, optionsInput)
  const selected = selectResourceRepresentation(bindings, selection)
  const capabilityBase = { localRead: true as const, remoteRead: false as const, execution: false as const, authority: "NOT_GRANTED" as const, checkoutGuard: options.checkout !== undefined }
  if (selected.representation.kind === "locator") return finalize({ schema: "usl-native-observation/v1", status: "HOLD", selection, content: bareContent(selected.representation.digest), capabilities: capabilityBase, reasons: ["UNSUPPORTED_REMOTE_LOCATOR"], consistency: "READ_ONLY_NON_ATOMIC" })
  let inspected
  try {
    // timeoutMs applies independently to the established inspector and guard;
    // native follow-up Git queries use their own shared timeout/output budget.
    await localEntry(bindings, selection, options.workspaces, Date.now() + options.timeoutMs)
    inspected = await inspectResourceBinding(bindings, selection, { workspaces: options.workspaces, maxBytes: options.maxBytes, maxMetadataBytes: Math.min(options.maxBytes, MAX_GIT_OUTPUT), timeoutMs: options.timeoutMs })
  }
  catch { return finalize({ schema: "usl-native-observation/v1", status: "HOLD", selection, content: bareContent(), capabilities: capabilityBase, reasons: ["LOCAL_CONTENT_UNAVAILABLE"], consistency: "READ_ONLY_NON_ATOMIC" }) }
  const reasons: string[] = []
  if (inspected.content.pinStatus === "MISMATCH") reasons.push("CONTENT_PIN_MISMATCH")
  if (inspected.git === null || inspected.git.state === "NO_REPOSITORY") return finalize({ schema: "usl-native-observation/v1", status: reasons.length ? "HOLD" : "PASS", selection, content: inspected.content, capabilities: capabilityBase, reasons, consistency: "READ_ONLY_NON_ATOMIC" })
  if (options.checkout === undefined) return finalize({ schema: "usl-native-observation/v1", status: "HOLD", selection, content: inspected.content, capabilities: capabilityBase, reasons: [...reasons, "GIT_CHECKOUT_REGISTRY_REQUIRED"], consistency: "READ_ONLY_NON_ATOMIC" })
  const guard = await inspectCheckoutGuard(bindings, selection, options.checkout.policy, { workspaces: options.workspaces, checkouts: options.checkout.checkouts })
  if (guard.status !== "PASS" || guard.observation === undefined) return finalize({ schema: "usl-native-observation/v1", status: "HOLD", selection, content: inspected.content, capabilities: capabilityBase, reasons: [...reasons, ...guard.reasons.map(reason => `CHECKOUT_${reason}`)], consistency: "READ_ONLY_NON_ATOMIC" })
  try {
    const resolved = await resolveResourceRepresentation(bindings, selection, { workspaces: options.workspaces })
    if (resolved.path === undefined) throw new Error("selected local path is unavailable")
    const cwd = inspected.content.kind === "directory" ? resolved.path : dirname(resolved.path)
    const budget: Budget = { remaining: MAX_GIT_OUTPUT, deadline: Date.now() + options.timeoutMs }
    const root = await realpath(await required(cwd, ["rev-parse", "--show-toplevel"], budget))
    const worktree = await realpath(await required(cwd, ["rev-parse", "--show-toplevel"], budget))
    const commonGitDir = await realpath(resolvePath(cwd, await required(cwd, ["rev-parse", "--git-common-dir"], budget)))
    const refResult = await runGit(cwd, ["symbolic-ref", "-q", "HEAD"], budget)
    const ref = refResult.code === 0 ? refResult.stdout.trim() : refResult.code === 1 ? null : (() => { throw new Error("native Git ref is unavailable") })()
    const objectFormat = await required(cwd, ["rev-parse", "--show-object-format"], budget)
    if (objectFormat !== "sha1" && objectFormat !== "sha256") throw new Error("unsupported Git object format")
    const freshHeadResult = await runGit(cwd, ["rev-parse", "--verify", "HEAD"], budget)
    const freshHead = freshHeadResult.code === 0 ? freshHeadResult.stdout.trim() : freshHeadResult.code === 128 ? null : (() => { throw new Error("native Git HEAD is unavailable") })()
    if (freshHead !== null && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(freshHead)) throw new Error("native Git HEAD is malformed")
    if (freshHead !== null && freshHead.length !== (objectFormat === "sha1" ? 40 : 64)) throw new Error("native Git HEAD does not match object format")
    const git = freezeContract({ root, worktree, commonGitDir, head: guard.observation.head, ref, objectFormat: objectFormat as "sha1" | "sha256", dirty: guard.observation.dirty, fingerprint: guard.observation.fingerprint.digest })
    if (root !== guard.observation.root || worktree !== guard.observation.checkoutRoot || freshHead !== guard.observation.head) reasons.push("GIT_FACTS_CHANGED_DURING_OBSERVATION")
    if (inspected.git?.state === "REPOSITORY" && (inspected.git.root !== guard.observation.root || inspected.git.worktree !== guard.observation.checkoutRoot || inspected.git.head !== guard.observation.head)) reasons.push("INSPECTION_GIT_FACTS_STALE")
    if (inspected.content.digest !== guard.observation.content?.digest) {
      if (inspected.content.digest !== null || guard.observation.content?.digest !== undefined) reasons.push("INSPECTION_CONTENT_STALE")
    }
    return finalize({ schema: "usl-native-observation/v1", status: reasons.length ? "HOLD" : "PASS", selection, content: inspected.content, git, capabilities: capabilityBase, reasons, consistency: "READ_ONLY_NON_ATOMIC" })
  } catch { return finalize({ schema: "usl-native-observation/v1", status: "HOLD", selection, content: inspected.content, capabilities: capabilityBase, reasons: [...reasons, "NATIVE_GIT_FACTS_UNAVAILABLE"], consistency: "READ_ONLY_NON_ATOMIC" }) }
}

/** Creates a process-local recheck handle; a serialized report cannot be used as one. */
export const prepareNativeObservation = async (bindingsInput: ResourceBindings, selectionInput: ResourceRepresentationSelection, optionsInput: NativeObservationOptions): Promise<PreparedNativeObservation> => {
  const captured = capture(bindingsInput, selectionInput, optionsInput)
  const report = await observeNativeBinding(captured.bindings, captured.selection, captured.options)
  const value = freezeContract({ schema: "usl-prepared-native-observation/v1" as const, report, preparedAt: new Date().toISOString(), limitation: "PROCESS_LOCAL_HANDLE;READ_ONLY_NON_ATOMIC" as const })
  prepared.set(value, freezeContract({ ...captured, digest: report.digest, status: report.status }))
  return value
}

/** Reobserves fresh native facts. A held plan cannot be promoted and any stable fact drift holds. */
export const recheckNativeObservation = async (value: PreparedNativeObservation): Promise<NativeObservationReport> => {
  if (value === null || typeof value !== "object") throw new Error("native observation was not prepared by this process")
  const saved = prepared.get(value)
  if (!saved) throw new Error("native observation was not prepared by this process")
  if (saved.status !== "PASS") return value.report
  const fresh = await observeNativeBinding(saved.bindings, saved.selection, saved.options)
  if (fresh.status !== "PASS" || fresh.digest !== saved.digest) {
    const { observedAt: _observedAt, digest: _digest, ...stableFresh } = fresh
    return finalize({ ...stableFresh, status: "HOLD", reasons: [...fresh.reasons, ...(fresh.digest !== saved.digest ? ["PREPARED_OBSERVATION_STALE"] : [])] })
  }
  return fresh
}
