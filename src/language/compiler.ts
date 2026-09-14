import { Either } from "effect"
import { parseLocator } from "../locator.js"
import { LanguageError, type Program, type SemanticPlan } from "./model.js"
import { parseProgram } from "./parser.js"

export const compileProgram = (program: Program): Either.Either<SemanticPlan, LanguageError> => Either.try({
  try: () => {
    const fail = (detail: string): never => { throw new LanguageError({ phase: "compile", detail }) }
    if (program.languageVersion !== "0.1") return fail(`unsupported USL language version: ${program.languageVersion}`)
    if (!program.namespace.trim() || program.namespace !== program.namespace.trim()) return fail("namespace must be non-empty without surrounding whitespace")
    const names = new Set<string>()
    for (const d of program.declarations) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(d.name) || names.has(d.name)) return fail(`invalid or duplicate declaration: ${d.name}`)
      names.add(d.name)
    }
    const resources = program.declarations.filter((d) => d.tag === "resource").map((d) => {
      const parsed = parseLocator(d.locator)
      if (Either.isLeft(parsed)) return fail(`${d.name}: ${parsed.left.reason}`)
      return { name: d.name, locator: parsed.right }
    })
    const meanings = program.declarations.filter((d) => d.tag === "meaning").map((d) => {
      if (!d.description.trim()) return fail(`${d.name}: meaning description is empty`)
      if (d.roles.length < 1) return fail(`${d.name}: at least one role is required`)
      const seen = new Set<string>()
      for (const role of d.roles) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(role.name) || seen.has(role.name)) return fail(`${d.name}: invalid or duplicate role ${role.name}`)
        if (!["kg", "git_repo", "url", "filesystem", "any"].includes(role.kind)) return fail(`${d.name}: unsupported role kind ${role.kind}`)
        seen.add(role.name)
      }
      if (d.contract !== undefined) {
        if (!d.contract.scope.trim()) return fail(`${d.name}: meaning contract scope is empty`)
        if (d.contract.checks.length === 0) return fail(`${d.name}: meaning contract requires at least one check`)
        const checkNames = new Set<string>()
        for (const check of d.contract.checks) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(check.name) || checkNames.has(check.name)) return fail(`${d.name}: invalid or duplicate contract check ${check.name}`)
          if (!check.description.trim()) return fail(`${d.name}.${check.name}: check description is empty`)
          if (check.evidenceRoles.length === 0) return fail(`${d.name}.${check.name}: check requires at least one evidence role`)
          const evidenceRoles = new Set<string>()
          for (const evidenceRole of check.evidenceRoles) {
            if (!seen.has(evidenceRole)) return fail(`${d.name}.${check.name}: unknown evidence role ${evidenceRole}`)
            if (evidenceRoles.has(evidenceRole)) return fail(`${d.name}.${check.name}: duplicate evidence role ${evidenceRole}`)
            evidenceRoles.add(evidenceRole)
          }
          checkNames.add(check.name)
        }
      }
      if (d.grounded !== undefined) {
        const anchor = parseLocator(d.grounded)
        if (Either.isLeft(anchor) || anchor.right.kind !== "kg") return fail(`${d.name}: meaning grounding must be a KG locator`)
        return { name: d.name, roles: d.roles, description: d.description, grounded: anchor.right, ...(d.contract !== undefined ? { contract: d.contract } : {}) }
      }
      return { name: d.name, roles: d.roles, description: d.description, ...(d.contract !== undefined ? { contract: d.contract } : {}) }
    })
    const resourceMap = new Map(resources.map((r) => [r.name, r]))
    const meaningMap = new Map(meanings.map((m) => [m.name, m]))
    const links = program.declarations.filter((d) => d.tag === "link").map((d) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(d.meaning)) return fail(`${d.name}: invalid meaning identifier`)
      const meaning = meaningMap.get(d.meaning)
      if (!meaning) return fail(`${d.name}: undeclared meaning ${d.meaning}`)
      const seen = new Set<string>()
      for (const p of d.participants) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.role) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.resource)) return fail(`${d.name}: invalid participant identifier`)
        if (seen.has(p.role)) return fail(`${d.name}: duplicate participant role ${p.role}`)
        seen.add(p.role)
        const role = meaning.roles.find((r) => r.name === p.role)
        if (!role) return fail(`${d.name}: unknown role ${p.role}`)
        const resource = resourceMap.get(p.resource)
        if (!resource) return fail(`${d.name}: undeclared resource ${p.resource}`)
        if (role.kind !== "any" && role.kind !== resource.locator.kind) return fail(`${d.name}.${p.role}: expected ${role.kind}, got ${resource.locator.kind}`)
      }
      for (const role of meaning.roles) if (!seen.has(role.name)) return fail(`${d.name}: missing participant role ${role.name}`)
      return { name: d.name, meaning: d.meaning, participants: meaning.roles.map((r) => d.participants.find((p) => p.role === r.name)!) }
    })
    return { schema: "usl-semantic-plan/v1", languageVersion: "0.1", namespace: program.namespace, resources, meanings, links, declarationStatus: "DECLARED" }
  },
  catch: (e) => e instanceof LanguageError ? e : new LanguageError({ phase: "compile", detail: String(e) }),
})
export const compileSource = (source: string): Either.Either<SemanticPlan, LanguageError> => Either.flatMap(parseProgram(source), compileProgram)
