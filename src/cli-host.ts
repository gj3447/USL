/** Host-owned, single-attempt CLI actions grounded in one GraphSpec entry node. */
import { constants } from "node:fs"
import { access, mkdir, open, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { Either } from "effect"
import { capabilitySchema, capabilityPolicySchema, capabilityInvocationSchema, preflightCapability, compileCapabilitySchema } from "./capabilities.js"
import { parseCapabilityCatalog } from "./capability-catalog.js"
import { contractDigest, contractHash, contractSnapshot, contractText, freezeContract } from "./contract-core.js"
import { readBytesBounded, readUtf8Bounded } from "./bounded-read.js"
import { sha256 } from "./resolve.js"
import { digestSource } from "./language/digest.js"
import { parseGraphEngineeringSource } from "./integrations/graph-engineering.js"
import { parseResourceBindings, resolveResourceRepresentation, type ResourceRepresentationSelection } from "./resource-bindings.js"
import { runCliProcess, type CliProcessResult } from "./cli-process.js"
import { bindResourceGraph } from "./integrations/resource-bindings.js"
import { inspectResourceBinding } from "./binding-inspection.js"
import { initialAttemptState, transitionAttempt } from "./attempt-state.js"
import { cliOperationStoreSchema, cliOperationKeySchema, reserveCliOperation } from "./cli-operation.js"

const LIMIT = 1024 * 1024
const selectionSchema = z.strictObject({ resource: contractText, representation: contractText.optional() })
type Selection = z.infer<typeof selectionSchema>
const exactSelection = (selection: Selection): ResourceRepresentationSelection => ({ resource: selection.resource,
  ...(selection.representation === undefined ? {} : { representation: selection.representation }) })
const graphBindingSchema = z.strictObject({
  source: selectionSchema, sourceDigest: contractHash, graphId: contractText,
  graphspecDigest: z.string().regex(/^[a-f0-9]{64}$/), node: contractText,
  scope: z.literal("ENTRY_NODE_ONLY"),
})
const actionSchema = z.strictObject({
  id: contractText, descriptor: capabilitySchema, policy: capabilityPolicySchema,
  graph: graphBindingSchema, cwd: selectionSchema,
  command: z.strictObject({
    executable: z.union([z.literal("node"), z.strictObject({ path: contractText })]),
    args: z.array(z.union([z.string().max(4096), selectionSchema])).max(128),
    envAllowlist: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(64),
  }),
  pins: z.array(z.strictObject({ source: selectionSchema, digest: contractHash })).min(1).max(128),
})
export const cliHostSchema = z.strictObject({
  schema: z.literal("usl-cli-host/v1"), bindings: contractText,
  workspaces: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/), contractText),
  maxSourceBytes: z.number().int().min(1).max(16 * LIMIT),
  operations: cliOperationStoreSchema.optional(),
  actions: z.array(actionSchema).max(128),
})
export type CliHostConfig = z.infer<typeof cliHostSchema>
export type CliHostAction = z.infer<typeof actionSchema>

const readHost = async (file: string) => {
  const hostPath = await realpath(file), base = dirname(hostPath)
  const text = await readUtf8Bounded(hostPath, LIMIT)
  const config = freezeContract(cliHostSchema.parse(contractSnapshot(JSON.parse(text))))
  if (new Set(config.actions.map(action => action.id)).size !== config.actions.length) throw new Error("duplicate CLI action ID")
  // Registration itself binds each policy to the exact capability descriptor.
  parseCapabilityCatalog({ schema: "usl-capability-catalog/v1", complete: true,
    entries: config.actions.map(action => ({ descriptor: action.descriptor, policy: action.policy })) })
  const bindingsPath = await realpath(resolve(base, config.bindings))
  const bindingsText = await readUtf8Bounded(bindingsPath, LIMIT)
  const bindings = parseResourceBindings(JSON.parse(bindingsText))
  const workspaces = Object.fromEntries(Object.entries(config.workspaces).map(([id, path]) => [id, resolve(base, path)]))
  return { config, bindings, workspaces, hostPath, hostDigest: digestSource(text), bindingsDigest: digestSource(bindingsText) }
}
type Host = Awaited<ReturnType<typeof readHost>>

