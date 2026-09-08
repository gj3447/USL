import { Either } from "effect"
import { LanguageError, type Declaration, type MeaningCheck, type Participant, type Program, type Role, type RoleKind } from "./model.js"

type Token = { readonly kind: "word" | "string" | "punctuation" | "eof"; readonly value: string; readonly line: number; readonly column: number }
const kinds = new Set(["kg", "url", "git_repo", "filesystem", "any"])
const tokenize = (source: string): Token[] => {
  const tokens: Token[] = []
  let offset = 0, line = 1, column = 1
  const advance = (text: string) => { for (const c of text) { if (c === "\n") { line++; column = 1 } else column++ }; offset += text.length }
  while (offset < source.length) {
    const tail = source.slice(offset)
    const whitespace = /^\s+/.exec(tail)
    if (whitespace) { advance(whitespace[0]); continue }
    if (tail.startsWith("//")) { advance(tail.split("\n")[0]!); continue }
    const start = { line, column }
    if (tail[0] === '"') {
      const match = /^"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(tail)
      if (!match) throw new LanguageError({ phase: "parse", detail: "invalid or unterminated JSON string", ...start })
      tokens.push({ kind: "string", value: JSON.parse(match[0]) as string, ...start }); advance(match[0]); continue
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(tail)
    if (word) { tokens.push({ kind: "word", value: word[0], ...start }); advance(word[0]); continue }
    if ("=;(),:".includes(tail[0]!)) { tokens.push({ kind: "punctuation", value: tail[0]!, ...start }); advance(tail[0]!); continue }
    throw new LanguageError({ phase: "parse", detail: `unexpected character ${JSON.stringify(tail[0])}`, ...start })
  }
  tokens.push({ kind: "eof", value: "<end>", line, column })
  return tokens
}

export const parseProgram = (source: string): Either.Either<Program, LanguageError> => Either.try({
  try: () => {
    const tokens = tokenize(source)
    let cursor = 0
    const peek = () => tokens[cursor]!
    const fail = (detail: string): never => { const t = peek(); throw new LanguageError({ phase: "parse", detail, line: t.line, column: t.column }) }
    const take = (kind: Token["kind"], value?: string) => {
      const t = peek()
      if (t.kind !== kind || value !== undefined && t.value !== value) return fail(`expected ${value ?? kind}, got ${t.value}`)
      cursor++; return t.value
    }
    const word = (value?: string) => take("word", value)
    const punctuation = (value: string) => take("punctuation", value)
    const string = () => take("string")
    const list = <T>(item: () => T): T[] => {
      punctuation("(")
      const items: T[] = []
      if (peek().value !== ")") { items.push(item()); while (peek().value === ",") { punctuation(","); items.push(item()) } }
      punctuation(")"); return items
    }
    word("usl"); const languageVersion = string(); punctuation(";")
    word("namespace"); const namespace = string(); punctuation(";")
    const declarations: Declaration[] = []
    while (peek().kind !== "eof") {
      const tag = word()
      const name = word()
      if (tag === "resource") {
        punctuation("="); declarations.push({ tag, name, locator: string() })
      } else if (tag === "meaning") {
        const roles = list<Role>(() => { const name = word(); punctuation(":"); const kind = word(); if (!kinds.has(kind)) return fail(`unknown resource kind ${kind}`); return { name, kind: kind as RoleKind } })
        punctuation("="); const description = string()
        let grounded: string | undefined
        let scope: string | undefined
        const checks: MeaningCheck[] = []
        while (peek().kind === "word" && ["grounded", "applies", "check"].includes(peek().value)) {
          if (peek().value === "grounded") {
            if (grounded !== undefined) return fail("duplicate grounded clause")
            word("grounded"); grounded = string()
          } else if (peek().value === "applies") {
            if (scope !== undefined) return fail("duplicate applies clause")
            word("applies"); scope = string()
          } else {
            word("check"); const checkName = word()
            const evidenceRoles = list<string>(() => word())
            punctuation("="); const checkDescription = string()
            checks.push({ name: checkName, evidenceRoles, description: checkDescription })
          }
        }
        if (checks.length > 0 && scope === undefined) return fail("checks require an applies clause")
        const contract = scope === undefined ? undefined : { scope, checks }
        declarations.push({ tag, name, roles, description, ...(grounded !== undefined ? { grounded } : {}), ...(contract !== undefined ? { contract } : {}) })
      } else if (tag === "link") {
        punctuation("="); const meaning = word()
        const participants = list<Participant>(() => { const role = word(); punctuation(":"); return { role, resource: word() } })
        declarations.push({ tag, name, meaning, participants })
      } else return fail(`unknown declaration ${tag}`)
      punctuation(";")
    }
    return { languageVersion, namespace, declarations }
  },
  catch: (e) => e instanceof LanguageError ? e : new LanguageError({ phase: "parse", detail: String(e) }),
})
