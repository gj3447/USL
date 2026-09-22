/** Shared mechanics for optional contracts; existing plan/source digests are unchanged. */
import { createHash } from "node:crypto"
import { z } from "zod"
import { assertJsonData } from "./application.js"

export const contractText = z.string().min(1).max(4096).regex(/\S/u)
export const contractIri = contractText.regex(/^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|^`\\\u0000-\u001f\u007f]+$/u)
  .regex(/^(?:[^%]|%[A-Fa-f0-9]{2})+$/u)
export const contractHash = z.string().regex(/^sha256:[a-f0-9]{64}$/)
export interface ContractIssue { readonly code: string; readonly at: string; readonly detail: string }
export const contractSnapshot = <T>(value: T, maxBytes = 1024 * 1024): T => {
  assertJsonData(value)
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("invalid contract byte budget")
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxBytes) throw new Error("contract byte budget exceeded")
  return structuredClone(value)
}
export const freezeContract = <T>(value: T): T => {
  if (value !== null && typeof value === "object") { Object.values(value).forEach(freezeContract); Object.freeze(value) }
  return value
}
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
  return JSON.stringify(value)
}
/** Sorted object keys, ordered arrays. Neither RDF canonicalization nor semantic equivalence. */
export const contractDigest = (value: unknown): string => {
  const copy = contractSnapshot(value, 4 * 1024 * 1024)
  return `sha256:${createHash("sha256").update(canonical(copy)).digest("hex")}`
}
export const uniqueContractIds = (values: readonly string[], label: string): void => {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${label}`)
}