export const locateCliResource = async (configFile: string, selection: ResourceRepresentationSelection) => {
  const captured = exactSelection(selectionSchema.parse(contractSnapshot(selection)))
  const host = await readHost(configFile)
  return resolveResourceRepresentation(host.bindings, captured, { workspaces: host.workspaces })
}
export const inspectCliBinding = async (configFile: string, selection: ResourceRepresentationSelection) => {
  const captured = exactSelection(selectionSchema.parse(contractSnapshot(selection)))
  const host = await readHost(configFile)
  return inspectResourceBinding(host.bindings, captured, { workspaces: host.workspaces, maxBytes: host.config.maxSourceBytes })
}
export const bindCliResourceGraph = async (configFile: string, raw: string, selections: readonly ResourceRepresentationSelection[]) => {
  const captured = contractSnapshot(selections)
  const host = await readHost(configFile)
  return bindResourceGraph(raw, host.bindings, captured, { workspaces: host.workspaces })
}
export const listCliActions = async (configFile: string) => {
  const host = await readHost(configFile)
  return freezeContract({ schema: "usl-cli-actions/v1", hostDigest: host.hostDigest,
    actions: host.config.actions.map(action => ({ id: action.id, descriptor: action.descriptor,
      descriptorDigest: contractDigest(action.descriptor), graph: { id: action.graph.graphId, node: action.graph.node, scope: action.graph.scope } })),
    execution: "NOT_EXECUTED" })
}

const localResource = async (host: Host, selection: Selection) => {
  const resource = await resolveResourceRepresentation(host.bindings, exactSelection(selection), { workspaces: host.workspaces })
  if (resource.kind !== "workspace" || resource.path === undefined) throw new Error("CLI paths require an explicitly selected workspace representation")
  return { ...resource, path: resource.path }
}
const fileDigest = (bytes: Uint8Array) => `sha256:${sha256(bytes)}`
const key = (source: { resource: string; representation: string }) => JSON.stringify([source.resource, source.representation])

/** Hash the executable without loading an entire runtime binary into memory. */
const executableIdentity = async (path: string) => {
  const file = await open(path, "r"), hash = createHash("sha256"), limit = 256 * LIMIT
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > limit) throw new Error("executable must be a regular file of at most 256 MiB")
    let bytes = 0
    const buffer = Buffer.allocUnsafe(64 * 1024)
    while (true) {
      const read = await file.read(buffer, 0, Math.min(buffer.length, limit + 1 - bytes), bytes)
      if (read.bytesRead === 0) break
      bytes += read.bytesRead
      if (bytes > limit) throw new Error("executable exceeds 256 MiB")
      hash.update(buffer.subarray(0, read.bytesRead))
    }
    return { digest: `sha256:${hash.digest("hex")}`, bytes }
  } finally { await file.close() }
}

/** Validate topology enough to refuse bypassing a dependency; this is not a GEIP workflow validator. */
const checkEntryNode = (raw: string, binding: CliHostAction["graph"]) => {
  if (digestSource(raw) !== binding.sourceDigest) throw new Error("GraphSpec source pin differs")
  const graph = Either.getOrThrowWith(parseGraphEngineeringSource(raw), error => error)
  if (graph.graphId !== binding.graphId || graph.graphspecDigest !== binding.graphspecDigest) throw new Error("GraphSpec identity pin differs")
  const nodes = z.array(z.object({ id: contractText, type: contractText }).passthrough()).min(1).max(4096).parse(graph.topology.nodes)
  const edges = z.array(z.object({ id: contractText, source: contractText, target: contractText }).passthrough()).max(8192).parse(graph.topology.edges)
  const ids = new Set(nodes.map(node => node.id))
  if (ids.size !== nodes.length || new Set(edges.map(edge => edge.id)).size !== edges.length) throw new Error("duplicate GraphSpec topology ID")
  if (edges.some(edge => !ids.has(edge.source) || !ids.has(edge.target))) throw new Error("GraphSpec edge has an unknown endpoint")
  const node = nodes.find(candidate => candidate.id === binding.node)
  if (!node || !["code", "tool"].includes(node.type)) throw new Error("CLI action requires a registered code/tool node")
  const topology = graph.document.topology as Record<string, unknown>
  if (!Array.isArray(topology.entry_nodes) || !topology.entry_nodes.includes(node.id)) throw new Error("CLI action must select a declared GraphSpec entry node")
  if (edges.some(edge => edge.target === node.id)) throw new Error("GraphSpec node dependencies require a workflow runtime")
  return { id: graph.graphId, version: graph.graphVersion, node: node.id, sourceDigest: binding.sourceDigest,
    graphspecDigest: graph.graphspecDigest, scope: binding.scope, geipValidation: "NOT_RUN", wholeGraphExecution: "NOT_EXECUTED" } as const
}

