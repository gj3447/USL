/**
 * Stable resource names can have several representations without making a
 * machine-local pathname their identity.  This module only resolves a
 * representation selected by the caller; it neither reads content nor grants
 * access to it.
 */
import { realpath, stat } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { Either } from "effect"
import { contractSnapshot, contractText, freezeContract } from "./contract-core.js"
import { formatLocator, parseLocator } from "./locator.js"

export const RESOURCE_BINDINGS_SCHEMA = "usl-resource-bindings/v1" as const

export type RepresentationRelation = "working-copy" | "snapshot" | "documentation" | "mirror"
export interface WorkspaceRepresentation {
  readonly id: string
  readonly relation: RepresentationRelation
  readonly kind: "workspace"
  readonly workspace: string
  /** A POSIX-style path relative to the host-registered workspace root. */
  readonly path: string
  readonly digest?: string
}
export interface LocatorRepresentation {
  readonly id: string
  readonly relation: RepresentationRelation
  readonly kind: "locator"
  readonly locator: string
  readonly digest?: string
}
export type ResourceRepresentation = WorkspaceRepresentation | LocatorRepresentation
export interface BoundResource { readonly id: string; readonly representations: readonly ResourceRepresentation[] }
export interface ResourceBindings { readonly schema: typeof RESOURCE_BINDINGS_SCHEMA; readonly resources: readonly BoundResource[] }
export interface ResourceRepresentationSelection { readonly resource: string; readonly representation?: string }
export interface ResolvedResourceRepresentation {
  readonly resource: string
  readonly representation: string
  readonly relation: RepresentationRelation
  readonly kind: ResourceRepresentation["kind"]
  readonly locator: string
  /** Absolute canonical local path; only present for workspace representations. */
  readonly path?: string
  /** Portable path recorded in the binding document, when the kind is workspace. */
  readonly relativePath?: string
  readonly expectedDigest?: string
}

