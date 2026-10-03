/** Pure executable boundary probes for current graph interchange adapters; no standards-conformance claim. */
import assert from "node:assert/strict"
import { Either } from "effect"
import { checkResourceGraphProfile, type DomainProfile } from "../src/domain-profile.js"
import { adaptPropertyGraph } from "../src/integrations/property-graph.js"
import { parseResourceGraph, resourceGraphJsonLd, type ResourceGraph } from "../src/integrations/resource-graph.js"
import { planDigest } from "../src/language/digest.js"

export interface StandardsCoverageObservation {
  readonly id: string
  readonly method: "PURE_RUNTIME_PROBE" | "STATIC_CODE_INSPECTION"
  readonly status: "OBSERVED"
  readonly scope: string
  readonly result: string
  readonly sourcePaths: readonly string[]
}
export interface StandardsCoverageProbes {
  readonly observations: readonly StandardsCoverageObservation[]
  /** USL's JSON-LD declaration projection, not a direct assertion of expectedSourceTriple. */
  readonly rdfFixture: object
  readonly expectedSourceTriple: Readonly<{ subject: string; predicate: string; object: string }>
}

const source = "https://example.test/alice", target = "https://example.test/bob", predicate = "urn:example:knows"
const graph: ResourceGraph = {
  schema: "usl-resource-graph/v1",
  resources: [
    { id: source, types: ["urn:example:Person"], locator: source, metadata: { label: "Alice" } },
    { id: target, types: ["urn:example:Person"], locator: target, metadata: { label: "Bob" } },
    { id: "urn:example:evidence", types: ["urn:example:Evidence"], locator: "https://example.test/evidence" },
  ],
  meanings: [{ id: predicate, description: "A declared source predicate represented as a USL Meaning." }],
  links: [{ id: "urn:example:edge:knows-1", meaning: predicate, participants: [
    { role: "subject", resource: source }, { role: "object", resource: target }, { role: "evidence", resource: "urn:example:evidence" },
  ], metadata: { confidence: 0.7 } }],
}
const must: (value: unknown, detail: string) => void = (value, detail) => { if (!value) throw new Error(`standards coverage probe failed: ${detail}`) }
const raw = JSON.stringify(graph)

