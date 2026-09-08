/** A transient view of a source owned by another system. USL stores no copy. */
import type { SemanticPlan } from "./language/model.js"

export interface AdaptedGraph {
  readonly plan: SemanticPlan
  readonly source: { readonly adapter: string; readonly digest: string }
  readonly identities: {
    readonly resources: Readonly<Record<string, string>>
    readonly links: Readonly<Record<string, string>>
  }
}

export interface AdapterResult<A = unknown> {
  readonly source: AdaptedGraph["source"]
  readonly identities: AdaptedGraph["identities"]
  readonly result: A
  readonly receipt: {
    readonly sourceDigest: string
    readonly planDigest: string
    readonly resultDigest: string
    readonly digest: string
  }
}
