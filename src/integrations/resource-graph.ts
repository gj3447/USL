/** Open domain types over existing read transports; no database or endpoint IO. */
import { createHash } from "node:crypto"
import { Either } from "effect"
import { z } from "zod"
import { compileProgram } from "../language/compiler.js"
import { digestSource } from "../language/digest.js"
import { LanguageError, type Declaration } from "../language/model.js"
import type { AdaptedGraph } from "../adapters.js"
import { checkResourceGraphProfile, parseDomainProfile, type DomainProfile } from "../domain-profile.js"

const text = z.string().min(1).regex(/\S/u, "expected nonempty text")
const iri = z.string().regex(/^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|^`\\\u0000-\u001f\u007f]+$/u, "expected an absolute type IRI")
  .regex(/^(?:[^%]|%[A-Fa-f0-9]{2})+$/u, "invalid IRI percent escape")
const metadata = z.record(z.string(), z.json())
export const resourceGraphSchema = z.strictObject({
  schema: z.literal("usl-resource-graph/v1"),
  resources: z.array(z.strictObject({ id: text, types: z.array(iri).min(1), locator: text, metadata: metadata.optional() })).min(1),
  meanings: z.array(z.strictObject({ id: text, description: text })),
  links: z.array(z.strictObject({
    id: text, meaning: text,
    participants: z.array(z.strictObject({ role: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), resource: text })).min(1),
    metadata: metadata.optional(),
  })),
  provenance: z.strictObject({ sources: z.array(text), activity: text.optional(), agent: text.optional() }).optional(),
})
export type ResourceGraph = z.infer<typeof resourceGraphSchema>
export type ResourceGraphOptions = { readonly namespace: string; readonly profile?: DomainProfile }
const unwrap = <A, E>(value: Either.Either<A, E>): A => Either.getOrThrowWith(value, error => error)
const fail = (detail: string): never => { throw new LanguageError({ phase: "compile", detail }) }
const attempt = <T>(run: () => T): Either.Either<T, LanguageError> => Either.try({ try: run,
  catch: error => error instanceof LanguageError ? error : new LanguageError({ phase: "compile", detail: String(error) }) })
const named = (prefix: string, id: string) => `${prefix}_${createHash("sha256").update(id).digest("hex")}`
export const resourceDescriptorId = (id: string): string => `urn:usl:descriptor:${encodeURIComponent(id)}`
const unique = (ids: readonly string[], label: string) => { if (new Set(ids).size !== ids.length) fail(`duplicate ${label}`) }
const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
/** Canonical object keys, while retaining meaningful array order in owner metadata. */
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : value

export const parseResourceGraph = (raw: string): Either.Either<ResourceGraph, LanguageError> => attempt(() => {
  const graph = resourceGraphSchema.parse(JSON.parse(raw))
  unique(graph.resources.map(resource => resource.id), "resource ID")
  unique(graph.meanings.map(meaning => meaning.id), "meaning ID")
  unique([...graph.links.map(link => link.id), ...graph.resources.map(resource => resourceDescriptorId(resource.id))], "link/descriptor ID")
  const resources = new Set(graph.resources.map(resource => resource.id)), meanings = new Set(graph.meanings.map(meaning => meaning.id))
  for (const link of graph.links) {
    if (!meanings.has(link.meaning)) fail(`unknown meaning: ${link.meaning}`)
    unique(link.participants.map(participant => participant.role), `role in ${link.id}`)
    for (const participant of link.participants) if (!resources.has(participant.resource)) fail(`unknown resource: ${participant.resource}`)
  }
  for (const id of [...(graph.provenance?.sources ?? []), ...(graph.provenance?.activity ? [graph.provenance.activity] : []), ...(graph.provenance?.agent ? [graph.provenance.agent] : [])]) {
    if (!resources.has(id)) fail(`unknown provenance resource: ${id}`)
  }
  return freeze(graph)
})

/** Unary descriptor links keep domain metadata visible without inventing reachability. */
export const adaptResourceGraph = (raw: string, options: ResourceGraphOptions): Either.Either<AdaptedGraph, LanguageError> => attempt(() => {
  const graph = unwrap(parseResourceGraph(raw))
  const profile = options.profile === undefined ? undefined : parseDomainProfile(options.profile)
  const validation = profile === undefined ? undefined : checkResourceGraphProfile(graph, profile)
  if (validation?.status === "VIOLATES") fail(`domain profile violation: ${JSON.stringify(validation.issues)}`)
  const declarations: Declaration[] = []
  const resources: Record<string, string> = Object.create(null), links: Record<string, string> = Object.create(null)
  const addLink = (id: string, description: unknown, participants: ReadonlyArray<{ role: string; resource: string }>) => {
    const name = named("l", id), meaning = named("m", id)
    const ordered = [...participants].sort((a, b) => a.role < b.role ? -1 : a.role > b.role ? 1 : 0)
    declarations.push({ tag: "meaning", name: meaning, description: JSON.stringify(canonical(description)),
      roles: ordered.map(participant => ({ name: participant.role, kind: "any" })) })
    declarations.push({ tag: "link", name, meaning, participants: ordered.map(participant => ({ role: participant.role, resource: resources[participant.resource]! })) })
    links[id] = name
  }
  const sorted = <T extends { id: string }>(items: readonly T[]) => [...items].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  for (const resource of sorted(graph.resources)) {
    resources[resource.id] = named("r", resource.id)
    declarations.push({ tag: "resource", name: resources[resource.id]!, locator: resource.locator })
  }
  for (const resource of sorted(graph.resources)) addLink(resourceDescriptorId(resource.id), {
    schema: "usl-resource-description/v1", id: resource.id, types: [...new Set(resource.types)].sort(),
    metadata: resource.metadata ?? {}, provenance: graph.provenance ?? null,
    ...(validation === undefined ? {} : { domainProfile: { id: profile!.id, version: profile!.version, digest: validation.profileDigest } }),
  }, [{ role: "resource", resource: resource.id }])
  const meanings = new Map(graph.meanings.map(meaning => [meaning.id, meaning]))
  const descriptors = new Map(graph.resources.map(resource => [resource.id, {
    id: resource.id, types: [...new Set(resource.types)].sort(), metadata: resource.metadata ?? {},
  }]))
  for (const link of sorted(graph.links)) addLink(link.id, {
    schema: "usl-role-link/v1", meaning: meanings.get(link.meaning), metadata: link.metadata ?? {},
    ...(validation === undefined ? {} : { domainProfile: { id: profile!.id, version: profile!.version, digest: validation.profileDigest,
      checked: !validation.unprofiledLinks.includes(link.id), semanticTruth: "NOT_EVALUATED" } }),
    resources: [...new Set(link.participants.map(participant => participant.resource))].sort().map(id => descriptors.get(id)),
    provenance: graph.provenance ?? null,
  }, link.participants)
  const plan = unwrap(compileProgram({ languageVersion: "0.1", namespace: options.namespace, declarations }))
  return freeze({ plan, source: { adapter: "resource-graph/v1", digest: digestSource(raw) }, identities: { resources, links } })
})

/** JSON-LD 1.1 representation of declarations, never asserted domain entailments. */
export const resourceGraphJsonLd = (raw: string, options: ResourceGraphOptions): Either.Either<object, LanguageError> => attempt(() => {
  const graph = unwrap(parseResourceGraph(raw))
  // Also validate locators, namespace and compiler constraints on the exchange path.
  unwrap(adaptResourceGraph(raw, options))
  const validation = options.profile === undefined ? undefined : checkResourceGraphProfile(graph, options.profile)
  const id = (kind: string, native: string) => `urn:usl:${encodeURIComponent(options.namespace)}:${kind}:${encodeURIComponent(native)}`
  const ref = (kind: string, native: string) => ({ "@id": id(kind, native) })
  const snapshot = `urn:usl:source:${digestSource(raw).slice(7)}`
  const provenance = {
    "prov:wasDerivedFrom": [{ "@id": snapshot }, ...(graph.provenance?.sources ?? []).map(source => ref("resource", source))],
    ...(graph.provenance?.activity ? { "prov:wasGeneratedBy": ref("resource", graph.provenance.activity) } : {}),
    ...(graph.provenance?.agent ? { "prov:wasAttributedTo": ref("resource", graph.provenance.agent) } : {}),
  }
  return freeze({
    "@context": { usl: "urn:usl:vocab:", prov: "http://www.w3.org/ns/prov#" },
    "@graph": [
      { "@id": snapshot, "@type": "prov:Entity", "usl:sourceDigest": digestSource(raw) },
      ...(validation === undefined ? [] : [{ "@id": `urn:usl:profile:${validation.profileDigest.slice(7)}`, "@type": "usl:DomainProfile",
        "usl:profileDigest": validation.profileDigest, "usl:profile": { "@value": parseDomainProfile(options.profile), "@type": "@json" } }]),
      ...graph.resources.map(resource => ({ ...ref("resource", resource.id), "@type": ["usl:Resource", ...resource.types],
        "usl:nativeId": resource.id, "usl:locator": resource.locator,
        "usl:metadata": { "@value": resource.metadata ?? {}, "@type": "@json" } })),
      ...graph.meanings.map(meaning => ({ ...ref("meaning", meaning.id), "@type": "usl:Meaning", "usl:nativeId": meaning.id, "usl:description": meaning.description })),
      ...graph.links.map(link => ({ ...ref("link", link.id), "@type": ["usl:Link", "prov:Entity"], ...provenance,
        "usl:nativeId": link.id, "usl:status": "DECLARED", "usl:meaning": ref("meaning", link.meaning),
        ...(validation === undefined || validation.unprofiledLinks.includes(link.id) ? {} : {
          "usl:checkedAgainst": { "@id": `urn:usl:profile:${validation.profileDigest.slice(7)}` }, "usl:validationScope": "ROLE_TYPES_AND_METADATA" }),
        "usl:participant": link.participants.map(participant => ({ "@type": "usl:Participant", "usl:role": participant.role, "usl:resource": ref("resource", participant.resource) })),
        "usl:metadata": { "@value": link.metadata ?? {}, "@type": "@json" } })),
    ],
  })
})
