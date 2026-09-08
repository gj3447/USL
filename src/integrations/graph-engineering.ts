import { createHash } from "node:crypto"
import { Data, Either } from "effect"
import { isDeepStrictEqual } from "node:util"
import { parseLocator } from "../locator.js"
import { compileProgram } from "../language/compiler.js"
import { digestSource } from "../language/digest.js"
import type { Program, SemanticPlan } from "../language/model.js"

export class GraphEngineeringError extends Data.TaggedError("GraphEngineeringError")<{ readonly detail: string }> {
  get message() { return this.detail }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type ObjectValue = Record<string, unknown>
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
const fail = (detail: string): never => { throw new GraphEngineeringError({ detail }) }
const clone = <A>(value: A): A => structuredClone(value)

/**
 * GEIP's declared `jcs-like-json-v1`, deliberately distinct from USL digestJson.
 * Raw JSON inputs retain numeric lexemes so float-vs-integer semantics match the
 * draft Python canonicalizer. Object inputs have already lost those lexemes and
 * are deliberately restricted to safe integers.
 */
type NumberLexemes = WeakMap<object, Map<string, string>>
type OmitProperty = (path: ReadonlyArray<string>, key: string) => boolean
const renderPythonNumber = (value: number, raw: string | undefined): string => {
  if (!Number.isFinite(value) || Object.is(value, -0)) fail("GEIP canonical JSON forbids non-finite numbers and negative zero")
  if (raw === undefined) {
    if (!Number.isSafeInteger(value)) fail("object GraphSpec input accepts only safe integer JSON numbers; pass raw JSON text for floats")
    return JSON.stringify(value)
  }
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) fail("invalid raw JSON number")
  if (!/[.eE]/.test(raw)) {
    if (!Number.isSafeInteger(value)) fail("GEIP raw integer exceeds JavaScript safe integer range")
    return JSON.stringify(value)
  }
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) fail("GEIP raw float is an unsafe integer")
  const absolute = Math.abs(value)
  if (absolute !== 0 && (absolute < 1e-4 || absolute >= 1e16)) {
    const [mantissa, exponent] = value.toExponential().split("e")
    const sign = exponent![0] === "-" ? "-" : "+"
    const digits = exponent!.slice(1).padStart(2, "0")
    return `${mantissa}e${sign}${digits}`
  }
  const fixed = JSON.stringify(value)
  return Number.isInteger(value) ? `${fixed}.0` : fixed
}
const canonicalJson = (value: Json, path: ReadonlyArray<string>, lexemes?: NumberLexemes, parent?: object, key?: string, omit?: OmitProperty): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number") return renderPythonNumber(value, parent === undefined || key === undefined ? undefined : lexemes?.get(parent)?.get(key))
  if (Array.isArray(value)) return `[${value.map((item, index) => canonicalJson(item, [...path, String(index)], lexemes, value, String(index), omit)).join(",")}]`
  return `{${Object.keys(value).sort().filter((key) => !omit?.(path, key)).map((key) => {
    if (!/^[\x20-\x7e]+$/.test(key)) fail("GEIP adapter accepts only ASCII object keys")
    return `${JSON.stringify(key)}:${canonicalJson(value[key]! as Json, [...path, key], lexemes, value, key, omit)}`
  }).join(",")}}`
}
export const graphEngineeringCanonicalJson = (value: Json): string => canonicalJson(value, [])
export const graphEngineeringDigest = (value: unknown): string => createHash("sha256").update(graphEngineeringCanonicalJson(value as Json)).digest("hex")
const graphEngineeringDigestWith = (value: unknown, lexemes?: NumberLexemes, omit?: OmitProperty): string => createHash("sha256").update(canonicalJson(value as Json, [], lexemes, undefined, undefined, omit)).digest("hex")
const graphEngineeringComponentDigest = (component: string, value: unknown, lexemes?: NumberLexemes): string => createHash("sha256").update(canonicalJson(value as Json, [component], lexemes)).digest("hex")

