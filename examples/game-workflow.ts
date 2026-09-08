/**
 * Synthetic, local-only benchmark for selected-link observation in one game
 * feature. It is an executable example, not a performance claim.
 */
import { Either, Effect, Layer } from "effect"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { agentContext, compareObservations, compileSource, observeProgram, resolveWith, Resolvers, type ResolverConfig } from "../src/index.js"

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const fixtureDirectory = path.join(moduleDirectory, "fixtures", "game-workflow")
const fixturePlan = path.join(fixtureDirectory, "game-workflow.usl")
const host = "game-workflow-fixture"

type Comparison = ReturnType<typeof compare>

const compile = (text: string) => Either.getOrThrowWith(compileSource(text), (error) => error)
const compare = (previous: unknown, current: unknown) => Either.getOrThrowWith(compareObservations(previous, current), (error) => error)

const observe = async (source: string, config: ResolverConfig, links?: readonly string[]) => {
  const calls: string[] = []
  const layer = Layer.succeed(Resolvers, {
    resolve: (locator, options) => {
      calls.push(locator.kind === "filesystem" ? `file://${locator.host}${locator.path}` : locator.kind)
      const requested = options?.allowedLocators
      const allowedLocators = config.allowedLocators === undefined ? requested
        : requested === undefined ? config.allowedLocators
        : config.allowedLocators.filter((value) => requested.includes(value))
      return resolveWith(allowedLocators === undefined ? config : { ...config, allowedLocators })(locator)
    },
  })
  const plan = compile(source)
  const selectedAllowlist = links?.includes("dash_behavior")
    ? config.allowedLocators?.filter((locator) => /\/(dash-spec\.md|dash-controller(?:-moved)?\.ts|dash-controller\.test\.ts)$/.test(locator))
    : config.allowedLocators
  const started = performance.now()
  const observation = await Effect.runPromise(observeProgram(plan, {
    ...(links === undefined ? {} : { links }),
    ...(selectedAllowlist === undefined ? {} : { allowedLocators: selectedAllowlist }),
    maxResources: 16,
    sourceText: source,
  }).pipe(Effect.provide(layer)))
  return { observation, elapsedMs: performance.now() - started, calls }
}

const locatorFor = (directory: string, file: string) => `file://${host}${path.join(directory, file)}`
const fixtureName = (locator: string) => new URL(locator).pathname.split("/").at(-1)!
const templateFor = async (directory: string) => (await readFile(fixturePlan, "utf8")).replaceAll("__FIXTURE_ROOT__", directory)
const allowedFor = (directory: string) => [
  "dash-spec.md", "dash-controller.ts", "dash-controller.test.ts", "audio-mix.md", "music-license.txt", "dash-controller-moved.ts",
].map((file) => locatorFor(directory, file))

export interface GameWorkflowArtifact {
  readonly schema: "usl-game-workflow-benchmark/v1"
  readonly label: "synthetic_fixture_local_reads"
  readonly methods: {
    readonly repository_scan: { readonly observationElapsedMs: number; readonly resolverCalls: number; readonly locators: readonly string[] }
    readonly targeted_link_lookup: { readonly navigationElapsedMs: number; readonly observationElapsedMs: number; readonly resolverCalls: number; readonly locators: readonly string[] }
  }
  /** Attribution retained with the benchmark report; locators stay local to the run. */
  readonly observedMeaningVersions: Readonly<Record<"baseline" | "contentEdit" | "semanticReversal" | "addressMove", {
    readonly planDigest: string
    readonly meaningsDigest: string
    readonly sourceDigest: string | null
    readonly links: ReadonlyArray<{ readonly name: string; readonly meaningDigest: string; readonly contractDigest: string }>
  }>>
  readonly changes: {
    readonly evidenceContentEdit: Comparison
    readonly semanticReversal: Comparison
    readonly addressMove: Comparison
  }
  readonly counters: {
    readonly referenceLookupReads: number
    readonly targetedLookupReads: number
    readonly staleEvidenceCaught: number
    readonly unnecessaryRechecksAvoided: number
  }
}

export const runGameWorkflow = async (): Promise<GameWorkflowArtifact> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "usl-game-workflow-"))
  try {
    await cp(fixtureDirectory, directory, { recursive: true })
    const source = await templateFor(directory)
    const config: ResolverConfig = {
      hostname: host,
      gitRepos: {},
      kgMcpUrl: "http://unused.invalid/mcp",
      allowedLocators: allowedFor(directory),
      fetchImpl: fetch,
    }

    const repositoryScan = await observe(source, config)
    const navigationStarted = performance.now()
    const context = Either.getOrThrowWith(agentContext(compile(source), { focus: "dash_spec", target: "dash_code" }), (error) => error)
    const navigationElapsedMs = performance.now() - navigationStarted
    const targeted = await observe(source, config, context.links.map((link) => link.name))

    const baseline = targeted.observation
    await writeFile(path.join(directory, "dash-controller.ts"), "export const dashCooldownSeconds = 0.4\nexport const canDash = (grounded: boolean, cooldownRemaining: number) => grounded && cooldownRemaining <= 0\n")
    const contentEdit = await observe(source, config, ["dash_behavior"])

    await cp(path.join(fixtureDirectory, "dash-controller.ts"), path.join(directory, "dash-controller.ts"))
    const reversedSource = source.replace(
      "구현은 명세의 지상 상태 전용 대시와 0.35초 쿨다운 규칙을 구현한다",
      "구현은 공중 대시를 허용하며 0.35초 쿨다운 규칙을 구현한다",
    )
    const semanticReversal = await observe(reversedSource, config, ["dash_behavior"])

    const movedSource = source.replace("/dash-controller.ts\"", "/dash-controller-moved.ts\"")
    const addressMove = await observe(movedSource, config, ["dash_behavior"])

    const evidenceContentEdit = compare(baseline, contentEdit.observation)
    const semanticComparison = compare(baseline, semanticReversal.observation)
    const addressComparison = compare(baseline, addressMove.observation)
    const dashChange = evidenceContentEdit.links.find((link) => link.name === "dash_behavior")
    const identity = (observation: typeof baseline) => ({
      planDigest: observation.planDigest,
      meaningsDigest: observation.meaningsDigest,
      sourceDigest: observation.sourceDigest,
      links: observation.links.map((link) => ({ name: link.name, meaningDigest: link.meaningDigest, contractDigest: link.contractDigest })),
    })
    return {
      schema: "usl-game-workflow-benchmark/v1",
      label: "synthetic_fixture_local_reads",
      methods: {
        repository_scan: { observationElapsedMs: repositoryScan.elapsedMs, resolverCalls: repositoryScan.calls.length, locators: repositoryScan.calls.map(fixtureName) },
        targeted_link_lookup: { navigationElapsedMs, observationElapsedMs: targeted.elapsedMs, resolverCalls: targeted.calls.length, locators: targeted.calls.map(fixtureName) },
      },
      observedMeaningVersions: { baseline: identity(baseline), contentEdit: identity(contentEdit.observation), semanticReversal: identity(semanticReversal.observation), addressMove: identity(addressMove.observation) },
      changes: { evidenceContentEdit, semanticReversal: semanticComparison, addressMove: addressComparison },
      counters: {
        referenceLookupReads: repositoryScan.calls.length,
        targetedLookupReads: targeted.calls.length,
        staleEvidenceCaught: dashChange !== undefined && dashChange.contentChanged.length > 0 ? 1 : 0,
        unnecessaryRechecksAvoided: Math.max(0, repositoryScan.calls.length - targeted.calls.length),
      },
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await runGameWorkflow(), null, 2))
}
