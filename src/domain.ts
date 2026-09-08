// USL v0.1 — domain types (SECONDARY_AI draft; canon = KG sym:Concept:usl).
// Every field is a flat Neo4j-compatible property so a record projects 1:1 into the KG.
// KG: sym:Concept:usl, sym:UserVerdict:usl-develop-longinus-minimal-unit-2026-09-07
import { Schema } from "effect"

export const EndpointKind = Schema.Literal("kg", "url", "git_repo", "filesystem")
export type EndpointKind = typeof EndpointKind.Type

export const Confidence = Schema.Literal("EXTRACTED", "INFERRED", "AMBIGUOUS") // Longinus v3.2 3-tier
export type Confidence = typeof Confidence.Type
export const GuaranteeLevel = Schema.Literal("pure", "sandboxed", "trust_host") // Longinus v3.4
export type GuaranteeLevel = typeof GuaranteeLevel.Type
export const LinkStatus = Schema.Literal("RESOLVES", "DRIFT", "ORPHAN_FROM", "ORPHAN_TO", "AMBIGUOUS") // SKILL v4 status, endpoint-neutral
export type LinkStatus = typeof LinkStatus.Type
export const Direction = Schema.Literal("directed", "undirected") // OQ-B.3 open — caller decides per link
export type Direction = typeof Direction.Type

// ---- Locators (L1 Address Indirection generalised over the four user-named endpoint kinds)
export const KgLocator = Schema.Struct({
  kind: Schema.Literal("kg"),
  source: Schema.String, // KG instance id, e.g. canonical-neo4j / airo-kg (kg↔kg across instances)
  uid: Schema.String,
})
export const UrlLocator = Schema.Struct({ kind: Schema.Literal("url"), href: Schema.String })
export const GitLocator = Schema.Struct({
  kind: Schema.Literal("git_repo"),
  repo: Schema.String, // scheme-less host/org/name (identity), never a branch name
  commit: Schema.optional(Schema.String), // absent => repository HEAD observation; present => pinned revision
  path: Schema.optional(Schema.String), // absent => repository, present => file at commit
  symbol: Schema.optional(Schema.String), // SCIP-style stable symbol; absent => AMBIGUOUS-leaning
  lineStart: Schema.optional(Schema.Number),
  lineEnd: Schema.optional(Schema.Number),
})
export const FsLocator = Schema.Struct({
  kind: Schema.Literal("filesystem"),
  host: Schema.String, // fleet has many hosts → host is part of identity
  path: Schema.String, // absolute
  lineStart: Schema.optional(Schema.Number),
  lineEnd: Schema.optional(Schema.Number),
})
export const Locator = Schema.Union(KgLocator, UrlLocator, GitLocator, FsLocator)
export type Locator = typeof Locator.Type
export type KgLocator = typeof KgLocator.Type
export type UrlLocator = typeof UrlLocator.Type
export type GitLocator = typeof GitLocator.Type
export type FsLocator = typeof FsLocator.Type

// ---- Resolution of one endpoint at one instant (L2 Lifetime/Scope + content hash)
export interface Resolution {
  readonly locator: Locator
  readonly resolvedLocator: string // canonical string after redirects / realpath / full sha
  readonly contentHash: string // sha256 hex of the representation (or line slice)
  readonly resolvedAt: string // ISO-8601
  readonly guaranteeLevel: GuaranteeLevel
  readonly matchCount: number // kg: uid_match_count; others: 1
}

// ---- The USL record — candidate shape (THEORY/LONGINUS/USL_UNIVERSAL_SEMANTIC_LINK_2026-09-07.md §5.1)
export const UslRecord = Schema.Struct({
  link_id: Schema.String.pipe(Schema.filter((s) => s.trim().length > 0)), // L4 Sinn
  semantic_relation: Schema.String.pipe(Schema.filter((s) => s.trim().length > 0)),
  from_endpoint_kind: EndpointKind,
  from_locator: Schema.String,
  to_endpoint_kind: EndpointKind,
  to_locator: Schema.String,
  direction: Direction,
  resolved_at_from: Schema.NullOr(Schema.String),
  resolved_at_to: Schema.NullOr(Schema.String),
  resolved_locator_from: Schema.NullOr(Schema.String),
  resolved_locator_to: Schema.NullOr(Schema.String),
  pierced_at: Schema.String,
  audited_at: Schema.optional(Schema.NullOr(Schema.String)), // v0.2: observation time, separate from baseline
  drift_detected_at: Schema.NullOr(Schema.String),
  drift_score: Schema.Number.pipe(Schema.between(0, 1)), // endpoint change fraction, not GED
  content_hash_from: Schema.NullOr(Schema.String),
  content_hash_to: Schema.NullOr(Schema.String),
  confidence: Confidence,
  guarantee_level: GuaranteeLevel,
  status: LinkStatus,
  provenance_actor: Schema.String,
  provenance_tool_version: Schema.String,
  provenance_command: Schema.String,
  provenance_date: Schema.String,
  hswm_owner_ref: Schema.NullOr(Schema.String), // OQ-D.3 — placeholder only
})
export type UslRecord = typeof UslRecord.Type

export const TOOL_VERSION = "usl/0.3.0"
