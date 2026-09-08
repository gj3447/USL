// Code-native declarations. Building or binding metadata never runs application code or IO.
import { Either } from "effect"
import { isDeepStrictEqual } from "node:util"
import type { EndpointKind } from "../domain.js"
import { formatLocator, parseLocator } from "../locator.js"
import { compileProgram, compileSource } from "./compiler.js"
import { planDigest } from "./digest.js"
import { LanguageError, type Declaration, type MeaningContract, type RoleKind, type SemanticPlan } from "./model.js"

type KindOf<L extends string> = L extends `kg://${string}` ? "kg"
  : L extends `git://${string}` ? "git_repo" : L extends `file://${string}` ? "filesystem"
  : L extends `http://${string}` | `https://${string}` ? "url" : EndpointKind
export interface CodeResource<K extends EndpointKind = EndpointKind> {
  readonly tag: "resource"
  readonly name: string
  readonly locator: string
  readonly kind: K
}
export type CodeRoles = Readonly<Record<string, RoleKind>>
export interface CodeMeaningDefinition<R extends CodeRoles> {
  readonly roles: R
  readonly description: string
  readonly grounded?: string
  readonly contract?: {
    readonly scope: string
    readonly checks: ReadonlyArray<{
      readonly name: string
      readonly description: string
      readonly evidenceRoles: ReadonlyArray<keyof R & string>
    }>
  }
}
export interface CodeMeaning<R extends CodeRoles = CodeRoles> {
  readonly tag: "meaning"
  readonly name: string
  readonly definition: {
    readonly roles: R
    readonly description: string
    readonly grounded?: string
    readonly contract?: MeaningContract
  }
}
export type CodeParticipants<R extends CodeRoles> = {
  readonly [P in keyof R]: CodeResource<R[P] extends EndpointKind ? R[P] : EndpointKind>
}
export interface CodeLink {
  readonly tag: "link"
  readonly name: string
  readonly meaning: CodeMeaning
  readonly participants: Readonly<Record<string, CodeResource>>
}
export type CodeDeclaration = CodeResource | CodeMeaning | CodeLink
export interface UslBinding<A> { readonly run: A; readonly usl: CodeLink }

