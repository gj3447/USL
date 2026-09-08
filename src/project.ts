// KG projection: USL records -> symposium-kg-bundle/v1 (labels/relation types must be in schema-registry-v1-2026-08-03).
// Record node: labels [Longinus, ReferenceSite] (both registered; a USL record is a Longinus binding reference site).
// Relations: record -INSTANCE_OF-> sym:Concept:usl · record -LONGINUS_BINDS-> kg endpoint nodes · optional anchors for non-kg ends:
//   filesystem -> MATERIALIZES_AS_FILE anchor · url -> BOUND_TO_EXTERNAL_CITATION anchor · git_repo -> HAS_SOURCE_REPOSITORY anchor
import type { UslRecord } from "./domain.js"
import { parseLocator } from "./locator.js"
import { Either } from "effect"
import { validateRecords } from "./validation.js"
import { TOOL_VERSION } from "./domain.js"

export interface ProjectOptions {
  readonly bundle_uid: string
  readonly title: string
  readonly trigger: { readonly user_utterance_verbatim: string; readonly utterance_date: string; readonly tool: string }
  readonly evidence: ReadonlyArray<string>
  readonly defaults?: Record<string, string | boolean>
  /** KG anchors for non-KG ends, or explicit target-graph anchors for foreign KG ends. */
  readonly endAnchors?: Readonly<Record<string, { readonly from?: string; readonly to?: string }>>
  readonly uslConceptUid?: string
  readonly targetKgSource?: string
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9가-힣._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120)
export const recordUid = (r: UslRecord) => `sym:Longinus:usl-link-${slug(r.link_id)}`

const ANCHOR_REL: Record<UslRecord["from_endpoint_kind"], string> = { filesystem: "MATERIALIZES_AS_FILE", url: "BOUND_TO_EXTERNAL_CITATION", git_repo: "HAS_SOURCE_REPOSITORY", kg: "LONGINUS_BINDS" }

