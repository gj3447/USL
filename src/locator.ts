// Pure locator grammar: parse <-> format is a lawful round-trip (tested as a BX PutGet-style check).
//   kg://<source>/<uid>
//   http(s)://...
//   git://<host>/<org>/<name>@<commit>:<path>[::<symbol>][@L<a>-L<b>]
//   file://<host><abs-path>[#L<a>-L<b>]      (RFC 8089 shape; host required)
import { Data, Either } from "effect"
import type { Locator, FsLocator, GitLocator, KgLocator, UrlLocator } from "./domain.js"

export class LocatorParseError extends Data.TaggedError("LocatorParseError")<{ readonly input: string; readonly reason: string }> {
  get message() { return this.reason }
}

const GIT_RE = /^git:\/\/([^@\s]+)@([0-9a-fA-F]{7,64}):([^:\s@]+(?:\/[^:\s@]*)*)(?:::([^@\s]+))?(?:@L(\d+)-L(\d+))?$/
const FILE_RE = /^file:\/\/([A-Za-z0-9._-]+)(\/(?!\/)[^#\s]*)(?:#L(\d+)-L(\d+))?$/
const KG_RE = /^kg:\/\/([A-Za-z0-9._-]+)\/(\S+)$/

export const parseLocator = (input: string): Either.Either<Locator, LocatorParseError> => {
  if (typeof input !== "string") return Either.left(new LocatorParseError({ input: String(input), reason: "locator must be a string" }))
  const s = input.trim()
  if (s.startsWith("kg://")) {
    const m = KG_RE.exec(s)
    return m ? Either.right<Locator>({ kind: "kg", source: m[1]!, uid: m[2]! }) : Either.left(new LocatorParseError({ input, reason: "kg://<source>/<uid> expected" }))
  }
  if (/^https?:\/\//i.test(s)) {
    try { new URL(s); return Either.right<Locator>({ kind: "url", href: s }) } catch { return Either.left(new LocatorParseError({ input, reason: "invalid URL" })) }
  }
  if (s.startsWith("git://")) {
    const root = /^git:\/\/([A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+)(?:@([0-9a-fA-F]{7,64}))?$/.exec(s)
    if (root && !root[1]!.split("/").some((p) => p === "." || p === ".." || p === "")) return Either.right<Locator>({ kind: "git_repo", repo: root[1]!, ...(root[2] ? { commit: root[2] } : {}) })
    const m = GIT_RE.exec(s)
    if (!m) return Either.left(new LocatorParseError({ input, reason: "git://<repo-id>@<commit>:<path>[::<symbol>][@L<a>-L<b>] expected" }))
    const loc: GitLocator = { kind: "git_repo", repo: m[1]!, commit: m[2]!, path: m[3]!, ...(m[4] ? { symbol: m[4] } : {}), ...(m[5] && m[6] ? { lineStart: Number(m[5]), lineEnd: Number(m[6]) } : {}) }
    if (loc.path!.startsWith("/") || loc.path!.split("/").some((p) => p === ".." || p === "." || p === ""))
      return Either.left(new LocatorParseError({ input, reason: "git path must be repository-relative without dot or empty segments" }))
    if (!validLines(loc)) return Either.left(new LocatorParseError({ input, reason: "line range requires safe integers: 1 <= start <= end" }))
    return Either.right<Locator>(loc)
  }
  if (s.startsWith("file://")) {
    const m = FILE_RE.exec(s)
    if (!m) return Either.left(new LocatorParseError({ input, reason: "file://<host><abs-path>[#L<a>-L<b>] expected (host required, path absolute)" }))
    const loc: FsLocator = { kind: "filesystem", host: m[1]!, path: m[2]!, ...(m[3] && m[4] ? { lineStart: Number(m[3]), lineEnd: Number(m[4]) } : {}) }
    if (!validLines(loc)) return Either.left(new LocatorParseError({ input, reason: "line range requires safe integers: 1 <= start <= end" }))
    return Either.right<Locator>(loc)
  }
  return Either.left(new LocatorParseError({ input, reason: "unknown locator scheme (kg:// | http(s):// | git:// | file://)" }))
}

export const validLines = (l: { readonly lineStart?: number | undefined; readonly lineEnd?: number | undefined }): boolean =>
  l.lineStart === undefined && l.lineEnd === undefined ||
  Number.isSafeInteger(l.lineStart) && Number.isSafeInteger(l.lineEnd) && l.lineStart! >= 1 && l.lineEnd! >= l.lineStart!

export const formatLocator = (l: Locator): string => {
  switch (l.kind) {
    case "kg": return `kg://${l.source}/${l.uid}`
    case "url": return l.href
    case "git_repo": return `git://${l.repo}${l.commit ? `@${l.commit}` : ""}${l.path ? `:${l.path}` : ""}${l.symbol ? `::${l.symbol}` : ""}${l.lineStart !== undefined && l.lineEnd !== undefined ? `@L${l.lineStart}-L${l.lineEnd}` : ""}`
    case "filesystem": return `file://${l.host}${l.path}${l.lineStart !== undefined && l.lineEnd !== undefined ? `#L${l.lineStart}-L${l.lineEnd}` : ""}`
  }
}

export const kindOf = (l: Locator) => l.kind
export type { KgLocator, UrlLocator, GitLocator, FsLocator }
