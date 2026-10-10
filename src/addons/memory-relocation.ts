/** Same-revision memory moves over an owner-managed binding state, without a USL database. */
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { join } from "node:path"
import { Either } from "effect"
import { z } from "zod"
import { contractHash, contractIri, contractSnapshot, contractText, contractDigest, freezeContract } from "../contract-core.js"
import { bindResourceGraph } from "../integrations/resource-bindings.js"
import { adaptResourceGraph, parseResourceGraph } from "../integrations/resource-graph.js"
import { parseResourceBindings, resolveResourceRepresentation, selectResourceRepresentation, type ResourceBindings } from "../resource-bindings.js"

const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_GRAPH_BYTES = 1024 * 1024
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/u).max(256)
const cursorSchema = z.object({
  ownerNamespace: contractIri, resource: contractText, representation: identifier,
  revisionId: contractText, byteDigest: contractHash,
  byteLength: z.number().int().min(0).max(MAX_FILE_BYTES),
  generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  status: z.enum(["ACTIVE", "WITHDRAWN"]),
}).strict()
const stateSchema = z.object({
  schema: z.literal("usl-memory-binding-state/v1"), cursor: cursorSchema,
  bindings: z.unknown(), graph: z.string().max(MAX_GRAPH_BYTES),
}).strict()
const eventSchema = z.object({
  schema: z.literal("usl-memory-relocation/v1"), id: contractIri,
  ownerNamespace: contractIri, resource: contractText, representation: identifier,
  revisionId: contractText, expectedStateDigest: contractHash,
  destination: z.object({ workspace: identifier, path: z.string().min(1).max(4096) }).strict(),
}).strict()
const optionsSchema = z.object({
  workspaces: z.record(identifier, z.string().min(1).max(4096)),
  hostname: z.string().min(1).max(256).optional(),
  maxBytes: z.number().int().min(0).max(MAX_FILE_BYTES).default(MAX_GRAPH_BYTES),
}).strict()

export type MemoryRelocationEvent = z.infer<typeof eventSchema>
export interface MemoryBindingState {
  readonly schema: "usl-memory-binding-state/v1"
  readonly cursor: Readonly<z.infer<typeof cursorSchema>>
  readonly bindings: ResourceBindings
  readonly graph: string
}
export type MemoryRelocationErrorCode = "INVALID_INPUT" | "STALE" | "WITHDRAWN" | "IDENTITY_MISMATCH" |
  "CONTENT_MISMATCH" | "UNAVAILABLE" | "CONFLICT" | "COMMIT_UNKNOWN"
export class MemoryRelocationError extends Error {
  constructor(readonly code: MemoryRelocationErrorCode, message: string) { super(message); this.name = "MemoryRelocationError" }
}

/**
 * The host owns identity, authorization, durable state and atomic CAS. An event
 * cannot configure roots or callbacks. readState must return the latest owner
 * state; CAS must compare its full digest and atomically replace the whole state.
 */
export interface MemoryRelocationHost {
  readonly readState: () => Promise<unknown>
  readonly compareAndSwap: (expectedStateDigest: string, nextState: MemoryBindingState) => Promise<boolean>
  readonly workspaces: Readonly<Record<string, string>>
  readonly hostname?: string
  readonly maxBytes?: number
}

const fail = (code: MemoryRelocationErrorCode, message: string): never => { throw new MemoryRelocationError(code, message) }
const decode = <T>(run: () => T): T => {
  try { return run() } catch (error) {
    if (error instanceof MemoryRelocationError) throw error
    return fail("INVALID_INPUT", "invalid memory relocation contract")
  }
}

/** No-follow leaf open; bounded bytes and descriptor metadata must remain stable. */
const readStableFile = async (path: string, maxBytes: number): Promise<Buffer> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size > BigInt(maxBytes)) fail("UNAVAILABLE", "memory destination must be a bounded regular file")
    const chunks: Buffer[] = []
    let total = 0
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total)
      if (!bytesRead) break
      chunks.push(chunk.subarray(0, bytesRead)); total += bytesRead
    }
    if (total > maxBytes) fail("UNAVAILABLE", "memory destination exceeds the host byte budget")
    const after = await handle.stat({ bigint: true }), atPath = await lstat(path, { bigint: true })
    for (const key of ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"] as const) {
      if (before[key] !== after[key] || after[key] !== atPath[key]) fail("CONFLICT", "memory destination changed while it was read")
    }
    return Buffer.concat(chunks, total)
  } finally { await handle.close() }
}

