/** Host-owned Lean execution and pure adapters. Graph input never selects a command. */
import { execFile } from "node:child_process"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { Effect, Either } from "effect"
import { z } from "zod"
import { readUtf8Bounded } from "../bounded-read.js"
import { digestSource } from "../language/digest.js"
import { LanguageError } from "../language/model.js"
import type { AdaptedGraph } from "../adapters.js"
import { adaptResourceGraph, type ResourceGraph } from "./resource-graph.js"

const nonempty = z.string().min(1)
export const lean4ExportSchema = z.strictObject({
  schema: z.literal("usl-lean4-export/v1"), leanVersion: nonempty,
  declarations: z.array(z.strictObject({
    name: nonempty, kind: z.enum(["axiom", "definition", "theorem", "opaque", "quotient", "inductive", "constructor", "recursor"]),
    type: nonempty, axioms: z.array(nonempty), unsafe: z.boolean(), partial: z.boolean(),
  })).min(1),
  check: z.strictObject({
    status: z.literal("PROCESS_EXIT_ZERO"), file: nonempty, sourceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    warnings: z.array(z.string()),
  }).optional(),
})
export type Lean4Export = z.infer<typeof lean4ExportSchema>
export interface Lean4ReadConfig {
  readonly cwd: string
  readonly file: string
  /** Trusted host executable, typically lake. Runs `lake env lean --json FILE`. */
  readonly lake?: string
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly maxSourceBytes?: number
}
export interface Lean4AdaptOptions {
  readonly namespace: string
  readonly source: { readonly id: string; readonly locator: string }
  readonly bindings?: ReadonlyArray<{
    readonly declaration: string
    readonly resource: ResourceGraph["resources"][number]
    readonly description: string
  }>
}
const error = (value: unknown): LanguageError => value instanceof LanguageError ? value
  : new LanguageError({ phase: "compile", detail: String(value) })
const unwrap = <A, E>(value: Either.Either<A, E>): A => Either.getOrThrowWith(value, error => error)
const fail = (detail: string): never => { throw error(detail) }
const checked = (raw: string): Lean4Export => {
  const snapshot = lean4ExportSchema.parse(JSON.parse(raw))
  const names = snapshot.declarations.map(declaration => declaration.name)
  if (new Set(names).size !== names.length) fail("duplicate Lean declaration name")
  return snapshot
}
const runFile = promisify(execFile)
const limit = (value: number | undefined, fallback: number): number => {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1 || result > 2147483647) fail("invalid Lean execution limit")
  return result
}

/** Compilation is explicit host IO. No export is accepted from a failed process.
 * Source pin covers this export file; imported dependencies need the owner's build pins. */
export const readLean4Export = (input: Lean4ReadConfig): Effect.Effect<string, LanguageError> => Effect.tryPromise({
  try: async signal => {
    const config = structuredClone(input)
    if (!config.cwd?.trim() || !config.file?.trim() || config.lake === "") fail("Lean cwd, file and executable must be nonempty")
    const cwd = resolve(config.cwd), file = resolve(cwd, config.file)
    if (!file.endsWith(".lean")) fail("Lean export input must be a .lean file")
    const timeout = limit(config.timeoutMs, 30000), maxBuffer = limit(config.maxOutputBytes, 1024 * 1024)
    const maxSource = limit(config.maxSourceBytes, 1024 * 1024)
    const source = await readUtf8Bounded(file, maxSource)
    const { stdout } = await runFile(config.lake ?? "lake", ["env", "lean", "--json", file], {
      cwd, timeout, maxBuffer, encoding: "utf8", killSignal: "SIGKILL", signal,
    })
    if (await readUtf8Bounded(file, maxSource) !== source) fail("Lean export source changed during execution")
    const outputs: Lean4Export[] = [], warnings: string[] = []
    for (const line of stdout.split(/\r?\n/).filter(line => line.trim())) {
      const message = JSON.parse(line) as { severity?: string; data?: unknown }
      if (message.severity === "error") fail("Lean emitted an error diagnostic")
      if (message.severity === "warning" && typeof message.data === "string") warnings.push(message.data)
      if (message.severity === "information" && typeof message.data === "string" && message.data.startsWith("USL_LEAN4:")) {
        outputs.push(checked(message.data.slice("USL_LEAN4:".length)))
      }
    }
    if (outputs.length !== 1) fail("expected exactly one #usl_export message")
    return JSON.stringify({ ...outputs[0]!, check: { status: "PROCESS_EXIT_ZERO", file,
      sourceDigest: digestSource(source), warnings } })
  }, catch: error,
})

