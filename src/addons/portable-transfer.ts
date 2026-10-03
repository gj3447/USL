/** Pure, bounded portable-transfer v1 contract.  It neither reads payloads nor moves them. */
import { z } from "zod"
import { contractDigest, contractHash, contractIri, contractSnapshot, contractText, freezeContract } from "../contract-core.js"

export const PORTABLE_TRANSFER_SCHEMA = "usl-portable-transfer/v1" as const
export const PORTABLE_TRANSFER_ENVELOPE_SCHEMA = "usl-portable-transfer-envelope/v1" as const
export const CONTRACT_DIGEST_ALGORITHM = "USL_CONTRACT_SHA256_V1" as const
export const RAW_BYTES_DIGEST_ALGORITHM = "SHA256_RAW_BYTES_V1" as const

const id = contractIri.max(512)
const nativeId = contractText.max(256).regex(/^[^\u0000-\u001f\u007f-\u009f]+$/u, "native ID cannot contain control characters")
const path = z.string().min(1).max(1024)
const hash = contractHash
const declaredUtcTime = z.iso.datetime({ offset: false })
/** Owner namespace plus a native resource ID; this is portable identity, never a path. */
export const portableResourceIdentitySchema = z.object({ ownerNamespace: contractIri, nativeId }).strict()
const resourceSchema = portableResourceIdentitySchema.extend({ derivedFrom: portableResourceIdentitySchema.optional() }).strict()
const revisionSchema = z.object({ id, resource: portableResourceIdentitySchema, kind: z.enum(["CONTENT", "TOMBSTONE"]), parents: z.array(id).max(64), issuer: id }).strict()
const representationSchema = z.object({ id, revision: id, payloadPath: path, byteDigestAlgorithm: z.literal(RAW_BYTES_DIGEST_ALGORITHM), byteDigest: hash, byteLength: z.number().int().min(0).max(2 ** 53 - 1) }).strict()
/** Declared, unverified descriptor pins for omitted ancestors; never payload-byte evidence. */
const boundarySchema = z.object({ mode: z.literal("CLOSED_V1"), externalParents: z.array(z.object({ revision: id, resource: portableResourceIdentitySchema, digestAlgorithm: z.literal(CONTRACT_DIGEST_ALGORITHM), digest: hash }).strict()).max(1024) }).strict()

/** Exported Zod schema is JSON-schema-able; semantic/reference checks are in parsePortableTransferManifest. */
/** observedAt is declared observation metadata, never a latest-revision assertion. */
export const portableTransferManifestSchema = z.object({
  schema: z.literal(PORTABLE_TRANSFER_SCHEMA), ownerNamespace: contractIri, issuer: id, observedAt: declaredUtcTime,
  resources: z.array(resourceSchema).min(1).max(1024), revisions: z.array(revisionSchema).min(1).max(4096),
  representations: z.array(representationSchema).max(4096), historyBoundary: boundarySchema,
}).strict()
export const portableTransferEnvelopeSchema = z.object({
  schema: z.literal(PORTABLE_TRANSFER_ENVELOPE_SCHEMA), bodyDigestAlgorithm: z.literal(CONTRACT_DIGEST_ALGORITHM),
  manifestDigest: hash, manifest: portableTransferManifestSchema,
}).strict()

export type PortableTransferManifest = Readonly<z.infer<typeof portableTransferManifestSchema>>
export type PortableTransferEnvelope = Readonly<z.infer<typeof portableTransferEnvelopeSchema>>
export interface PortableTransferHostCheck {
  readonly expectedManifestDigest: string
  readonly allowedOwnerNamespace: string
}
export interface PortableTransferManifestCheck {
  readonly manifestDigest: string
  readonly ownerNamespace: string
  readonly manifest: "CHECKED"
  readonly payload: "NOT_CHECKED"
  readonly freshness: "UNKNOWN"
  readonly authority: "NOT_GRANTED"
  readonly execution: "NOT_REQUESTED"
}