/** Pure validation. The current owner's pin is required before any event is considered. */
export const parseMemoryBindingState = (input: unknown): MemoryBindingState => decode(() => {
  const parsed = stateSchema.parse(contractSnapshot(input, 3 * MAX_GRAPH_BYTES))
  if (Buffer.byteLength(parsed.graph, "utf8") > MAX_GRAPH_BYTES) fail("INVALID_INPUT", "memory graph exceeds 1 MiB")
  const bindings = parseResourceBindings(parsed.bindings)
  const selected = selectResourceRepresentation(bindings, { resource: parsed.cursor.resource, representation: parsed.cursor.representation })
  if (selected.representation.kind !== "workspace") fail("INVALID_INPUT", "memory relocation requires a workspace representation")
  if (selected.representation.digest !== parsed.cursor.byteDigest) fail("INVALID_INPUT", "owner cursor and binding must carry the same independent byte pin")
  const graph = Either.getOrThrowWith(parseResourceGraph(parsed.graph), error => error)
  if (!graph.resources.some(resource => resource.id === parsed.cursor.resource)) fail("INVALID_INPUT", "memory resource is absent from the graph")
  Either.getOrThrowWith(adaptResourceGraph(parsed.graph, { namespace: "usl.memory.relocation.validation" }), error => error)
  return freezeContract({ schema: parsed.schema, cursor: parsed.cursor, bindings, graph: parsed.graph })
})

/** Exact contract state fingerprint, including generation; not an RDF equivalence hash. */
export const memoryBindingStateDigest = (state: MemoryBindingState): string => contractDigest(parseMemoryBindingState(state))

/**
 * Verify an already copied regular file and commit only the selected location.
 * No transfer, search, remote reads, revision merge, permission grant or retries.
 * Filesystem observations are best effort, not a storage lease or atomic snapshot.
 */