const fail = (detail: string): never => { throw new LanguageError({ phase: "compile", detail }) }
const freeze = <A>(value: A): A => {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
const copy = <A>(value: A): A => freeze(structuredClone(value))
const attempt = <A>(f: () => A): Either.Either<A, LanguageError> => Either.try({
  try: f, catch: (e) => e instanceof LanguageError ? e : new LanguageError({ phase: "compile", detail: String(e) }),
})
// Emit the parser's field order too: USL v2 hashes JSON.stringify, not unordered JSON.
// This makes generated source and code-authored plans share exactly the same digest.
const canonicalDeclaration = (d: Declaration): Declaration => {
  if (d.tag === "resource") return { tag: "resource", name: d.name, locator: d.locator }
  if (d.tag === "link") return { tag: "link", name: d.name, meaning: d.meaning,
    participants: d.participants.map((p) => ({ role: p.role, resource: p.resource })) }
  return { tag: "meaning", name: d.name, roles: d.roles.map((r) => ({ name: r.name, kind: r.kind })), description: d.description,
    ...(d.grounded === undefined ? {} : { grounded: d.grounded }),
    ...(d.contract === undefined ? {} : { contract: { scope: d.contract.scope, checks: d.contract.checks.map((c) => ({
      name: c.name, evidenceRoles: [...c.evidenceRoles], description: c.description,
    })) } }) }
}
const compiled = (namespace: string, declarations: ReadonlyArray<Declaration>) =>
  Either.getOrThrowWith(compileProgram({ languageVersion: "0.1", namespace, declarations: declarations.map(canonicalDeclaration) }), (e) => e)

export const codeResource = <const L extends string>(name: string, locator: L): CodeResource<KindOf<L>> => {
  const parsed = Either.getOrThrowWith(parseLocator(locator), (e) => new LanguageError({ phase: "compile", detail: e.reason }))
  compiled("code.declaration", [{ tag: "resource", name, locator }])
  return freeze({ tag: "resource", name, locator, kind: parsed.kind as KindOf<L> })
}
export const codeMeaning = <const R extends CodeRoles>(name: string, definition: CodeMeaningDefinition<R>): CodeMeaning<R> => {
  const result = copy({ tag: "meaning" as const, name, definition })
  compiled("code.declaration", [meaningDeclaration(result)])
  return result
}
const meaningDeclaration = (m: CodeMeaning): Declaration => ({
  tag: "meaning", name: m.name, roles: Object.entries(m.definition.roles).map(([name, kind]) => ({ name, kind })),
  description: m.definition.description,
  ...(m.definition.grounded === undefined ? {} : { grounded: m.definition.grounded }),
  ...(m.definition.contract === undefined ? {} : { contract: m.definition.contract }),
})

export const codeLink = <const R extends CodeRoles>(name: string, meaning: CodeMeaning<R>, participants: CodeParticipants<NoInfer<R>>): CodeLink => {
  const result = copy({ tag: "link" as const, name, meaning, participants })
  Either.getOrThrowWith(compileCode("code.declaration", [result]), (e) => e)
  return result
}

/** Preserve the original function/Effect/value identity. No wrapper, invocation or mutation. */
export const bindUsl = <A>(run: A, link: CodeLink): UslBinding<A> => {
  const snapshot = copy(link)
  if (snapshot.tag !== "link") return fail("bind requires a USL link")
  Either.getOrThrowWith(compileCode("code.binding", [snapshot]), (e) => e)
  return Object.freeze({ run, usl: snapshot })
}

const collector = () => {
  const byName = new Map<string, Declaration>()
  const add = (declaration: Declaration) => {
    const prior = byName.get(declaration.name)
    if (prior && !isDeepStrictEqual(prior, declaration)) return fail(`conflicting declaration: ${declaration.name}`)
    if (!prior) byName.set(declaration.name, declaration)
  }
  return { add, values: () => [...byName.values()] }
}

/** Close over referenced declarations, so each shared locator is authored in one resource value. */
export const compileCode = (namespace: string, input: ReadonlyArray<CodeDeclaration>): Either.Either<SemanticPlan, LanguageError> => attempt(() => {
  const declarations = structuredClone(input)
  const collected = collector()
  const visit = (d: CodeDeclaration) => {
    if (d.tag === "resource") {
      const parsed = Either.getOrThrowWith(parseLocator(d.locator), (e) => e)
      if (parsed.kind !== d.kind) return fail(`resource kind differs from locator: ${d.name}`)
      collected.add({ tag: "resource", name: d.name, locator: d.locator })
    } else if (d.tag === "meaning") collected.add(meaningDeclaration(d))
    else if (d.tag === "link") {
      visit(d.meaning)
      for (const resource of Object.values(d.participants)) visit(resource)
      collected.add({ tag: "link", name: d.name, meaning: d.meaning.name,
        participants: Object.entries(d.participants).map(([role, resource]) => ({ role, resource: resource.name })) })
    } else return fail("unknown code declaration")
  }
  for (const d of declarations) visit(d)
  return freeze(compiled(namespace, collected.values()))
})

const planDeclarations = (plan: SemanticPlan): Declaration[] => [
  ...plan.resources.map((r): Declaration => ({ tag: "resource", name: r.name, locator: formatLocator(r.locator) })),
  ...plan.meanings.map((m): Declaration => ({ tag: "meaning", name: m.name, roles: m.roles, description: m.description,
    ...(m.grounded === undefined ? {} : { grounded: formatLocator(m.grounded) }),
    ...(m.contract === undefined ? {} : { contract: m.contract }) })),
  ...plan.links.map((l): Declaration => ({ tag: "link", ...l })),
]
const checkedPlan = (input: SemanticPlan): SemanticPlan => {
  const plan = structuredClone(input)
  if (!isDeepStrictEqual(compiled(plan.namespace, planDeclarations(plan)), plan)) return fail("invalid semantic plan")
  return plan
}

/** Explicit namespace composition; conflicting shared names fail instead of silently rebinding. */
export const composePlans = (namespace: string, plans: ReadonlyArray<SemanticPlan>): Either.Either<SemanticPlan, LanguageError> => attempt(() => {
  const collected = collector()
  for (const input of plans) for (const d of planDeclarations(checkedPlan(input))) collected.add(d)
  return freeze(compiled(namespace, collected.values()))
})

/** Generated USL source, not the original TypeScript source. Observe the TS file as a resource. */
export const sourceFromPlan = (input: SemanticPlan): Either.Either<string, LanguageError> => attempt(() => {
  const plan = checkedPlan(input)
  const q = (text: string) => JSON.stringify(text)
  const lines = [`usl "0.1";`, `namespace ${q(plan.namespace)};`]
  for (const d of planDeclarations(plan)) {
    if (d.tag === "resource") lines.push(`resource ${d.name} = ${q(d.locator)};`)
    else if (d.tag === "link") lines.push(`link ${d.name} = ${d.meaning}(${d.participants.map((p) => `${p.role}: ${p.resource}`).join(", ")});`)
    else {
      let line = `meaning ${d.name}(${d.roles.map((r) => `${r.name}: ${r.kind}`).join(", ")}) = ${q(d.description)}`
      if (d.grounded !== undefined) line += ` grounded ${q(d.grounded)}`
      if (d.contract !== undefined) {
        line += ` applies ${q(d.contract.scope)}`
        for (const c of d.contract.checks) line += ` check ${c.name}(${c.evidenceRoles.join(", ")}) = ${q(c.description)}`
      }
      lines.push(`${line};`)
    }
  }
  const source = `${lines.join("\n")}\n`
  const rebuilt = Either.getOrThrowWith(compileSource(source), (e) => e)
  if (planDigest(rebuilt) !== planDigest(plan)) return fail("generated source does not preserve plan digest; normalize field order with usl.compose(namespace, [plan]) first")
  return source
})

/** Alias freely (e.g. import { usl as semantic }); JavaScript variable names have no ID semantics. */
export const usl = Object.freeze({ resource: codeResource, meaning: codeMeaning, link: codeLink,
  bind: bindUsl, compile: compileCode, compose: composePlans, source: sourceFromPlan })