const exact = <T>(schema: z.ZodType<T>, value: unknown, label: string, maxBytes = 2 * 1024 * 1024): T => {
  const result = schema.safeParse(contractSnapshot(value, maxBytes))
  if (!result.success) throw new Error(`invalid ${label}: ${result.error.issues[0]?.message ?? "schema"}`)
  return result.data
}
const unique = (values: readonly string[], label: string) => {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${label}`)
}
/** Internal comparison key only; manifests always expose resource identities as objects. */
export const portableResourceIdentityKey = (value: z.infer<typeof portableResourceIdentitySchema>): string => `${value.ownerNamespace}\u0000${value.nativeId}`
const safePayloadPath = (value: string): string => {
  if (value.includes("\\") || value.startsWith("/") || /^([A-Za-z]:|\/\/)/u.test(value)) throw new Error("payload path must be portable relative path")
  const parts = value.split("/")
  if (parts.some(part => !/^[A-Za-z0-9._-]+$/u.test(part) || /[. ]$/u.test(part) || /^(con|prn|aux|nul|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu.test(part))) throw new Error("unsafe portable ASCII payload path")
  return value
}
const graphIsAcyclic = (revisions: readonly z.infer<typeof revisionSchema>[], external: Set<string>) => {
  const byId = new Map(revisions.map(revision => [revision.id, revision]))
  const states = new Map<string, "ACTIVE" | "DONE">()
  for (const start of revisions) {
    if (states.get(start.id) === "DONE") continue
    const stack: Array<readonly [string, boolean]> = [[start.id, false]]
    while (stack.length) {
      const [revision, leaving] = stack.pop()!
      if (external.has(revision) || states.get(revision) === "DONE") continue
      if (leaving) { states.set(revision, "DONE"); continue }
      if (states.get(revision) === "ACTIVE") throw new Error("revision parent cycle")
      const item = byId.get(revision); if (!item) throw new Error(`unclosed parent revision: ${revision}`)
      states.set(revision, "ACTIVE"); stack.push([revision, true])
      for (const parent of item.parents) {
        if (external.has(parent) || states.get(parent) === "DONE") continue
        if (states.get(parent) === "ACTIVE") throw new Error("revision parent cycle")
        stack.push([parent, false])
      }
    }
  }
}

/** Validate only manifest structure and references.  Payload bytes remain outside this contract. */
export const parsePortableTransferManifest = (input: unknown): PortableTransferManifest => {
  const manifest = exact(portableTransferManifestSchema, input, "portable transfer manifest")
  if (manifest.resources.some(resource => resource.ownerNamespace !== manifest.ownerNamespace)) throw new Error("resource owner namespace differs from manifest")
  unique(manifest.resources.map(portableResourceIdentityKey), "owner-scoped native resource identity")
  unique(manifest.revisions.map(revision => revision.id), "revision ID")
  unique(manifest.representations.map(representation => representation.id), "representation ID")
  unique([...manifest.revisions.map(revision => revision.id), ...manifest.representations.map(representation => representation.id), ...manifest.historyBoundary.externalParents.map(parent => parent.revision)], "global revision/representation/boundary ID")
  const foldedPaths = manifest.representations.map(representation => safePayloadPath(representation.payloadPath).toLowerCase())
  unique(foldedPaths, "payload path collision")
  const resourceKeys = new Set(manifest.resources.map(portableResourceIdentityKey))
  const revisionById = new Map(manifest.revisions.map(revision => [revision.id, revision]))
  const external = new Map(manifest.historyBoundary.externalParents.map(parent => [parent.revision, parent]))
  unique(manifest.historyBoundary.externalParents.map(parent => parent.revision), "history boundary parent")
  const derived = new Map<string, string>()
  for (const resource of manifest.resources) if (resource.derivedFrom !== undefined) {
    const current = portableResourceIdentityKey(resource), parent = portableResourceIdentityKey(resource.derivedFrom)
    if (!resourceKeys.has(parent) || current === parent) throw new Error("fork derivedFrom must name a distinct in-manifest resource")
    derived.set(current, parent)
  }
  const derivedStates = new Map<string, "ACTIVE" | "DONE">()
  for (const item of manifest.resources) {
    const stack: Array<readonly [string, boolean]> = [[portableResourceIdentityKey(item), false]]
    while (stack.length) {
      const [resource, leaving] = stack.pop()!
      if (derivedStates.get(resource) === "DONE") continue
      if (leaving) { derivedStates.set(resource, "DONE"); continue }
      if (derivedStates.get(resource) === "ACTIVE") throw new Error("fork derivedFrom cycle")
      derivedStates.set(resource, "ACTIVE"); stack.push([resource, true])
      const parent = derived.get(resource)
      if (parent !== undefined) { if (derivedStates.get(parent) === "ACTIVE") throw new Error("fork derivedFrom cycle"); stack.push([parent, false]) }
    }
  }
  for (const revision of manifest.revisions) {
    const revisionResource = portableResourceIdentityKey(revision.resource)
    if (!resourceKeys.has(revisionResource)) throw new Error(`unknown resource for revision: ${revision.id}`)
    unique(revision.parents, `parent revision for ${revision.id}`)
    for (const parentId of revision.parents) {
      const parent = revisionById.get(parentId)
      const parentResource = parent === undefined ? external.get(parentId)?.resource : parent.resource
      if (revision.kind === "TOMBSTONE" && (parentResource === undefined || portableResourceIdentityKey(parentResource) !== revisionResource)) throw new Error("tombstone parents must withdraw the same resource")
      if (parentResource !== undefined && portableResourceIdentityKey(parentResource) !== revisionResource) {
        const resource = manifest.resources.find(item => portableResourceIdentityKey(item) === revisionResource)!
        if (resource.derivedFrom === undefined || portableResourceIdentityKey(resource.derivedFrom) !== portableResourceIdentityKey(parentResource)) throw new Error("cross-resource parent requires explicit fork derivedFrom")
      }
      if (parent === undefined && !external.has(parentId)) throw new Error("parent revision outside CLOSED_V1 boundary")
    }
    if (revision.kind === "TOMBSTONE" && revision.parents.length === 0) throw new Error("tombstone needs a withdrawn parent revision")
  }
  const referencedExternal = new Set(manifest.revisions.flatMap(revision => revision.parents.filter(parent => !revisionById.has(parent))))
  for (const [parentId] of external) if (revisionById.has(parentId) || !referencedExternal.has(parentId)) throw new Error("history boundary must only pin referenced absent parents")
  graphIsAcyclic(manifest.revisions, new Set(external.keys()))
  const representationByRevision = new Map<string, number>()
  for (const representation of manifest.representations) {
    const revision = revisionById.get(representation.revision)
    if (!revision) throw new Error("representation references unknown revision")
    if (revision.kind !== "CONTENT") throw new Error("tombstone cannot have live content representation")
    representationByRevision.set(revision.id, (representationByRevision.get(revision.id) ?? 0) + 1)
  }
  const files = new Set(foldedPaths)
  for (const path of foldedPaths) {
    const parts = path.split("/")
    for (let index = 1; index < parts.length; index++) if (files.has(parts.slice(0, index).join("/"))) throw new Error("payload file/directory path collision")
  }
  for (const revision of manifest.revisions) if (revision.kind === "CONTENT" && !representationByRevision.has(revision.id)) throw new Error("content revision needs a representation")
  return freezeContract(manifest)
}

export const createPortableTransferEnvelope = (input: unknown): PortableTransferEnvelope => {
  const manifest = parsePortableTransferManifest(input)
  return freezeContract({ schema: PORTABLE_TRANSFER_ENVELOPE_SCHEMA, bodyDigestAlgorithm: CONTRACT_DIGEST_ALGORITHM, manifestDigest: contractDigest(manifest), manifest })
}
export const parsePortableTransferEnvelope = (input: unknown): PortableTransferEnvelope => {
  // Leave room for the fixed envelope around a manifest at its own byte limit.
  const envelope = exact(portableTransferEnvelopeSchema, input, "portable transfer envelope", 2 * 1024 * 1024 + 1024)
  const manifest = parsePortableTransferManifest(envelope.manifest)
  if (envelope.manifestDigest !== contractDigest(manifest)) throw new Error("manifest digest mismatch")
  return freezeContract({ ...envelope, manifest })
}
/** Host policy is caller-supplied and checks no bytes, freshness, credentials, or authority grant. */
export const checkPortableTransferManifest = (input: unknown, host: PortableTransferHostCheck): PortableTransferManifestCheck => {
  const envelope = parsePortableTransferEnvelope(input)
  if (host.expectedManifestDigest !== envelope.manifestDigest || host.allowedOwnerNamespace !== envelope.manifest.ownerNamespace) throw new Error("portable transfer host policy mismatch")
  return freezeContract({ manifestDigest: envelope.manifestDigest, ownerNamespace: envelope.manifest.ownerNamespace, manifest: "CHECKED", payload: "NOT_CHECKED", freshness: "UNKNOWN", authority: "NOT_GRANTED", execution: "NOT_REQUESTED" })
}
