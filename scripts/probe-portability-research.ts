/** Deterministic PT01 boundary observations; no filesystem, network, or restore action. */
import { checkPortableTransferManifest, createPortableTransferEnvelope, parsePortableTransferManifest } from "../src/addons/portable-transfer.js"
import { parseResourceBindings } from "../src/resource-bindings.js"

export interface PortabilityResearchProbe {
  readonly id: "observation:path-budget" | "observation:native-id-compatibility" | "observation:cross-manifest" | "observation:state-separation"
  readonly method: "PURE_RUNTIME_PROBE"
  readonly status: "OBSERVED"
  readonly localSourceIds: readonly string[]
  readonly result: string
  readonly scope: string
}

const owner = "urn:example:probe-owner", issuer = "urn:example:probe-issuer"
const identity = (nativeId: string) => ({ ownerNamespace: owner, nativeId })
const digest = (hex: string) => `sha256:${hex.repeat(64)}`
const fixture = (byteDigest = digest("a"), observedAt = "2026-10-03T00:00:00Z") => ({
  schema: "usl-portable-transfer/v1", ownerNamespace: owner, issuer, observedAt,
  resources: [identity("memory")],
  revisions: [{ id: "urn:example:probe-revision", resource: identity("memory"), kind: "CONTENT", parents: [], issuer }],
  representations: [{ id: "urn:example:probe-representation", revision: "urn:example:probe-revision", payloadPath: "payload/item", byteDigestAlgorithm: "SHA256_RAW_BYTES_V1", byteDigest, byteLength: 1 }],
  historyBoundary: { mode: "CLOSED_V1", externalParents: [] },
})
const must = (condition: unknown, message: string): void => { if (!condition) throw new Error(`portability research baseline changed: ${message}`) }

/** Re-run when a deliberate contract change changes any recorded observation. */
export const runPortabilityResearchProbes = (): readonly PortabilityResearchProbe[] => {
  const longComponent = "a".repeat(300), pathBudget = fixture()
  pathBudget.representations[0]!.payloadPath = longComponent
  must(parsePortableTransferManifest(pathBudget).representations[0]?.payloadPath.length === 300, "300-character component acceptance")

  const longNativeId = "n".repeat(300)
  must(parseResourceBindings({ schema: "usl-resource-bindings/v1", resources: [{ id: longNativeId, representations: [{ id: "local", relation: "snapshot", kind: "locator", locator: "https://example.test/resource" }] }] }).resources[0]?.id === longNativeId, "legacy 300-character ID acceptance")
  const portable = fixture(); portable.resources[0]!.nativeId = longNativeId; portable.revisions[0]!.resource = identity(longNativeId)
  let portableRejected = false
  try { parsePortableTransferManifest(portable) } catch { portableRejected = true }
  must(portableRejected, "portable v1 native ID budget")

  const first = parsePortableTransferManifest(fixture(digest("a"))), second = parsePortableTransferManifest(fixture(digest("b")))
  must(first.revisions[0]?.id === second.revisions[0]?.id && first.representations[0]?.byteDigest !== second.representations[0]?.byteDigest, "cross-manifest revision conflict remains unreconciled")

  const future = createPortableTransferEnvelope(fixture(digest("a"), "2099-01-01T00:00:00Z"))
  const checked = checkPortableTransferManifest(future, { expectedManifestDigest: future.manifestDigest, allowedOwnerNamespace: owner })
  must(checked.freshness === "UNKNOWN" && checked.payload === "NOT_CHECKED" && checked.authority === "NOT_GRANTED", "future declared time state separation")

  return Object.freeze([
    { id: "observation:path-budget", method: "PURE_RUNTIME_PROBE", status: "OBSERVED", localSourceIds: ["source:src/addons/portable-transfer.ts"], result: "ACCEPTS_300_CHARACTER_COMPONENT", scope: "Manifest parser only; no OS path creation or portability claim." },
    { id: "observation:native-id-compatibility", method: "PURE_RUNTIME_PROBE", status: "OBSERVED", localSourceIds: ["source:src/addons/portable-transfer.ts", "source:src/resource-bindings.ts"], result: "LEGACY_300_CHARACTER_ID_ACCEPTED_PORTABLE_V1_REJECTED", scope: "Current parser compatibility boundary; no truncation or migration is performed." },
    { id: "observation:cross-manifest", method: "PURE_RUNTIME_PROBE", status: "OBSERVED", localSourceIds: ["source:src/addons/portable-transfer.ts"], result: "CROSS_MANIFEST_REVISION_CONTENT_CONFLICT_NOT_RECONCILED", scope: "Independent manifests parse separately; this records an import/merge gap, not a parser defect." },
    { id: "observation:state-separation", method: "PURE_RUNTIME_PROBE", status: "OBSERVED", localSourceIds: ["source:src/addons/portable-transfer.ts"], result: "FUTURE_TIME_DOES_NOT_GRANT_FRESHNESS_OR_AUTHORITY", scope: "Manifest-only host check; payload remains unchecked and no execution or authority is requested." },
  ])
}
