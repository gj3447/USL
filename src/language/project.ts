import { Either } from "effect"
import { TOOL_VERSION, type KgLocator } from "../domain.js"
import { formatLocator } from "../locator.js"
import { sha256 } from "../resolve.js"
import { compileSource } from "./compiler.js"
import { planDigest } from "./digest.js"
import { LanguageError, type SemanticPlan } from "./model.js"

export interface SemanticProjectionOptions {
  readonly bundle_uid: string
  readonly title: string
  readonly trigger: { readonly user_utterance_verbatim: string; readonly utterance_date: string; readonly tool: string }
  readonly evidence?: ReadonlyArray<string>
  readonly source?: { readonly name: string; readonly text: string }
  readonly targetKgSource?: string
  /** Fully qualified foreign KG locator -> explicit anchor UID in the target graph. */
  readonly kgAnchors?: Readonly<Record<string, string>>
}
export const semanticUid = (namespace: string, kind: "resource" | "meaning" | "link", name: string) =>
  `urn:usl:${encodeURIComponent(namespace)}:${kind}:${encodeURIComponent(name)}`

export const toSemanticBundle = (plan: SemanticPlan, options: SemanticProjectionOptions) => Either.try({
  try: () => {
    const fail = (detail: string): never => { throw new LanguageError({ phase: "project", detail }) }
    // A projection can carry a source digest only when that exact source produced
    // the plan being projected.  Snapshot both inputs before deriving either the
    // declaration data or its provenance, so getters/caller mutations cannot mix
    // two semantic versions in one bundle.
    const frozenPlan = structuredClone(plan) as SemanticPlan
    const suppliedSource = options.source
    const source = suppliedSource === undefined ? undefined : Object.freeze({ name: suppliedSource.name, text: suppliedSource.text })
    if (source !== undefined) {
      if (typeof source.name !== "string" || typeof source.text !== "string") return fail("source name and text must be strings")
      const compiled = compileSource(source.text)
      if (Either.isLeft(compiled)) return fail(`provided USL source does not compile: ${compiled.left.detail}`)
      if (planDigest(compiled.right) !== planDigest(frozenPlan)) return fail("provided USL source does not match the semantic plan being projected")
    }
    if (!options.bundle_uid.trim() || !options.title.trim() || !options.trigger.user_utterance_verbatim.trim()) return fail("bundle UID, title and verbatim user trigger are required")
    const target = options.targetKgSource ?? "canonical-neo4j"
    if (!/^[A-Za-z0-9._-]+$/.test(target)) return fail("invalid target KG source")
    const usl = "sym:Concept:usl"
    const anchors = new Set<string>([usl])
    const nodes: Array<{ uid: string; labels: string[]; properties: Record<string, unknown> }> = []
    const relations: Array<Record<string, unknown>> = []
    const sourceHash = sha256(source?.text ?? JSON.stringify(frozenPlan))
    const base = { namespace: frozenPlan.namespace, language_version: frozenPlan.languageVersion, declaration_status: "DECLARED", authority_class: "SECONDARY_AI", canonical_scope: "PENDING_OR_PRELIMINARY", review_required: true,
      source_name: source?.name ?? "compiled-plan", source_sha256: sourceHash, source_hash_kind: source ? "USL_SOURCE" : "COMPILED_PLAN", provenance_tool_version: TOOL_VERSION }
    const uid = (kind: "resource" | "meaning" | "link", name: string) => semanticUid(frozenPlan.namespace, kind, name)
    const edge = (from_uid: string, to_uid: string, type: string, properties: Record<string, unknown>) => relations.push({ from_uid, to_uid, type, authority_class: "SECONDARY_AI", status: "PROPOSED", properties })
    const ground = (locator: KgLocator): string => {
      const loc = formatLocator(locator)
      const mapped = options.kgAnchors && Object.hasOwn(options.kgAnchors, loc) ? options.kgAnchors[loc] : undefined
      if (mapped !== undefined && (typeof mapped !== "string" || !mapped.trim() || mapped !== mapped.trim())) return fail(`invalid KG anchor for ${loc}`)
      if (locator.source === target && mapped && mapped !== locator.uid) return fail(`cannot remap same-source KG UID: ${loc}`)
      if (locator.source !== target && !mapped) return fail(`foreign KG locator needs an explicit target-graph anchor: ${loc}`)
      const anchor = mapped ?? locator.uid
      anchors.add(anchor); return anchor
    }
    for (const r of frozenPlan.resources) {
      const id = uid("resource", r.name)
      nodes.push({ uid: id, labels: ["ReferenceSite"], properties: { ...base, name: r.name, title: `USL resource ${r.name}`, ontology_kind: "ARTIFACT", semantic_roles: ["RESOURCE_REFERENCE"], endpoint_kind: r.locator.kind, locator: formatLocator(r.locator) } })
      if (r.locator.kind === "kg") edge(id, ground(r.locator), "LONGINUS_BINDS", { role: "kg_referent", source: r.locator.source, locator: formatLocator(r.locator) })
    }
    for (const m of frozenPlan.meanings) {
      const id = uid("meaning", m.name)
      nodes.push({ uid: id, labels: ["Concept"], properties: { ...base, name: m.name, title: `USL meaning ${m.name}`, description: m.description, ontology_kind: "CONCEPT", semantic_roles: ["SEMANTIC_RELATION_DECLARATION"], role_names: m.roles.map((r) => r.name), role_kinds: m.roles.map((r) => r.kind), ...(m.contract === undefined ? {} : { contract_scope: m.contract.scope, contract_checks_json: JSON.stringify(m.contract.checks), meaning_contract_json: JSON.stringify(m.contract) }) } })
      if (m.grounded) edge(id, ground(m.grounded), "RELATED_TO", { role: "declared_meaning_grounding", source: m.grounded.source, locator: formatLocator(m.grounded) })
    }
    for (const l of frozenPlan.links) {
      const id = uid("link", l.name)
      nodes.push({ uid: id, labels: ["Longinus", "ReferenceSite"], properties: { ...base, name: l.name, title: `USL link ${l.name}`, ontology_kind: "ARTIFACT", semantic_roles: ["SEMANTIC_LINK_DECLARATION"], meaning_uid: uid("meaning", l.meaning), participant_roles: l.participants.map((p) => p.role), participant_resources: l.participants.map((p) => uid("resource", p.resource)) } })
      edge(id, usl, "INSTANCE_OF", { role: "usl_link_declaration" })
      edge(id, uid("meaning", l.meaning), "RELATED_TO", { role: "semantic_meaning" })
      for (const p of l.participants) edge(id, uid("resource", p.resource), "RELATED_TO", { role: "participant", participant_role: p.role })
    }
    return { schema_version: "symposium-kg-bundle/v1", bundle_uid: options.bundle_uid, title: options.title, trigger: options.trigger,
      evidence: [...(options.evidence ?? []), `USL ${frozenPlan.languageVersion} declaration, namespace=${frozenPlan.namespace}, ${base.source_hash_kind} sha256=${sourceHash}`],
      anchors: [...anchors].sort(), defaults: { ontology_domain: "ENGINEERING", ontology_plane: "GOVERNANCE", ontology_sensitivity: "NORMAL", record_lifecycle: "ACTIVE", epistemic_state: "UNASSESSED", review_required: true }, nodes, relations }
  },
  catch: (e) => e instanceof LanguageError ? e : new LanguageError({ phase: "project", detail: String(e) }),
})