export const runStandardsCoverageProbes = (): StandardsCoverageProbes => {
  const parsed = Either.getOrThrow(parseResourceGraph(raw))
  const reparsed = Either.getOrThrow(parseResourceGraph(JSON.stringify(parsed)))
  assert.deepStrictEqual(parsed, graph, "resource graph parse must retain the full named n-ary structure")
  assert.deepStrictEqual(reparsed, parsed, "serialized parsed resource graph must reparse without structural change")
  must(parsed.links[0]?.participants.length === 3 && parsed.links[0]?.meaning === predicate, "named meaning/roles must round trip through grammar")

  const projection = Either.getOrThrow(resourceGraphJsonLd(raw, { namespace: "standards.probe" }))
  const rdfFixture = projection as { "@graph": Array<Record<string, unknown>> }
  const meaningNode = rdfFixture["@graph"].find(node => node["usl:nativeId"] === predicate)
  const linkNode = rdfFixture["@graph"].find(node => node["usl:nativeId"] === "urn:example:edge:knows-1")
  must(meaningNode?.["@type"] === "usl:Meaning" && Array.isArray(linkNode?.["usl:participant"]), "projection must expose Meaning and n-ary participants")
  must(!rdfFixture["@graph"].some(node => node["@id"] === source && node[predicate] === target), "projection must not invent a direct source predicate RDF triple")

  const jsonLdInput = JSON.stringify({ "@context": { ex: "urn:example:" }, "@id": source, "ex:knows": { "@id": target } })
  must(Either.isLeft(parseResourceGraph(jsonLdInput)), "general JSON-LD must not parse as USL resource graph input")
  must(Either.isLeft(parseResourceGraph("@prefix ex: <urn:example:> . ex:alice ex:knows ex:bob .")), "Turtle dataset must not parse as USL resource graph input")

  const profile: DomainProfile = { schema: "usl-domain-profile/v1", id: "urn:example:profile", version: "1", closedMeanings: false,
    meanings: [{ id: predicate, allowExtraRoles: true, roles: [
      { role: "subject", required: true, types: ["urn:example:Person"], metadata: [] },
      { role: "object", required: true, types: ["urn:example:Person"], metadata: [] },
    ] }] }
  const profileReport = checkResourceGraphProfile(parsed, profile)
  must(profileReport.status === "CONFORMS" && profileReport.checkedLinks === 1 && profileReport.semanticTruth === "NOT_EVALUATED", "custom profile must check only declared role/type subset")
  const metadataClaim = structuredClone(parsed)
  metadataClaim.resources[0]!.types = ["urn:example:Employee"]
  metadataClaim.resources[0]!.metadata = { declaredParentType: "urn:example:Person" }
  must(checkResourceGraphProfile(metadataClaim, profile).status === "VIOLATES", "domain profile must not infer a required type from resource metadata")

  const propertyRaw = JSON.stringify({ nodes: [
    { uid: "a", properties: { locator: source, ignoredLabel: "Alice" } }, { uid: "b", properties: { locator: target } },
  ], relations: [{ uid: "edge-42", from_uid: "a", to_uid: "b", type: "KNOWS", properties: { description: "edge-note" } }] })
  const lpg = Either.getOrThrow(adaptPropertyGraph(propertyRaw, { namespace: "standards.lpg" }))
  const lpgMeaning = lpg.plan.meanings[0]
  const lpgDescription = JSON.parse(lpgMeaning?.description ?? "null") as { type?: string; direction?: { from_uid?: string; to_uid?: string }; description?: string }
  must(lpg.source.adapter === "property-graph/v2" && lpg.identities.links["edge-42"] !== undefined && lpgDescription.type === "KNOWS" && lpgDescription.direction?.from_uid === "a" && lpgDescription.direction?.to_uid === "b" && lpgDescription.description === "edge-note", "LPG v2 must preserve edge identity, direction, and supported description property")
  const changedPropertyRaw = JSON.stringify({ nodes: [
    { uid: "a", properties: { locator: source, ignoredLabel: "Alicia", score: 99 } }, { uid: "b", properties: { locator: target } },
  ], relations: [{ uid: "edge-42", from_uid: "a", to_uid: "b", type: "KNOWS", properties: { description: "edge-note", weight: 0.1 } }] })
  const lpgChanged = Either.getOrThrow(adaptPropertyGraph(changedPropertyRaw, { namespace: "standards.lpg" }))
  must(planDigest(lpg.plan) === planDigest(lpgChanged.plan) && JSON.stringify(lpg.identities) === JSON.stringify(lpgChanged.identities) && lpg.source.digest !== lpgChanged.source.digest, "arbitrary LPG node/edge properties must remain source bytes only")

  const observations: readonly StandardsCoverageObservation[] = [
    { id: "observation:standards-nary-grammar", method: "PURE_RUNTIME_PROBE", status: "OBSERVED", sourcePaths: ["src/integrations/resource-graph.ts"], result: "USL_NAMED_NARY_LINK_ROLES_ROUNDTRIP", scope: "usl-resource-graph/v1 grammar only; not RDF triple parsing." },
    { id: "observation:standards-jsonld-projection", method: "PURE_RUNTIME_PROBE", status: "OBSERVED", sourcePaths: ["src/integrations/resource-graph.ts"], result: "JSONLD_DECLARATION_PROJECTION_WITH_LINK_MEANING_PARTICIPANTS", scope: "USL JSON-LD declaration projection only; does not assert source domain predicate directly." },
    { id: "observation:standards-rdf-input-boundary", method: "PURE_RUNTIME_PROBE", status: "OBSERVED", sourcePaths: ["src/integrations/resource-graph.ts"], result: "GENERAL_JSONLD_AND_TURTLE_REFUSED_AS_RESOURCE_GRAPH_INPUT", scope: "two concrete non-USL inputs only; not a broad RDF parser test." },
    { id: "observation:standards-profile-subset", method: "PURE_RUNTIME_PROBE", status: "OBSERVED", sourcePaths: ["src/domain-profile.ts", "src/integrations/resource-graph.ts"], result: "CUSTOM_ROLE_TYPE_PROFILE_SUBSET_CONFORMS_WITHOUT_METADATA_TO_TYPE_INFERENCE", scope: "owner-supplied USL role/type/metadata profile; resource metadata has no type-inference power and this is not generic SHACL validation." },
    { id: "observation:standards-lpg-v2", method: "PURE_RUNTIME_PROBE", status: "OBSERVED", sourcePaths: ["src/integrations/property-graph.ts"], result: "LPG_V2_EDGE_ID_DIRECTION_AND_DESCRIPTION_PROPERTY_PRESERVED_ARBITRARY_PROPERTIES_PROJECTED_OUT", scope: "read-only supplied property-graph JSON adaptation; arbitrary node/edge properties change source digest but not adapted plan or identities." },
    { id: "observation:standards-gql-boundary", method: "STATIC_CODE_INSPECTION", status: "OBSERVED", sourcePaths: ["src/integrations/property-graph.ts"], result: "NO_GQL_PARSER_OR_ENGINE_INVOKED_BY_THIS_ADAPTER", scope: "Static adapter-surface boundary only; this is not a broad absence proof or a GQL conformance test." },
  ]

  return Object.freeze({
    rdfFixture: projection,
    expectedSourceTriple: Object.freeze({ subject: source, predicate, object: target }),
    observations: Object.freeze(observations),
  })
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(runStandardsCoverageProbes(), null, 2))