export interface GraphEngineeringSource {
  readonly document: Readonly<ObjectValue>
  /** Exact raw GraphSpec JSON when supplied; preserves float/integer lexemes. */
  readonly sourceText?: string
  readonly graphId: string
  readonly graphVersion: string
  readonly authority: Readonly<ObjectValue>
  readonly identity: Readonly<ObjectValue>
  readonly topology: { readonly nodes: ReadonlyArray<Readonly<ObjectValue>>; readonly edges: ReadonlyArray<Readonly<ObjectValue>> }
  readonly evidence: Readonly<ObjectValue>
  readonly graphspecDigest: string
}
export interface GraphSourceBinding { readonly resource: string; readonly locator: string; readonly text: string }
export interface GraphNodeBinding { readonly nodeId: string; readonly resource: string; readonly locator: string }
export interface GraphEvidenceBinding { readonly reference: string; readonly resource: string; readonly locator: string }
export interface GraphEngineeringBindings { readonly source: GraphSourceBinding; readonly nodes?: ReadonlyArray<GraphNodeBinding>; readonly evidence?: ReadonlyArray<GraphEvidenceBinding> }
export interface GraphEngineeringPlan {
  readonly schema: "usl-graph-engineering-plan/v1"
  readonly usl: SemanticPlan
  readonly graph: { readonly graphId: string; readonly graphVersion: string; readonly apiVersion: string; readonly authority: Readonly<ObjectValue>; readonly identity: Readonly<ObjectValue>; readonly graphspecDigest: string; readonly sourceLocator: string; readonly sourceDigest: string }
  readonly topology: GraphEngineeringSource["topology"]
  readonly evidence: Readonly<ObjectValue>
  readonly bindings: { readonly nodes: ReadonlyArray<GraphNodeBinding>; readonly evidence: ReadonlyArray<GraphEvidenceBinding>; readonly unboundNodeIds: ReadonlyArray<string>; readonly unboundEdgeIds: ReadonlyArray<string> }
  readonly guarantees: { readonly structure: "DECLARED_FROM_GRAPHSPEC"; readonly geipValidation: "NOT_RUN"; readonly execution: "NOT_EXECUTED" }
}

const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
const componentHashes = (document: ObjectValue, identity: ObjectValue, lexemes?: NumberLexemes) => {
  const required: ReadonlyArray<readonly [string, string]> = [
    ["topology_sha256", "topology"], ["lifecycle_sha256", "lifecycle"],
    ["loop_policy_sha256", "loop"], ["effect_policy_sha256", "effects"],
  ]
  for (const [hashField, component] of required) {
    if (!hash(identity[hashField])) fail(`GraphSpec identity.${hashField} is required`)
    if (identity[hashField] !== graphEngineeringComponentDigest(component, document[component] ?? {}, lexemes)) fail(`GraphSpec identity.${hashField} mismatch`)
  }
  const lifecycle = document.lifecycle
  if (!object(lifecycle) || !hash(lifecycle.machine_sha256)) fail("GraphSpec lifecycle.machine_sha256 is required")
  const checkedLifecycle = lifecycle as ObjectValue
  if (checkedLifecycle.machine_sha256 !== graphEngineeringDigestWith(checkedLifecycle, lexemes, (path, key) => path.length === 0 && key === "machine_sha256")) fail("GraphSpec lifecycle.machine_sha256 mismatch")
}

const parseRawGraphSpec = (sourceText: string): { readonly document: ObjectValue; readonly lexemes: NumberLexemes } => {
  const lexemes: NumberLexemes = new WeakMap()
  const document = JSON.parse(sourceText, function (this: object, key: string, value: unknown) {
    const context = arguments[2] as { readonly source?: unknown } | undefined
    if (typeof value === "number") {
      const rawNumber = context?.source
      if (typeof rawNumber !== "string") fail("Node JSON raw-number context is required for GraphSpec text")
      const checkedRawNumber = rawNumber as string
      let values = lexemes.get(this)
      if (!values) { values = new Map(); lexemes.set(this, values) }
      values.set(key, checkedRawNumber)
    }
    return value
  })
  if (!object(document)) fail("GEIP v0alpha1 GraphSpec is required")
  return { document, lexemes }
}

