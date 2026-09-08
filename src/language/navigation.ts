import { Data, Either } from "effect"
import { planDigest } from "./digest.js"
import type { SemanticPlan } from "./model.js"

type Resource = SemanticPlan["resources"][number]
type Meaning = SemanticPlan["meanings"][number]
type Link = SemanticPlan["links"][number]

export class NavigationError extends Data.TaggedError("NavigationError")<{
  readonly reason: "UNKNOWN_RESOURCE" | "INVALID_QUERY" | "INVALID_PLAN"
  readonly detail: string
}> { get message() { return `${this.reason}: ${this.detail}` } }

/** A query direction through named roles, never a semantic inverse or an operation. */
export interface RoleRoute {
  readonly meaning: string
  readonly enter: string
  readonly exit: string
}
export interface NavigationQuery {
  readonly focus: string
  readonly target?: string
  readonly routes?: ReadonlyArray<RoleRoute>
  readonly maxHops?: number
  readonly maxResources?: number
  readonly maxLinks?: number
  readonly maxVisits?: number
}
export interface NavigationLimits {
  readonly maxHops: number
  readonly maxResources: number
  readonly maxLinks: number
  readonly maxVisits: number
}
export const DEFAULT_NAVIGATION_LIMITS: NavigationLimits = Object.freeze({ maxHops: 2, maxResources: 64, maxLinks: 128, maxVisits: 1024 })
export const MAX_NAVIGATION_LIMITS: NavigationLimits = Object.freeze({ maxHops: 32, maxResources: 1000, maxLinks: 2000, maxVisits: 20000 })

export interface TraversalStep {
  readonly link: string
  readonly meaning: string
  readonly from: string
  readonly enteredRole: string
  readonly to: string
  readonly exitedRole: string
}
export interface ConnectionPath {
  readonly resource: string
  readonly steps: ReadonlyArray<TraversalStep>
}
export interface AgentContext {
  readonly schema: "usl-agent-context/v1"
  readonly namespace: string
  /** Digest of the supplied compiled plan JSON, not semantic equivalence or live data. */
  readonly planDigest: string
  readonly focus: string
  readonly routes: ReadonlyArray<RoleRoute> | null
  readonly resources: ReadonlyArray<Resource & { readonly distance: number | null }>
  readonly meanings: ReadonlyArray<Meaning>
  readonly links: ReadonlyArray<Link>
  readonly paths: ReadonlyArray<ConnectionPath>
  readonly target: {
    readonly resource: string
    readonly status: "FOUND" | "NOT_FOUND_IN_SCOPE" | "NOT_FOUND_WITHIN_LIMITS"
    readonly path: ConnectionPath | null
  } | null
  readonly coverage: {
    readonly scope: "SUPPLIED_PLAN_AND_ROUTES"
    readonly complete: boolean
    readonly limits: NavigationLimits
    readonly limitsReached: ReadonlyArray<keyof NavigationLimits>
    readonly visits: number
    readonly pathPolicy: "ONE_SHORTEST_WITNESS_PER_REACHED_RESOURCE"
  }
  readonly interpretation: {
    readonly traversal: "ROLE_INCIDENCE"
    readonly declarationStatus: "DECLARED"
    readonly semanticTruth: "NOT_EVALUATED"
    readonly reachability: "NOT_OBSERVED"
    readonly execution: "NOT_PLANNED"
  }
}

/** Pure navigation over a compiler-produced plan. Does not resolve or invoke resources.
 * Names are scoped by plan.namespace. All participants of an admitted link are retained;
 * distance=null denotes context only, not reachability under the requested routes.
 */