export async function relocateMemoryBinding(input: unknown, host: MemoryRelocationHost) {
  const event = decode(() => eventSchema.parse(contractSnapshot(input)))
  const options = decode(() => optionsSchema.parse(contractSnapshot({ workspaces: host.workspaces,
    ...(host.hostname === undefined ? {} : { hostname: host.hostname }),
    ...(host.maxBytes === undefined ? {} : { maxBytes: host.maxBytes }),
  })))
  if (typeof host.readState !== "function" || typeof host.compareAndSwap !== "function") fail("INVALID_INPUT", "owner state callbacks are required")
  const readState = host.readState.bind(host), compareAndSwap = host.compareAndSwap.bind(host)
  let rawState: unknown
  try { rawState = await readState() } catch { return fail("UNAVAILABLE", "owner memory state is unavailable") }
  const current = parseMemoryBindingState(rawState), cursor = current.cursor
  if (cursor.status === "WITHDRAWN") fail("WITHDRAWN", "owner memory state is withdrawn")
  const previousStateDigest = memoryBindingStateDigest(current)
  if (event.expectedStateDigest !== previousStateDigest) fail("STALE", "relocation event does not match the current owner state")
  for (const field of ["ownerNamespace", "resource", "representation", "revisionId"] as const) {
    if (event[field] !== cursor[field]) fail("IDENTITY_MISMATCH", "relocation event changes the owner, resource, representation or revision")
  }
  if (cursor.generation >= Number.MAX_SAFE_INTEGER - 1) fail("INVALID_INPUT", "memory generation is exhausted")
  if (cursor.byteLength > options.maxBytes) fail("INVALID_INPUT", "memory byte pin exceeds the host read budget")
  const selection = { resource: cursor.resource, representation: cursor.representation }
  const selected = selectResourceRepresentation(current.bindings, selection).representation
  if (selected.kind !== "workspace") return fail("INVALID_INPUT", "memory representation must be local")
  if (selected.workspace === event.destination.workspace && selected.path === event.destination.path) fail("INVALID_INPUT", "relocation destination must change the workspace alias or relative path")

  const bindings = decode(() => parseResourceBindings({ ...current.bindings,
    resources: current.bindings.resources.map(resource => ({ ...resource,
      representations: resource.representations.map(representation => representation.id === cursor.representation
        ? { ...representation, workspace: event.destination.workspace, path: event.destination.path } : representation),
    })),
  }))
  for (const resource of bindings.resources) for (const representation of resource.representations) {
    if (representation.id !== cursor.representation && representation.kind === "workspace" &&
      representation.workspace === event.destination.workspace && representation.path === event.destination.path) {
      fail("CONFLICT", "destination is already bound to an unselected representation")
    }
  }
  const resolutionOptions = { workspaces: options.workspaces, ...(options.hostname === undefined ? {} : { hostname: options.hostname }) }
  const verify = async () => {
    let locator: string, bytes: Buffer
    try {
      const configuredRoot = Object.hasOwn(options.workspaces, event.destination.workspace) ? options.workspaces[event.destination.workspace] : undefined
      if (configuredRoot === undefined) return fail("UNAVAILABLE", "destination workspace is not registered")
      let component = await realpath(configuredRoot)
      for (const part of event.destination.path.split("/")) {
        component = join(component, part)
        if ((await lstat(component)).isSymbolicLink()) return fail("UNAVAILABLE", "memory destination must not traverse a symbolic link")
      }
      const resolved = await resolveResourceRepresentation(bindings, selection, resolutionOptions)
      if (resolved.path === undefined) return fail("UNAVAILABLE", "memory destination is not a local file")
      locator = resolved.locator
      bytes = await readStableFile(resolved.path, options.maxBytes)
    } catch (error) {
      if (error instanceof MemoryRelocationError) throw error
      return fail("UNAVAILABLE", "memory destination is missing, outside its root, non-regular or over budget")
    }
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`
    if (digest !== cursor.byteDigest || bytes.byteLength !== cursor.byteLength) fail("CONTENT_MISMATCH", "destination bytes do not match the owner revision pin")
    return { locator, digest, bytes: bytes.byteLength }
  }
  const first = await verify()
  let bound: Awaited<ReturnType<typeof bindResourceGraph>>
  try { bound = await bindResourceGraph(current.graph, bindings, [selection], resolutionOptions) }
  catch { return fail("UNAVAILABLE", "memory destination could not be bound") }
  const last = await verify()
  const reboundResource = bound.graph.resources.find(resource => resource.id === cursor.resource)
  if (last.locator !== first.locator || reboundResource?.locator !== last.locator) fail("CONFLICT", "memory destination changed during verification")
  const state = parseMemoryBindingState({ schema: current.schema, cursor: { ...cursor, generation: cursor.generation + 1 },
    bindings, graph: JSON.stringify(bound.graph) })
  const resultStateDigest = memoryBindingStateDigest(state)
  // Build all fallible result data before CAS; nothing retries an uncertain write.
  const receiptBody = {
    schema: "usl-memory-relocation-receipt/v1" as const, eventId: event.id,
    ownerNamespace: cursor.ownerNamespace, resource: cursor.resource, representation: cursor.representation, revisionId: cursor.revisionId,
    previousStateDigest, resultStateDigest, generation: state.cursor.generation,
    destination: event.destination, content: { digest: last.digest, bytes: last.bytes },
    status: "COMMITTED" as const, scope: "LOCAL_PINNED_FILE" as const,
    consistency: "BEST_EFFORT_FILE_OBSERVATION_OWNER_CAS" as const,
    sourceStatus: "NOT_OBSERVED" as const,
    authority: "NOT_GRANTED" as const, execution: "NOT_REQUESTED" as const,
  }
  const result = freezeContract({ state, receipt: { ...receiptBody, digest: contractDigest(receiptBody) } })
  let committed: boolean
  try { committed = await compareAndSwap(previousStateDigest, state) }
  catch { return fail("COMMIT_UNKNOWN", "owner update outcome is unknown; reconcile owner state before another event") }
  if (committed === false) fail("CONFLICT", "owner state changed before the relocation commit")
  if (committed !== true) fail("COMMIT_UNKNOWN", "owner update returned an unknown result; reconcile owner state")
  return result
}