export const leanDeclarationId = (sourceId: string, declaration: string): string =>
  `urn:usl:lean4:${encodeURIComponent(sourceId)}:${encodeURIComponent(declaration)}`

/** Preserve the Lean report and explicitly authored external correspondences. */
export const lean4ResourceGraph = (raw: string, input: Lean4AdaptOptions): Either.Either<ResourceGraph, LanguageError> => Either.try({
  try: () => {
    const snapshot = checked(raw), options = structuredClone(input)
    const source = options.source
    const graph: ResourceGraph = {
      schema: "usl-resource-graph/v1",
      resources: [{ ...source, types: ["urn:usl:lean4:Source"], metadata: {
        leanVersion: snapshot.leanVersion, check: snapshot.check ?? null, evidence: "OWNER_REPORTED_LEAN_ENVIRONMENT",
      } }],
      meanings: [
        { id: "lean:declared_in", description: "The selected Lean declaration is reported by this export source." },
        { id: "lean:formalizes", description: "The author connects a Lean declaration to an external specification or resource; correspondence is not automatically proved." },
      ], links: [],
    }
    const declarations = new Set(snapshot.declarations.map(declaration => declaration.name))
    for (const declaration of snapshot.declarations) {
      const id = leanDeclarationId(source.id, declaration.name)
      graph.resources.push({ id, locator: source.locator, types: [`urn:usl:lean4:${declaration.kind}`], metadata: {
        ...declaration,
        proofStatus: declaration.kind === "axiom" ? "AXIOM" : declaration.axioms.includes("sorryAx") ? "USES_SORRY"
          : declaration.unsafe || declaration.partial ? "UNSAFE_OR_PARTIAL" : "DECLARATION_REPORTED",
      } })
      graph.links.push({ id: `${id}:declared_in`, meaning: "lean:declared_in", participants: [
        { role: "declaration", resource: id }, { role: "source", resource: source.id },
      ] })
    }
    const boundResources = new Map(graph.resources.map(resource => [resource.id, resource]))
    for (const binding of options.bindings ?? []) {
      if (!declarations.has(binding.declaration)) fail(`unknown Lean declaration: ${binding.declaration}`)
      const prior = boundResources.get(binding.resource.id)
      if (prior && JSON.stringify(prior) !== JSON.stringify(binding.resource)) fail(`conflicting bound resource: ${binding.resource.id}`)
      if (!prior) { graph.resources.push(binding.resource); boundResources.set(binding.resource.id, binding.resource) }
      const id = leanDeclarationId(source.id, binding.declaration)
      graph.links.push({ id: `${id}:formalizes:${encodeURIComponent(binding.resource.id)}`, meaning: "lean:formalizes",
        participants: [{ role: "formalization", resource: id }, { role: "subject", resource: binding.resource.id }],
        metadata: { description: binding.description, semanticTruth: "NOT_EVALUATED" } })
    }
    // Keep the public graph helper subject to the same integrity and locator checks.
    unwrap(adaptResourceGraph(JSON.stringify(graph), { namespace: options.namespace }))
    return graph
  }, catch: error,
})

export const adaptLean4Export = (raw: string, options: Lean4AdaptOptions): Either.Either<AdaptedGraph, LanguageError> => Either.try({
  try: () => {
    const graph = unwrap(lean4ResourceGraph(raw, options))
    const adapted = unwrap(adaptResourceGraph(JSON.stringify(graph), { namespace: options.namespace }))
    return Object.freeze({ ...adapted, source: Object.freeze({ adapter: "lean4/v1", digest: digestSource(raw) }) })
  }, catch: error,
})