export const agentContext = (plan: SemanticPlan, query: NavigationQuery): Either.Either<AgentContext, NavigationError> => Either.try({
  try: () => {
    const fail = (reason: NavigationError["reason"], detail: string): never => { throw new NavigationError({ reason, detail }) }
    if (!query || typeof query !== "object") return fail("INVALID_QUERY", "a navigation query is required")
    const limit = (key: keyof NavigationLimits): number => {
      const value = query[key] === undefined ? DEFAULT_NAVIGATION_LIMITS[key] : query[key]
      const minimum = key === "maxHops" ? 0 : 1
      if (!Number.isSafeInteger(value) || value < minimum || value > MAX_NAVIGATION_LIMITS[key]) return fail("INVALID_QUERY", `${key} must be an integer in ${minimum}..${MAX_NAVIGATION_LIMITS[key]}`)
      return value
    }
    const limits: NavigationLimits = { maxHops: limit("maxHops"), maxResources: limit("maxResources"), maxLinks: limit("maxLinks"), maxVisits: limit("maxVisits") }
    const resources = new Map(plan.resources.map((r) => [r.name, r]))
    const meanings = new Map(plan.meanings.map((m) => [m.name, m]))
    if (!resources.has(query.focus)) return fail("UNKNOWN_RESOURCE", `focus ${query.focus} is not declared in ${plan.namespace}`)
    if (query.target !== undefined && !resources.has(query.target)) return fail("UNKNOWN_RESOURCE", `target ${query.target} is not declared in ${plan.namespace}`)
    if (query.routes !== undefined) {
      if (!Array.isArray(query.routes)) return fail("INVALID_QUERY", "routes must be an array")
      for (const route of query.routes) {
        if (!route || typeof route !== "object") return fail("INVALID_QUERY", "each route must specify meaning, enter and exit")
        const meaning = meanings.get(route.meaning)
        if (!meaning || route.enter === route.exit || !meaning.roles.some((r) => r.name === route.enter) || !meaning.roles.some((r) => r.name === route.exit)) {
          return fail("INVALID_QUERY", `route ${route.meaning}:${route.enter}:${route.exit} must use a declared meaning and two distinct roles`)
        }
      }
    }
    // An incidence index is linear in the supplied plan; no pairwise edge expansion.
    const incidence = new Map<string, Link[]>()
    for (const link of plan.links) {
      if (!meanings.has(link.meaning)) return fail("INVALID_PLAN", `${link.name}: unknown meaning`)
      for (const name of new Set(link.participants.map((p) => p.resource))) {
        if (!resources.has(name)) return fail("INVALID_PLAN", `${link.name}: unknown resource ${name}`)
        const existing = incidence.get(name)
        if (existing) existing.push(link)
        else incidence.set(name, [link])
      }
    }
    const transitions = (link: Link, at: string): TraversalStep[] => {
      const entries = link.participants.filter((p) => p.resource === at)
      const result = new Map<string, TraversalStep>()
      for (const destination of link.participants) {
        const entry = entries.find((p) => p.role !== destination.role && (query.routes === undefined || query.routes.some((route) => route.meaning === link.meaning && route.enter === p.role && route.exit === destination.role)))
        if (entry && !result.has(destination.resource)) result.set(destination.resource, { link: link.name, meaning: link.meaning, from: at, enteredRole: entry.role, to: destination.resource, exitedRole: destination.role })
      }
      return [...result.values()]
    }
    const retainedResources = new Map<string, Resource>([[query.focus, resources.get(query.focus)!]])
    const retainedLinks = new Map<string, Link>()
    const paths = new Map<string, ConnectionPath>([[query.focus, { resource: query.focus, steps: [] }]])
    const queue = [query.focus]
    const limitsReached = new Set<keyof NavigationLimits>()
    let visits = 0
    search: for (let i = 0; i < queue.length; i++) {
      const at = queue[i]!
      const currentPath = paths.get(at)!
      const depth = currentPath.steps.length
      for (const link of incidence.get(at) ?? []) {
        if (visits >= limits.maxVisits) { limitsReached.add("maxVisits"); break search }
        visits++
        const next = transitions(link, at)
        if (next.length === 0) continue
        if (depth === limits.maxHops) {
          if (!retainedLinks.has(link.name) || next.some((step) => !paths.has(step.to))) limitsReached.add("maxHops")
          continue
        }
        if (!retainedLinks.has(link.name)) {
          if (retainedLinks.size >= limits.maxLinks) { limitsReached.add("maxLinks"); continue }
          const names = [...new Set(link.participants.map((p) => p.resource))]
          if (retainedResources.size + names.filter((name) => !retainedResources.has(name)).length > limits.maxResources) {
            limitsReached.add("maxResources"); continue
          }
          // Admit the whole hyperedge atomically, including roles excluded by the route.
          retainedLinks.set(link.name, link)
          for (const name of names) if (!retainedResources.has(name)) retainedResources.set(name, resources.get(name)!)
        }
        for (const step of next) if (!paths.has(step.to)) {
          paths.set(step.to, { resource: step.to, steps: [...currentPath.steps, step] })
          queue.push(step.to)
        }
      }
    }
    const complete = limitsReached.size === 0
    const usedMeanings = new Set([...retainedLinks.values()].map((l) => l.meaning))
    const targetPath = query.target === undefined ? undefined : paths.get(query.target)
    const result: AgentContext = {
      schema: "usl-agent-context/v1", namespace: plan.namespace, planDigest: planDigest(plan), focus: query.focus, routes: query.routes ?? null,
      resources: [...retainedResources.values()].map((r) => ({ ...r, distance: paths.get(r.name)?.steps.length ?? null })),
      meanings: plan.meanings.filter((m) => usedMeanings.has(m.name)), links: [...retainedLinks.values()], paths: [...paths.values()],
      target: query.target === undefined ? null : { resource: query.target, status: targetPath ? "FOUND" : complete ? "NOT_FOUND_IN_SCOPE" : "NOT_FOUND_WITHIN_LIMITS", path: targetPath ?? null },
      coverage: { scope: "SUPPLIED_PLAN_AND_ROUTES", complete, limits, limitsReached: [...limitsReached], visits, pathPolicy: "ONE_SHORTEST_WITNESS_PER_REACHED_RESOURCE" },
      interpretation: { traversal: "ROLE_INCIDENCE", declarationStatus: "DECLARED", semanticTruth: "NOT_EVALUATED", reachability: "NOT_OBSERVED", execution: "NOT_PLANNED" },
    }
    // Agent consumers may annotate their context in JavaScript: never alias the plan/query.
    return structuredClone(result)
  },
  catch: (e) => e instanceof NavigationError ? e : new NavigationError({ reason: "INVALID_PLAN", detail: String(e) }),
})