export const parseGraphEngineeringSource = (input: unknown): Either.Either<GraphEngineeringSource, GraphEngineeringError> => Either.try({
  try: () => {
    const raw = typeof input === "string" ? input : undefined
    const parsed = raw === undefined ? { document: structuredClone(input) as ObjectValue, lexemes: undefined } : parseRawGraphSpec(raw)
    const document = parsed.document
    if (!object(document)) fail("GEIP v0alpha1 GraphSpec is required")
    if (document.apiVersion !== "symposium.graphspec/v0alpha1" || document.kind !== "GraphSpec") fail("GEIP v0alpha1 GraphSpec is required")
    const metadata = document.metadata, authority = document.authority, identity = document.identity, topology = document.topology, evidence = document.evidence
    if (!object(metadata) || !text(metadata.graph_id) || !text(metadata.graph_version)) fail("GraphSpec metadata.graph_id and graph_version are required")
    if (!object(authority) || !object(identity) || !object(topology) || !object(evidence)) fail("GraphSpec authority, identity, topology and evidence are required")
    const checkedMetadata = metadata as ObjectValue, checkedAuthority = authority as ObjectValue, checkedIdentity = identity as ObjectValue, checkedTopology = topology as ObjectValue, checkedEvidence = evidence as ObjectValue
    if (!Array.isArray(checkedTopology.nodes) || !Array.isArray(checkedTopology.edges)) fail("GraphSpec topology nodes and edges are required")
    if (checkedIdentity.canonicalizer !== "jcs-like-json-v1;graphspec_sha256-omitted") fail("unsupported GraphSpec identity.canonicalizer")
    componentHashes(document, checkedIdentity, parsed.lexemes)
    const declared = checkedIdentity.graphspec_sha256
    if (!hash(declared)) fail("GraphSpec identity.graphspec_sha256 is required")
    const actual = graphEngineeringDigestWith(document, parsed.lexemes, (path, key) => path.length === 1 && path[0] === "identity" && key === "graphspec_sha256")
    if (actual !== declared) fail(`GraphSpec graphspec_sha256 mismatch: expected ${declared}, got ${actual}`)
    return { document: clone(document), ...(raw === undefined ? {} : { sourceText: raw }), graphId: checkedMetadata.graph_id as string, graphVersion: checkedMetadata.graph_version as string, authority: clone(checkedAuthority), identity: clone(checkedIdentity), topology: { nodes: clone(checkedTopology.nodes) as ObjectValue[], edges: clone(checkedTopology.edges) as ObjectValue[] }, evidence: clone(checkedEvidence), graphspecDigest: declared as string }
  },
  catch: (error) => error instanceof GraphEngineeringError ? error : new GraphEngineeringError({ detail: String(error) }),
})

