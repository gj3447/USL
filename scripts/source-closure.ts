/**
 * Local code dependency closure for evidence pins.
 *
 * A receipt should pin the code its checks actually load, not every file in
 * src/.  Starting from declared entry files (tests, replay cases, spawned CLI
 * scripts), this follows:
 *  - static, dynamic and type imports with relative specifiers (`./x.js` -> `x.ts`);
 *  - string literals that name a repository code file, because tests and
 *    recorders also start code as subprocesses (`"src/cli.ts"`,
 *    `join(root, "src", "cli.ts")`, `new URL("../src/mcp.ts", import.meta.url)`).
 * Bare package specifiers are covered by the package manifest/lock pins.
 * Literal matching over-approximates on purpose; an unresolved relative import
 * fails closed.  Usage: node --import tsx scripts/source-closure.ts ENTRY...
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const CODE_ROOTS = ["src", "scripts", "test", "examples"] as const
const PARSED = /\.(?:[cm]?ts|tsx)$/
const LITERAL_CODE = /[A-Za-z0-9_.@/-]+\.[cm]?ts(?![A-Za-z0-9_])/g

const toPosix = (path: string) => path.split(sep).join("/")
const isFile = (path: string) => existsSync(path) && statSync(path).isFile()

const walk = (root: string, directory: string, out: string[]) => {
  const absolute = resolve(root, directory)
  if (!existsSync(absolute)) return
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const child = `${directory}/${entry.name}`
    if (entry.isDirectory()) walk(root, child, out)
    else if (entry.isFile() && PARSED.test(entry.name)) out.push(child)
  }
}

/** Repository-relative code file for a relative import specifier, or undefined. */
const resolveImport = (root: string, from: string, specifier: string): string | undefined => {
  const base = resolve(root, dirname(from), specifier)
  const candidates = [base, base.replace(/\.js$/, ".ts"), base.replace(/\.mjs$/, ".mts"), base.replace(/\.cjs$/, ".cts"),
    base.replace(/\.jsx$/, ".tsx"), `${base}.ts`, `${base}/index.ts`]
  const found = candidates.find(isFile)
  return found === undefined ? undefined : toPosix(relative(root, found))
}

const literals = (file: string, text: string): string[] => {
  const out: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) out.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true))
  return out
}

/** Sorted repository-relative paths: the entries plus every local code file they load. */
export const sourceClosure = (root: string, entries: readonly string[]): string[] => {
  const known: string[] = []
  for (const directory of CODE_ROOTS) walk(root, directory, known)
  const byBasename = new Map<string, string[]>()
  for (const path of known) byBasename.set(basename(path), [...(byBasename.get(basename(path)) ?? []), path])
  const inside = (absolute: string) => {
    const path = relative(root, absolute)
    return path !== "" && !path.startsWith("..") && !isAbsolute(path) ? toPosix(path) : undefined
  }
  const seen = new Set<string>(), queue = [...entries]
  while (queue.length > 0) {
    const path = queue.pop()!
    if (seen.has(path)) continue
    if (!isFile(resolve(root, path))) throw new Error(`closure entry or dependency is missing: ${path}`)
    seen.add(path)
    if (!PARSED.test(path)) continue
    const text = readFileSync(resolve(root, path), "utf8")
    for (const imported of ts.preProcessFile(text, true, true).importedFiles) {
      if (!imported.fileName.startsWith(".")) continue
      const target = resolveImport(root, path, imported.fileName)
      if (target === undefined) throw new Error(`${path}: unresolved relative import ${imported.fileName}`)
      queue.push(target)
    }
    for (const literal of literals(path, text)) for (const token of literal.match(LITERAL_CODE) ?? []) {
      if (!token.includes("/")) { queue.push(...(byBasename.get(token) ?? [])); continue }
      for (const absolute of [resolve(root, dirname(path), token), resolve(root, token)]) {
        const target = inside(absolute)
        if (target !== undefined && CODE_ROOTS.some(dir => target.startsWith(`${dir}/`)) && isFile(absolute)) queue.push(target)
      }
    }
  }
  return [...seen].sort()
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const entries = process.argv.slice(2)
  if (entries.length === 0) throw new Error("usage: source-closure.ts ENTRY...")
  console.log(JSON.stringify(sourceClosure(resolve(dirname(fileURLToPath(import.meta.url)), ".."), entries)))
}
