/** Exact, owner-selected role constraints. No ontology inference or semantic truth verdict. */
import { z } from "zod"
import { contractDigest, contractIri, contractSnapshot, contractText, freezeContract, uniqueContractIds, type ContractIssue } from "./contract-core.js"
import { parseResourceGraph, type ResourceGraph } from "./integrations/resource-graph.js"
import { Either } from "effect"

const role = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
export const domainProfileSchema = z.strictObject({
  schema: z.literal("usl-domain-profile/v1"), id: contractIri, version: contractText,
  closedMeanings: z.boolean(),
  meanings: z.array(z.strictObject({
    id: contractText, allowExtraRoles: z.boolean(),
    roles: z.array(z.strictObject({
      role, required: z.boolean(), types: z.array(contractIri).min(1).max(64),
      metadata: z.array(z.strictObject({ key: contractText, equals: z.json() })).max(64),
    })).min(1).max(128),
  })).min(1).max(256),
})
export type DomainProfile = z.infer<typeof domainProfileSchema>
export const parseDomainProfile = (input: unknown): DomainProfile => {
  const profile = domainProfileSchema.parse(contractSnapshot(input))
  uniqueContractIds(profile.meanings.map(m => m.id), "profile meanings")
  for (const meaning of profile.meanings) {
    uniqueContractIds(meaning.roles.map(r => r.role), "profile roles")
    for (const r of meaning.roles) {
      uniqueContractIds(r.types, "role types")
      uniqueContractIds(r.metadata.map(c => c.key), "metadata constraints")
    }
  }
  return freezeContract(profile)
}
export interface DomainProfileReport {
  readonly schema: "usl-domain-profile-report/v1"
  readonly status: "CONFORMS" | "VIOLATES"
  readonly profileDigest: string
  readonly graphDigest: string
  readonly checkedLinks: number
  readonly unprofiledLinks: readonly string[]
  readonly issues: readonly ContractIssue[]
  readonly semanticTruth: "NOT_EVALUATED"
}
export const checkResourceGraphProfile = (input: ResourceGraph, supplied: unknown): DomainProfileReport => {
  const graph = Either.getOrThrowWith(parseResourceGraph(JSON.stringify(contractSnapshot(input))), failure => failure)
  const profile = parseDomainProfile(supplied)
  const rules = new Map(profile.meanings.map(m => [m.id, m])), resources = new Map(graph.resources.map(r => [r.id, r]))
  const issues: ContractIssue[] = [], unprofiledLinks: string[] = []
  let checkedLinks = 0
  const issue = (code: string, at: string, detail: string) => { issues.push({ code, at, detail }) }
  for (const link of graph.links) {
    const rule = rules.get(link.meaning)
    if (!rule) {
      unprofiledLinks.push(link.id)
      if (profile.closedMeanings) issue("UNPROFILED_MEANING", link.id, link.meaning)
      continue
    }
    checkedLinks++
    const participants = new Map(link.participants.map(p => [p.role, p.resource]))
    if (!rule.allowExtraRoles) for (const p of link.participants) {
      if (!rule.roles.some(r => r.role === p.role)) issue("UNEXPECTED_ROLE", link.id, p.role)
    }
    for (const r of rule.roles) {
      const id = participants.get(r.role), at = `${link.id}/${r.role}`
      if (id === undefined) { if (r.required) issue("MISSING_ROLE", at, "required role is absent"); continue }
      const resource = resources.get(id)!
      // All listed types are required, using exact IRI equality; no inferred subtype closure.
      for (const type of r.types) if (!resource.types.includes(type)) issue("ROLE_TYPE", at, `missing type ${type}`)
      for (const constraint of r.metadata) {
        if (!resource.metadata || !Object.hasOwn(resource.metadata, constraint.key)) issue("MISSING_METADATA", at, constraint.key)
        else if (contractDigest(resource.metadata[constraint.key]) !== contractDigest(constraint.equals)) issue("METADATA_MISMATCH", at, constraint.key)
      }
    }
  }
  return freezeContract({ schema: "usl-domain-profile-report/v1", status: issues.length ? "VIOLATES" : "CONFORMS",
    profileDigest: contractDigest(profile), graphDigest: contractDigest(graph), checkedLinks, unprofiledLinks, issues,
    semanticTruth: "NOT_EVALUATED" })
}