const identifier = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value)) throw new Error(`${label} must be a nonempty identifier`)
  return value
}
const resourceId = (value: unknown): string => {
  try { return contractText.parse(value) } catch { throw new Error("resource ID must be nonempty contract text") }
}
const digest = (value: unknown, label: string): string | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be sha256:<lowercase-hex>`)
  return value
}
const object = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
const exactKeys = (value: Record<string, unknown>, permitted: readonly string[], label: string) => {
  for (const key of Object.keys(value)) if (!permitted.includes(key)) throw new Error(`unknown ${label} field: ${key}`)
}
const relation = (value: unknown): RepresentationRelation => {
  if (value === "working-copy" || value === "snapshot" || value === "documentation" || value === "mirror") return value
  throw new Error("representation relation is invalid")
}
const relativePath = (value: unknown): string => {
  if (typeof value !== "string" || !value || value.includes("\\")) throw new Error("workspace path must be a nonempty POSIX relative path")
  if (value === ".") return value
  if (value.startsWith("/") || value.endsWith("/") || value.split("/").some(part => part === "" || part === "." || part === "..")) throw new Error("workspace path must stay below its workspace root")
  return value
}
const locator = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("locator representation locator must be a string")
  const parsed = parseLocator(value)
  if (Either.isLeft(parsed) || (parsed.right.kind !== "git_repo" && parsed.right.kind !== "url")) throw new Error("locator representation must be a git:// or HTTP(S) locator")
  if (parsed.right.kind === "git_repo" && (parsed.right.commit === undefined || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(parsed.right.commit))) throw new Error("git locator representation requires a 40 or 64 digit immutable commit")
  if (parsed.right.kind === "url") {
    const url = new URL(parsed.right.href)
    if (url.username || url.password) throw new Error("URL locator representation must not contain credentials")
  }
  return formatLocator(parsed.right)
}

const parseRepresentation = (input: unknown): ResourceRepresentation => {
  const value = object(input, "representation")
  const kind = value.kind
  if (kind === "workspace") {
    exactKeys(value, ["id", "relation", "kind", "workspace", "path", "digest"], "workspace representation")
    const parsedDigest = digest(value.digest, "representation digest")
    return { id: identifier(value.id, "representation ID"), relation: relation(value.relation), kind: "workspace" as const,
      workspace: identifier(value.workspace, "workspace ID"), path: relativePath(value.path), ...(parsedDigest === undefined ? {} : { digest: parsedDigest }) }
  }
  if (kind === "locator") {
    exactKeys(value, ["id", "relation", "kind", "locator", "digest"], "locator representation")
    const parsedDigest = digest(value.digest, "representation digest")
    return { id: identifier(value.id, "representation ID"), relation: relation(value.relation), kind: "locator" as const,
      locator: locator(value.locator), ...(parsedDigest === undefined ? {} : { digest: parsedDigest }) }
  }
  throw new Error("representation kind must be workspace or locator")
}

/** Strictly parse a portable binding document. Paths and workspace roots stay separate. */
export const parseResourceBindings = (input: unknown): ResourceBindings => {
  const value = object(contractSnapshot(input), "resource bindings")
  exactKeys(value, ["schema", "resources"], "resource bindings")
  if (value.schema !== RESOURCE_BINDINGS_SCHEMA || !Array.isArray(value.resources)) throw new Error(`resource bindings must use ${RESOURCE_BINDINGS_SCHEMA}`)
  const resources: BoundResource[] = []
  const resourceIds = new Set<string>(), representationIds = new Set<string>()
  if (value.resources.length > 1024) throw new Error("resource bindings exceed 1024 resources")
  for (const raw of value.resources) {
    const resource = object(raw, "resource")
    exactKeys(resource, ["id", "representations"], "resource")
    const id = resourceId(resource.id)
    if (resourceIds.has(id)) throw new Error(`duplicate resource ID: ${id}`)
    if (!Array.isArray(resource.representations) || resource.representations.length === 0 || resource.representations.length > 256) throw new Error(`resource ${id} requires 1..256 representations`)
    const representations = resource.representations.map(parseRepresentation)
    for (const representation of representations) {
      if (representationIds.has(representation.id)) throw new Error(`duplicate representation ID: ${representation.id}`)
      representationIds.add(representation.id)
    }
    resourceIds.add(id)
    resources.push(Object.freeze({ id, representations: Object.freeze(representations) }))
  }
  if (representationIds.size > 4096) throw new Error("resource bindings exceed 4096 representations")
  return freezeContract({ schema: RESOURCE_BINDINGS_SCHEMA, resources })
}

/** A caller must pick when one resource has several eligible representations. */
const parseSelection = (input: unknown): ResourceRepresentationSelection => {
  const value = object(contractSnapshot(input), "representation selection")
  exactKeys(value, ["resource", "representation"], "representation selection")
  const resource = resourceId(value.resource)
  if (value.representation !== undefined && typeof value.representation !== "string") throw new Error("representation selection ID must be a string")
  return freezeContract({ resource, ...(value.representation === undefined ? {} : { representation: identifier(value.representation, "representation selection ID") }) })
}
export const selectResourceRepresentation = (document: ResourceBindings, selection: ResourceRepresentationSelection): Readonly<{ resource: BoundResource; representation: ResourceRepresentation }> => {
  const captured = parseResourceBindings(document), requested = parseSelection(selection)
  const resource = captured.resources.find(candidate => candidate.id === requested.resource)
  if (!resource) throw new Error(`unknown resource: ${selection.resource}`)
  const matches = requested.representation === undefined ? resource.representations : resource.representations.filter(candidate => candidate.id === requested.representation)
  if (matches.length === 0) throw new Error(`unknown representation for resource ${resource.id}`)
  if (matches.length !== 1) throw new Error(`representation selection for resource ${resource.id} is ambiguous`)
  return freezeContract({ resource, representation: matches[0]! })
}

const beneath = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

/** Resolve only a previously selected representation against host-owned workspace roots. */
export const resolveResourceRepresentation = async (document: ResourceBindings, selection: ResourceRepresentationSelection,
  options: { readonly workspaces: Readonly<Record<string, string>>; readonly hostname?: string }): Promise<ResolvedResourceRepresentation> => {
  const capturedOptions = object(contractSnapshot(options), "resource resolution options")
  exactKeys(capturedOptions, ["workspaces", "hostname"], "resource resolution options")
  const workspaces = object(capturedOptions.workspaces, "workspaces")
  if (capturedOptions.hostname !== undefined && typeof capturedOptions.hostname !== "string") throw new Error("hostname must be a string")
  const selected = selectResourceRepresentation(document, selection), representation = selected.representation
  if (representation.kind === "locator") return Object.freeze({ resource: selected.resource.id, representation: representation.id, relation: representation.relation,
    kind: representation.kind, locator: representation.locator, ...(representation.digest === undefined ? {} : { expectedDigest: representation.digest }) })
  const configuredRoot = Object.hasOwn(workspaces, representation.workspace) ? workspaces[representation.workspace] : undefined
  if (typeof configuredRoot !== "string" || !configuredRoot) throw new Error(`workspace is not registered: ${representation.workspace}`)
  const root = await realpath(configuredRoot)
  if (!(await stat(root)).isDirectory()) throw new Error(`workspace root is not a directory: ${representation.workspace}`)
  const lexical = path.resolve(root, representation.path)
  if (!beneath(root, lexical)) throw new Error(`workspace representation escapes its root: ${representation.id}`)
  const candidate = await realpath(lexical)
  if (!beneath(root, candidate)) throw new Error(`workspace representation resolves outside its root: ${representation.id}`)
  const host = capturedOptions.hostname ?? os.hostname()
  const formatted = `file://${host}${candidate}`
  const parsed = parseLocator(formatted)
  if (Either.isLeft(parsed) || parsed.right.kind !== "filesystem" || parsed.right.host !== host ||
    parsed.right.path !== candidate || parsed.right.lineStart !== undefined) throw new Error(`workspace locator cannot be represented: ${representation.id}`)
  return Object.freeze({ resource: selected.resource.id, representation: representation.id, relation: representation.relation, kind: representation.kind,
    locator: formatLocator(parsed.right), path: candidate, relativePath: representation.path, ...(representation.digest === undefined ? {} : { expectedDigest: representation.digest }) })
}