const prepare = async (configFile: string, actionId: string, requestInput: unknown) => {
  const request = freezeContract(capabilityInvocationSchema.parse(contractSnapshot(requestInput)))
  const host = await readHost(configFile)
  const action = host.config.actions.find(candidate => candidate.id === actionId)
  if (!action) throw new Error(`unknown registered CLI action: ${actionId}`)
  const preflight = preflightCapability(action.descriptor, request, action.policy)
  const base = { schema: "usl-cli-plan/v1" as const, action: action.id, hostDigest: host.hostDigest,
    bindingsDigest: host.bindingsDigest, hostPath: host.hostPath, requestDigest: contractDigest(request), preflight,
    execution: "NOT_EXECUTED" as const, semanticTruth: "NOT_EVALUATED" as const }
  const rejected = (issues: readonly { code: string; detail: string }[]) => {
    const body = { ...base, status: "REJECTED" as const, issues }
    return { plan: freezeContract({ ...body, planDigest: contractDigest(body) }), runtime: undefined }
  }
  if (preflight.status === "REJECTED") return rejected(preflight.issues)
  try {
    const cwd = await localResource(host, action.cwd)
    if (!(await stat(cwd.path)).isDirectory()) throw new Error("CLI cwd must be a directory")
    const sources: Array<{ resource: string; representation: string; locator: string; path: string; digest: string; bytes: number }> = []
    let consumed = 0
    const capture = async (selection: Selection, expected: string) => {
      const source = await localResource(host, selection)
      const existing = sources.find(item => key(item) === key(source))
      if (existing) {
        if (existing.digest !== expected) throw new Error("conflicting source pins")
        return { source: existing, bytes: undefined }
      }
      const bytes = await readBytesBounded(source.path, host.config.maxSourceBytes - consumed)
      consumed += bytes.length
      const digest = fileDigest(bytes)
      if (digest !== expected || source.expectedDigest !== undefined && digest !== source.expectedDigest) throw new Error(`source pin differs: ${source.resource}/${source.representation}`)
      const captured = { resource: source.resource, representation: source.representation, locator: source.locator, path: source.path, digest, bytes: bytes.length }
      sources.push(captured)
      return { source: captured, bytes }
    }
    const graphSource = await capture(action.graph.source, action.graph.sourceDigest)
    const graph = checkEntryNode(new TextDecoder("utf-8", { fatal: true }).decode(graphSource.bytes), action.graph)
    for (const pin of action.pins) await capture(pin.source, pin.digest)
    const args: string[] = []
    for (const argument of action.command.args) {
      if (typeof argument === "string") { if (argument.includes("\0")) throw new Error("NUL in CLI argument"); args.push(argument); continue }
      const source = await localResource(host, argument)
      if (!sources.some(pin => key(pin) === key(source))) throw new Error(`CLI resource argument must have an exact source pin: ${source.resource}`)
      args.push(source.path)
    }
    const configuredExecutable = action.command.executable === "node" ? process.execPath : action.command.executable.path
    if (!isAbsolute(configuredExecutable)) throw new Error("registered executable must be absolute (or the node runtime)")
    const executable = await realpath(configuredExecutable)
    const executablePin = await executableIdentity(executable)
    await access(executable, constants.X_OK)
    const env = Object.fromEntries(action.command.envAllowlist.filter(name => Object.hasOwn(process.env, name)).map(name => [name, process.env[name]!]))
    const command = { executable, args, cwd: cwd.path, environmentKeys: Object.keys(env).sort(), environmentDigest: contractDigest(env),
      executableIdentity: { ...executablePin,
        runtime: action.command.executable === "node" ? process.version : null } }
    // Bind logical work to stable selections/content; a workspace root move alone
    // changes the execution plan but must not make an old operation key reusable.
    const operation = host.config.operations === undefined ? undefined : {
      namespace: host.config.operations.namespace, keyRequired: true as const,
      semanticDigest: contractDigest({ schema: "usl-cli-logical-operation/v1", namespace: host.config.operations.namespace,
        action: action.id, descriptorDigest: contractDigest(action.descriptor), requestDigest: base.requestDigest, graph,
        cwd: { resource: cwd.resource, representation: cwd.representation },
        command: { args: action.command.args, executableIdentity: command.executableIdentity, environmentDigest: command.environmentDigest },
        sources: sources.map(({ resource, representation, digest }) => ({ resource, representation, digest })).sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) }),
    }
    const body = { ...base, status: "READY" as const, issues: [], graph, command, sources,
      limits: { timeoutMs: action.policy.timeoutMs, maxOutputBytes: action.policy.maxOutputBytes, maxSourceBytes: host.config.maxSourceBytes },
      sourceGuarantee: "DECLARED_FILES_ONLY" as const, ...(operation === undefined ? {} : { operation }) }
    return { plan: freezeContract({ ...body, planDigest: contractDigest(body) }), runtime: { action, request, executable, args, cwd: cwd.path, env,
      operationDirectory: host.config.operations === undefined ? undefined : resolve(dirname(host.hostPath), host.config.operations.directory) } }
  } catch (error) { return rejected([{ code: "HOST_BINDING", detail: String(error) }]) }
}

