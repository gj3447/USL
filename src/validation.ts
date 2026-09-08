import { Either, Schema } from "effect"
import { UslRecord } from "./domain.js"
import { formatLocator, parseLocator } from "./locator.js"

const resolutionBaselineFields = ["content_hash", "resolved_locator", "resolved_at"] as const

const incompleteResolutionBaseline = (record: UslRecord, end: "from" | "to") =>
  resolutionBaselineFields
    .filter((field) => {
      const value = record[`${field}_${end}` as "content_hash_from" | "content_hash_to" | "resolved_locator_from" | "resolved_locator_to" | "resolved_at_from" | "resolved_at_to"]
      return typeof value !== "string" || !value.trim()
    })
    .map((field) => `${field}_${end}`)

export const validateRecords = (value: unknown): ReadonlyArray<UslRecord> => {
  const records = Schema.decodeUnknownSync(Schema.Array(UslRecord))(value, { onExcessProperty: "error" })
  const ids = new Set<string>()
  for (const record of records) {
    if (ids.has(record.link_id)) throw new Error(`duplicate link_id: ${record.link_id}`)
    ids.add(record.link_id)
    for (const end of ["from", "to"] as const) {
      const locator = record[`${end}_locator`]
      const parsed = parseLocator(locator)
      if (Either.isLeft(parsed)) throw new Error(`${record.link_id} ${end}: ${parsed.left.reason}`)
      if (parsed.right.kind !== record[`${end}_endpoint_kind`]) throw new Error(`${record.link_id} ${end}: endpoint kind does not match locator`)
      if (formatLocator(parsed.right) !== locator) throw new Error(`${record.link_id} ${end}: locator must use canonical formatting`)
    }
    // RESOLVES is the only status that may become a canonical KG assertion.  It
    // therefore needs a complete, non-blank baseline for both endpoints.  Other
    // statuses deliberately permit absent baselines so audit()/rebind() can
    // represent orphaned and unbaselined recovery states.
    if (record.status === "RESOLVES") {
      const missing = (["from", "to"] as const).flatMap((end) => incompleteResolutionBaseline(record, end))
      if (missing.length) throw new Error(`${record.link_id}: RESOLVES requires non-empty endpoint baselines (${missing.join(", ")})`)
      for (const end of ["from", "to"] as const) {
        const resolvedLocator = record[`resolved_locator_${end}`]
        // Completeness above guarantees this is a non-empty string.  Re-parse
        // it before allowing the record to become canonical: a forged resolved
        // URL/KG/file/git address must not be treated as endpoint evidence.
        if (typeof resolvedLocator !== "string") continue
        const parsed = parseLocator(resolvedLocator)
        if (Either.isLeft(parsed)) throw new Error(`${record.link_id} ${end}: resolved locator ${parsed.left.reason}`)
        if (parsed.right.kind !== record[`${end}_endpoint_kind`]) throw new Error(`${record.link_id} ${end}: resolved locator kind does not match endpoint kind`)
        if (formatLocator(parsed.right) !== resolvedLocator) throw new Error(`${record.link_id} ${end}: resolved locator must use canonical formatting`)
        const requested = parseLocator(record[`${end}_locator`])
        if (Either.isRight(requested) && requested.right.kind === "kg" && parsed.right.kind === "kg" &&
          (requested.right.source !== parsed.right.source || requested.right.uid !== parsed.right.uid))
          throw new Error(`${record.link_id} ${end}: RESOLVES KG resolved locator must keep the requested source and UID`)
      }
      if (record.confidence !== "EXTRACTED") throw new Error(`${record.link_id}: RESOLVES requires EXTRACTED confidence`)
      if (record.drift_score !== 0) throw new Error(`${record.link_id}: RESOLVES requires drift_score 0`)
    }
  }
  return records
}