export const toBundle = (inputRecords: ReadonlyArray<UslRecord>, o: ProjectOptions) => {
  // Decode once and use only this detached, validated snapshot below.  Callers
  // can otherwise mutate an input object (or expose an accessor) between
  // validation and projection, changing a PENDING record into CANONICAL.
  const records = validateRecords(inputRecords)
  if (!o.bundle_uid?.trim() || !o.title?.trim() || !o.trigger.user_utterance_verbatim?.trim()) throw new Error("bundle_uid, title and verbatim user utterance are required")
  const recordIds = new Set(records.map((r) => r.link_id))
  for (const [id, ends] of Object.entries(o.endAnchors ?? {})) {
    if (!recordIds.has(id) || !ends || typeof ends !== "object" || Array.isArray(ends)) throw new Error(`invalid endpoint anchors for ${id}`)
    for (const [end, anchor] of Object.entries(ends)) if ((end !== "from" && end !== "to") || typeof anchor !== "string" || !anchor.trim() || anchor !== anchor.trim()) throw new Error(`invalid ${id} ${end} anchor`)
  }
  const usl = o.uslConceptUid ?? "sym:Concept:usl"
  const targetSource = o.targetKgSource ?? "canonical-neo4j"
  if (!/^[A-Za-z0-9._-]+$/.test(targetSource) || !usl.trim() || usl !== usl.trim()) throw new Error("invalid target KG source or USL concept UID")
  const seen = new Set<string>()
  const anchors = new Set<string>([usl])
  const nodes: Array<Record<string, unknown>> = []
  const relations: Array<Record<string, unknown>> = []
  for (const r of records) {
    const uid = recordUid(r)
    if (!slug(r.link_id) || seen.has(uid)) throw new Error(`empty or colliding KG record UID: ${r.link_id} -> ${uid}`)
    seen.add(uid)
    nodes.push({
      uid, labels: ["Longinus", "ReferenceSite"],
      properties: {
        name: `usl-link-${slug(r.link_id)}`,
        title: `USL ${r.from_endpoint_kind}→${r.to_endpoint_kind} ${r.semantic_relation}: ${r.from_locator} ⇢ ${r.to_locator}`,
        // 레코드를 뚫은 도구 버전은 레코드 자신의 provenance 이지 지금 실행 중인 바이너리 버전이 아니다.
        // (2026-09-08 감사: 0.1.0 으로 뚫고 재-pierce 하지 않은 레코드가 0.3.0 산출물로 표기됐다.)
        description: `${r.provenance_tool_version} 링크 레코드(${r.status}). ${r.semantic_relation}. 양 끝 content hash·해석 시각·guarantee_level 을 기록한 롱기누스 최소단위 표본. 도구 산출물이며 사용자 정전이 아니다.`,
        ...r,
        ontology_kind: "ARTIFACT", ontology_plane: "GOVERNANCE", authority_class: "SYSTEM_DERIVED",
        // KG 등급은 레코드 status 에서 파생한다. 하드코딩하면 해석에 실패한 레코드(DRIFT/ORPHAN/AMBIGUOUS)가
        // CANONICAL·review_required=false 로 KG 에 앉아 "확정된 사실"처럼 읽힌다 — 2026-09-08 감사 D23 실측:
        // usl-code-fs 가 audit 에서 DRIFT(SigMismatch) 인데 KG 에는 RESOLVES/CANONICAL 로 14건 전부 같은 등급이었다.
        canonical_scope: r.status === "RESOLVES" ? "CANONICAL" : "PENDING_OR_PRELIMINARY",
        semantic_roles: ["ARTIFACT", "REFERENCE_RECORD"], review_required: r.status !== "RESOLVES",
        aliases: [r.link_id, `usl ${r.from_endpoint_kind} ${r.to_endpoint_kind}`],
      },
    })
    relations.push({ from_uid: uid, to_uid: usl, type: "INSTANCE_OF", authority_class: "SYSTEM_DERIVED", status: "ACTIVE", properties: { role: "usl_record", basis: `${r.provenance_tool_version} pierce()` } })
    for (const end of ["from", "to"] as const) {
      const locStr = end === "from" ? r.from_locator : r.to_locator
      const kind = end === "from" ? r.from_endpoint_kind : r.to_endpoint_kind
      const parsed = parseLocator(locStr)
      if (kind === "kg" && Either.isRight(parsed) && parsed.right.kind === "kg") {
        const mapped = o.endAnchors?.[r.link_id]?.[end]
        if (parsed.right.source === targetSource && mapped && mapped !== parsed.right.uid) throw new Error(`${r.link_id} ${end}: cannot remap a same-source KG UID`)
        if (parsed.right.source !== targetSource && !mapped) throw new Error(`${r.link_id} ${end}: KG source ${parsed.right.source} requires an explicit anchor in ${targetSource}`)
        const anchor = mapped ?? parsed.right.uid
        anchors.add(anchor)
        relations.push({ from_uid: uid, to_uid: anchor, type: "LONGINUS_BINDS", authority_class: "SYSTEM_DERIVED", status: "ACTIVE", properties: { role: `${end}_endpoint`, end, kind: "kg", source: parsed.right.source, locator: locStr } })
      }
      const a = o.endAnchors?.[r.link_id]?.[end]
      if (a && kind !== "kg") {
        anchors.add(a)
        relations.push({ from_uid: uid, to_uid: a, type: ANCHOR_REL[kind], authority_class: "SYSTEM_DERIVED", status: "ACTIVE", properties: { role: `${end}_endpoint_anchor`, end, kind, locator: locStr } })
      }
    }
  }
  return {
    schema_version: "symposium-kg-bundle/v1", bundle_uid: o.bundle_uid, title: o.title, trigger: o.trigger,
    evidence: [...o.evidence, `${TOOL_VERSION} (TypeScript + Effect) pierce()/audit()/toBundle() — CD/USL`],
    anchors: [...anchors].sort(),
    defaults: { ontology_plane: "GOVERNANCE", ontology_domain: "ENGINEERING", ontology_sensitivity: "NORMAL", record_lifecycle: "ACTIVE", epistemic_state: "PREFERRED", review_required: false, ...(o.defaults ?? {}) },
    nodes, relations,
  }
}
