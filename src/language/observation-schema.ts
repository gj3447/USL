import { Schema } from "effect"
import { EndpointKind, GuaranteeLevel, KgLocator, Locator } from "../domain.js"

const text = Schema.String.pipe(Schema.minLength(1))
const identifier = Schema.String.pipe(Schema.pattern(/^[A-Za-z_][A-Za-z0-9_]*$/))
const digest = Schema.String.pipe(Schema.pattern(/^sha256:[a-f0-9]{64}$/))
const count = Schema.Number.pipe(Schema.filter((n) => Number.isSafeInteger(n) && n >= 0))
const timestamp = Schema.String.pipe(Schema.filter((s) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(s) && Number.isFinite(Date.parse(s))))
const participant = Schema.Struct({ role: identifier, resource: identifier })
const checkFields = { name: identifier, description: text, evidenceRoles: Schema.Array(identifier) }
const meaning = Schema.Struct({
  name: identifier,
  roles: Schema.Array(Schema.Struct({ name: identifier, kind: Schema.Literal("kg", "git_repo", "url", "filesystem", "any") })),
  description: text,
  grounded: Schema.optional(KgLocator),
  contract: Schema.optional(Schema.Struct({ scope: text, checks: Schema.Array(Schema.Struct(checkFields)) })),
})
export const ResolutionSchema = Schema.Struct({
  locator: Locator, resolvedLocator: text, contentHash: text, resolvedAt: timestamp,
  guaranteeLevel: GuaranteeLevel, matchCount: count,
})
export const ResolveFailureSchema = Schema.Struct({
  kind: EndpointKind, locator: text,
  reason: Schema.Literal("ORPHAN", "AMBIGUOUS", "IO", "DENIED"), detail: Schema.String,
})
const resource = Schema.Struct({
  name: identifier,
  locator: text,
  fingerprintScope: Schema.Literal("KG_METADATA", "RESOLVER_REPRESENTATION"),
  status: Schema.Literal("RESOLVES", "ORPHAN", "AMBIGUOUS", "DENIED"),
  resolution: Schema.NullOr(ResolutionSchema),
  issue: Schema.NullOr(Schema.Struct({ reason: Schema.Literal("ORPHAN", "AMBIGUOUS", "IO", "DENIED"), detail: Schema.String })),
})

/** Wire shape only. Cross-field consistency is checked separately in validateObservation. */
export const ProgramObservationSchema = Schema.Struct({
  schema: Schema.Literal("usl-program-observation/v2"),
  namespace: text,
  planDigest: digest, meaningsDigest: digest, sourceDigest: Schema.NullOr(digest),
  digestFormat: Schema.Literal("sha256:utf8:JSON.stringify/v1"),
  status: Schema.Literal("RESOLVES", "UNRESOLVED"),
  readScope: Schema.Struct({
    links: Schema.Array(identifier), allowedLocators: Schema.Array(text), requestedLocators: Schema.Array(text), resourceBudget: count,
  }),
  metrics: Schema.Struct({
    declaredResources: count, selectedResources: count, uniqueLocators: count, resolverCalls: count, deniedLocators: count,
  }),
  resources: Schema.Array(resource),
  groundings: Schema.Array(resource),
  meanings: Schema.Array(Schema.Struct({ name: identifier, digest, definition: meaning })),
  links: Schema.Array(Schema.Struct({
    name: identifier, meaning: identifier, participants: Schema.Array(participant),
    meaningDigest: digest, contractDigest: digest, resourcesResolve: Schema.Boolean,
    semanticTruth: Schema.Literal("NOT_EVALUATED"),
    verification: Schema.Array(Schema.Struct({
      ...checkFields, scope: text, evidence: Schema.Array(participant), evidenceAvailable: Schema.Boolean, status: Schema.Literal("NOT_EXECUTED"),
    })),
  })),
  semanticTruth: Schema.Literal("NOT_EVALUATED"),
  observationDigest: digest,
})