export const planCliAction = async (configFile: string, actionId: string, request: unknown) => (await prepare(configFile, actionId, request)).plan

const processEvidence = (process: CliProcessResult) => ({
  started: process.started, exitCode: process.exitCode, signal: process.signal,
  reason: process.reason, outputBytes: process.outputBytes, truncated: process.truncated,
  stdoutDigest: digestSource(process.stdout), stderrDigest: digestSource(process.stderr),
  stderr: process.stderr.slice(0, 4096),
})

const syncEvidenceDirectory = async (directory: string) => {
  if (process.platform === "win32") return
  const handle = await open(directory, "r")
  try { await handle.sync() } finally { await handle.close() }
}

const writeEvidence = async (directory: string, name: string, value: unknown) => {
  const file = await open(resolve(directory, name), "wx", 0o600)
  try { await file.writeFile(JSON.stringify(value, null, 2) + "\n"); await file.sync() } finally { await file.close() }
  // Sync the directory entry as well as the file before the effect boundary.
  await syncEvidenceDirectory(directory)
}

/** A new receipt directory reserves an attempt before spawning; retries always need a new explicit invocation. */
export const executeCliAction = async (configFile: string, actionId: string, requestInput: unknown,
  expectedPlanDigest: string, receiptDirectory: string, options: { signal?: AbortSignal; operationKey?: string } = {}) => {
  contractHash.parse(expectedPlanDigest)
  const operationKey = options.operationKey === undefined ? undefined : cliOperationKeySchema.parse(options.operationKey)
  const request = contractSnapshot(requestInput)
  const prepared = await prepare(configFile, actionId, request)
  const plan = prepared.plan
  if (!prepared.runtime || plan.status !== "READY" || plan.planDigest !== expectedPlanDigest || options.signal?.aborted) {
    const body = { schema: "usl-cli-execution/v1" as const, status: "REJECTED" as const, attempts: 0,
      plan, reason: options.signal?.aborted ? "ABORTED" : plan.status === "REJECTED" ? "PREFLIGHT_REJECTED" : "PLAN_CHANGED", semanticTruth: "NOT_EVALUATED" }
    return freezeContract({ ...body, receiptDigest: contractDigest(body) })
  }
  const runtime = prepared.runtime
  const keyIssue = plan.operation !== undefined && operationKey === undefined ? "OPERATION_KEY_REQUIRED"
    : plan.operation === undefined && operationKey !== undefined ? "OPERATION_STORE_REQUIRED" : null
  if (keyIssue !== null) {
    const body = { schema: "usl-cli-execution/v1" as const, status: "REJECTED" as const, attempts: 0, plan,
      reason: keyIssue, semanticTruth: "NOT_EVALUATED" }
    return freezeContract({ ...body, receiptDigest: contractDigest(body) })
  }
  const operation = plan.operation === undefined ? undefined : { namespace: plan.operation.namespace, key: operationKey!, semanticDigest: plan.operation.semanticDigest }
  let lifecycle = initialAttemptState()
  const directory = resolve(receiptDirectory), attempt = randomUUID(), startedAt = new Date().toISOString()
  await mkdir(directory, { mode: 0o700 })
  // Persist the new attempt directory's name before marking its intent durable.
  await syncEvidenceDirectory(dirname(directory))
  const intentBody = { schema: "usl-cli-intent/v1", attempt, startedAt, plan, status: "ATTEMPTING", recovery: "RECONCILE_WITH_OWNER; NEVER_AUTOMATICALLY_RETRY",
    ...(operation === undefined ? {} : { operation }) }
  const intent = { ...intentBody, intentDigest: contractDigest(intentBody) }
  await writeEvidence(directory, "intent.json", intent)
  lifecycle = transitionAttempt(lifecycle, { type: "INTENT_SAVED" })
  if (operation !== undefined) {
    const reserved = await reserveCliOperation(runtime.operationDirectory!, operation, {
      attempt, intentDigest: intent.intentDigest, planDigest: plan.planDigest, receiptDirectory: directory, createdAt: startedAt })
    if (reserved.status === "REJECTED") {
      lifecycle = transitionAttempt(lifecycle, { type: "REJECT_BEFORE_START" })
      const body = { schema: "usl-cli-execution/v1" as const, status: "REJECTED" as const, attempts: 0, attempt, startedAt,
        finishedAt: new Date().toISOString(), planDigest: plan.planDigest, intentDigest: intent.intentDigest,
        reason: reserved.reason, ...("previous" in reserved ? { previousAttempt: reserved.previous } : {}),
        lifecycle, semanticTruth: "NOT_EVALUATED", automaticRetry: false }
      const receipt = freezeContract({ ...body, receiptDigest: contractDigest(body) })
      await writeEvidence(directory, "result.json", receipt)
      return receipt
    }
  }
  const fresh = options.signal?.aborted ? undefined : await prepare(configFile, actionId, request).catch(() => undefined)
  if (!fresh || fresh.plan.planDigest !== expectedPlanDigest) {
    lifecycle = transitionAttempt(lifecycle, { type: "REJECT_BEFORE_START" })
    const body = { schema: "usl-cli-execution/v1" as const, status: "REJECTED" as const, attempts: 0, attempt,
      startedAt, finishedAt: new Date().toISOString(), planDigest: plan.planDigest, intentDigest: intent.intentDigest,
      reason: options.signal?.aborted ? "ABORTED" : "BINDING_CHANGED_BEFORE_START", lifecycle, semanticTruth: "NOT_EVALUATED" }
    const receipt = freezeContract({ ...body, receiptDigest: contractDigest(body) })
    await writeEvidence(directory, "result.json", receipt)
    return receipt
  }
  lifecycle = transitionAttempt(lifecycle, { type: "AUTHORIZE_START", pinsMatch: true })
  // This fixed argv has no request interpolation; request data goes only to stdin.
  const child = await runCliProcess({ executable: runtime.executable, args: runtime.args, cwd: runtime.cwd, env: runtime.env,
    input: JSON.stringify(runtime.request.input.value) + "\n", timeoutMs: runtime.action.policy.timeoutMs,
    maxOutputBytes: runtime.action.policy.maxOutputBytes, ...(options.signal === undefined ? {} : { signal: options.signal }) })
    .catch((): CliProcessResult => ({ started: false, exitCode: null, signal: null, stdout: "", stderr: "", outputBytes: 0, truncated: false, reason: "SPAWN_ERROR" }))
  let output: unknown, reason: string | null = child.reason
  if (reason === null) {
    try {
      output = contractSnapshot(JSON.parse(child.stdout), runtime.action.policy.maxOutputBytes)
      if (!compileCapabilitySchema(runtime.action.descriptor.output.schema)(output)) reason = "OUTPUT_SCHEMA"
    } catch { reason = "INVALID_JSON_OUTPUT" }
  }
  try {
    const current = await prepare(configFile, actionId, request)
    if (current.plan.planDigest !== expectedPlanDigest) reason = "SOURCE_OR_BINDING_CHANGED"
  } catch { reason = "SOURCE_OR_BINDING_CHANGED" }
  const completedLifecycle = transitionAttempt(lifecycle, { type: "FINISH", started: child.started, succeeded: reason === null })
  const body = { schema: "usl-cli-execution/v1" as const, status: !child.started ? "REJECTED" as const : reason === null ? "SUCCEEDED" as const : "INDETERMINATE" as const,
    attempt, attempts: child.started ? 1 : 0, startedAt, finishedAt: new Date().toISOString(), planDigest: plan.planDigest, intentDigest: intent.intentDigest,
    graph: plan.graph, sourceGuarantee: plan.sourceGuarantee, process: processEvidence(child), reason,
    ...(reason === null ? { output } : {}), lifecycle: completedLifecycle, semanticTruth: "NOT_EVALUATED", automaticRetry: false }
  const receipt = freezeContract({ ...body, receiptDigest: contractDigest(body) })
  try { await writeEvidence(directory, "result.json", receipt) }
  catch {
    const failed = { ...body, status: child.started ? "INDETERMINATE" as const : "REJECTED" as const,
      reason: "RECEIPT_WRITE_FAILED", observedStatus: body.status,
      lifecycle: transitionAttempt(lifecycle, { type: "FINISH", started: child.started, succeeded: false }),
      receiptPersisted: false, receiptDirectory: directory }
    return freezeContract({ ...failed, receiptDigest: contractDigest(failed) })
  }
  return receipt
}
