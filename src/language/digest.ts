import { createHash } from "node:crypto"
import type { SemanticPlan } from "./model.js"

/** SHA-256 of UTF-8 JSON.stringify output; identity, not semantic equivalence. */
export const digestJson = (value: unknown): string => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`
export const digestSource = (source: string): string => `sha256:${createHash("sha256").update(source).digest("hex")}`
export const planDigest = (plan: SemanticPlan): string => digestJson(plan)

/** Grounding addresses and participant bindings belong to the address channel. */
export const linkContractDigest = (meaning: SemanticPlan["meanings"][number]): string =>
  digestJson({ meaning: meaning.name, description: meaning.description, roles: meaning.roles,
    contract: meaning.contract ?? null })