const identifier = (value: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
const stableIdentifier = (prefix: string, value: string) => `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 16)}`
const requireLocator = (locator: string, field: string) => { if (!text(locator) || Either.isLeft(parseLocator(locator))) fail(`${field} must be a USL locator`) }
const evidenceReferences = (evidence: ObjectValue): string[] => {
  const refs: string[] = []
  if (object(evidence.cloudevents) && text(evidence.cloudevents.mapping_ref)) refs.push(evidence.cloudevents.mapping_ref)
  if (object(evidence.prov_o) && text(evidence.prov_o.bundle_ref)) refs.push(evidence.prov_o.bundle_ref)
  if (object(evidence.otel) && text(evidence.otel.trace_ref)) refs.push(evidence.otel.trace_ref)
  return refs
}

/**
 * Produce USL declarations only for explicitly grounded node/evidence bindings.
 * GEIP topology stays lossless in the wrapper, because a GraphSpec node ID is
 * not itself an address that a USL resolver may read.
 */
export const toGraphEngineeringPlan = (source: GraphEngineeringSource, bindings: GraphEngineeringBindings): Either.Either<GraphEngineeringPlan, GraphEngineeringError> => Either.try({
  try: () => {
    const supplied = clone(source)
    const reparsed = Either.getOrThrow(parseGraphEngineeringSource(supplied.sourceText ?? supplied.document))
    if (!isDeepStrictEqual({ graphId: supplied.graphId, graphVersion: supplied.graphVersion, authority: supplied.authority, identity: supplied.identity, topology: supplied.topology, evidence: supplied.evidence, graphspecDigest: supplied.graphspecDigest }, { graphId: reparsed.graphId, graphVersion: reparsed.graphVersion, authority: reparsed.authority, identity: reparsed.identity, topology: reparsed.topology, evidence: reparsed.evidence, graphspecDigest: reparsed.graphspecDigest })) fail("GraphEngineeringSource cached fields differ from its GraphSpec document")
    const frozen = reparsed
    const b = clone(bindings)
    if (!identifier(b.source.resource)) fail("graph source resource must be a USL identifier")
    requireLocator(b.source.locator, "graph source locator")
    if (!text(b.source.text)) fail("graph source text is required")
    if (supplied.sourceText !== undefined && b.source.text !== supplied.sourceText) fail("graph source text must exactly match the imported raw GraphSpec")
    // Object inputs can erase 20 vs 20.0. Validate the bound bytes with their own
    // number lexemes too; structural JSON equality alone cannot bind GEIP hashes.
    if (supplied.sourceText === undefined) {
      const bound = Either.getOrThrowWith(parseGraphEngineeringSource(b.source.text), (error) => error)
      if (bound.graphspecDigest !== frozen.graphspecDigest) fail("bound GraphSpec source has a different identity")
    }
    let sourceDocument: unknown
    try { sourceDocument = JSON.parse(b.source.text) } catch { fail("graph source text must be JSON") }
    if (!isDeepStrictEqual(sourceDocument, frozen.document)) fail("graph source text does not match the imported GraphSpec")
    const sourceLocator = parseLocator(b.source.locator); if (Either.isLeft(sourceLocator)) fail("graph source locator must be valid")
    const graphSourceLocator = Either.getOrThrow(sourceLocator)
    const nodeIds = new Set(frozen.topology.nodes.map((node) => node.id).filter((id): id is string => typeof id === "string"))
    const edgeIds = new Set(frozen.topology.edges.map((edge) => edge.id).filter((id): id is string => typeof id === "string"))
    if (nodeIds.size !== frozen.topology.nodes.length || edgeIds.size !== frozen.topology.edges.length) fail("GraphSpec node and edge IDs must be unique")
    const nodeBindings = b.nodes ?? [], evidenceBindings = b.evidence ?? []
    const resources = new Set<string>([b.source.resource])
    const nodeMap = new Map<string, GraphNodeBinding>()
    for (const binding of nodeBindings) {
      if (!nodeIds.has(binding.nodeId) || nodeMap.has(binding.nodeId) || !identifier(binding.resource) || resources.has(binding.resource)) fail("invalid or duplicate GraphSpec node binding")
      requireLocator(binding.locator, `node ${binding.nodeId} locator`); resources.add(binding.resource); nodeMap.set(binding.nodeId, binding)
    }
    const knownEvidence = new Set(evidenceReferences(frozen.evidence))
    const evidenceMap = new Map<string, GraphEvidenceBinding>()
    for (const binding of evidenceBindings) {
      if (!knownEvidence.has(binding.reference) || evidenceMap.has(binding.reference) || !identifier(binding.resource) || resources.has(binding.resource)) fail("invalid or duplicate GraphSpec evidence binding")
      requireLocator(binding.locator, `evidence ${binding.reference} locator`); resources.add(binding.resource); evidenceMap.set(binding.reference, binding)
    }
    const declarations: Array<Program["declarations"][number]> = [
      { tag: "resource", name: b.source.resource, locator: b.source.locator },
      ...nodeBindings.map((binding) => ({ tag: "resource" as const, name: binding.resource, locator: binding.locator })),
      ...evidenceBindings.map((binding) => ({ tag: "resource" as const, name: binding.resource, locator: binding.locator })),
    ]
    const edgeNames: string[] = []
    for (const edge of frozen.topology.edges) {
      if (!text(edge.id) || !text(edge.source) || !text(edge.target)) fail("GraphSpec edges need id, source and target")
      const edgeId = edge.id as string
      const meaning = stableIdentifier(`geip_edge_meaning_${createHash("sha256").update(frozen.graphId).digest("hex").slice(0, 16)}`, edgeId), statement = graphEngineeringCanonicalJson({ graph_id: frozen.graphId, graph_version: frozen.graphVersion, graphspec_sha256: frozen.graphspecDigest, edge: edge as Json })
      edgeNames.push(meaning)
      declarations.push({ tag: "meaning", name: meaning, roles: [{ name: "source", kind: "any" }, { name: "target", kind: "any" }, { name: "graphspec", kind: graphSourceLocator.kind }], description: `GraphSpec 구조 간선 선언: ${statement}. 실행, 인과성, 효과 성공을 증명하지 않는다.`, contract: { scope: `GEIP GraphSpec ${frozen.graphId}@${frozen.graphVersion} ${frozen.graphspecDigest}`, checks: [{ name: "graphspec_declaration", description: "명시적으로 바인딩된 GraphSpec 원문이 이 간선 선언의 근거다.", evidenceRoles: ["graphspec"] }] } })
    }
    for (const binding of evidenceBindings) declarations.push({ tag: "meaning", name: stableIdentifier(`geip_evidence_meaning_${createHash("sha256").update(frozen.graphId).digest("hex").slice(0, 16)}`, binding.reference), roles: [{ name: "graphspec", kind: graphSourceLocator.kind }, { name: "evidence", kind: "any" }], description: `GraphSpec ${frozen.graphId}@${frozen.graphVersion}가 선언한 근거 참조 ${binding.reference}의 명시적 USL 바인딩이다.`, contract: { scope: `GEIP GraphSpec ${frozen.graphspecDigest}; evidence_ref=${binding.reference}`, checks: [{ name: "graphspec_evidence_reference", description: "GraphSpec 원문의 근거 참조를 확인한다.", evidenceRoles: ["graphspec"] }] } })
    const unboundEdges: string[] = []
    for (const [index, edge] of frozen.topology.edges.entries()) {
      const id = edge.id, from = edge.source, to = edge.target
      if (!text(id) || !text(from) || !text(to) || !nodeMap.has(from) || !nodeMap.has(to)) { if (text(id)) unboundEdges.push(id); continue }
      declarations.push({ tag: "link", name: stableIdentifier(`geip_edge_link_${createHash("sha256").update(frozen.graphId).digest("hex").slice(0, 16)}`, id), meaning: edgeNames[index]!, participants: [{ role: "source", resource: nodeMap.get(from)!.resource }, { role: "target", resource: nodeMap.get(to)!.resource }, { role: "graphspec", resource: b.source.resource }] })
    }
    for (const binding of evidenceBindings) declarations.push({ tag: "link", name: stableIdentifier(`geip_evidence_link_${createHash("sha256").update(frozen.graphId).digest("hex").slice(0, 16)}`, binding.reference), meaning: stableIdentifier(`geip_evidence_meaning_${createHash("sha256").update(frozen.graphId).digest("hex").slice(0, 16)}`, binding.reference), participants: [{ role: "graphspec", resource: b.source.resource }, { role: "evidence", resource: binding.resource }] })
    const compiled = compileProgram({ languageVersion: "0.1", namespace: `geip:${frozen.graphId}`, declarations })
    if (Either.isLeft(compiled)) fail(`cannot create USL plan: ${compiled.left.detail}`)
    return { schema: "usl-graph-engineering-plan/v1", usl: Either.getOrThrow(compiled), graph: { graphId: frozen.graphId, graphVersion: frozen.graphVersion, apiVersion: frozen.document.apiVersion as string, authority: frozen.authority, identity: frozen.identity, graphspecDigest: frozen.graphspecDigest, sourceLocator: b.source.locator, sourceDigest: digestSource(b.source.text) }, topology: frozen.topology, evidence: frozen.evidence, bindings: { nodes: nodeBindings, evidence: evidenceBindings, unboundNodeIds: [...nodeIds].filter((id) => !nodeMap.has(id)), unboundEdgeIds: unboundEdges }, guarantees: { structure: "DECLARED_FROM_GRAPHSPEC", geipValidation: "NOT_RUN", execution: "NOT_EXECUTED" } }
  },
  catch: (error) => error instanceof GraphEngineeringError ? error : new GraphEngineeringError({ detail: String(error) }),
})
