#!/usr/bin/env node
/**
 * Optional owner-side companion for an offline rule-weight review.  It is not
 * wired into the USL core CLI: a caller explicitly supplies both its host
 * registration and learner executable.
 */
import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { parseArgs } from "node:util"
import { readUtf8Bounded } from "../src/bounded-read.js"
import { runCliProcess } from "../src/cli-process.js"

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_ARTIFACT_BYTES = 16 * 1024 * 1024
const MAX_DATASET_EVIDENCE = 200
const MAX_LEARNER_OUTPUT_BYTES = 4 * 1024 * 1024
const LEARNER_TIMEOUT_MS = 30_000

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type ReviewBridge = {
  prepareRuleWeightReview: (handoff: unknown, host: unknown, artifacts: unknown) => unknown
  completeRuleWeightReview: (prepared: unknown, replayInput: unknown) => unknown
}

class UsageError extends Error {}
const sha256 = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`
const output = (value: unknown): string => JSON.stringify(value, null, 2) + "\n"
const usage = [
  "Usage: tsx scripts/rule-weight-review.ts --handoff FILE --host FILE --learner EXECUTABLE [--out NEW_FILE]",
  "",
  "Runs an explicitly selected offline learner: `w validate DATASET`, then `w replay DATASET REPORT`.",
  "The learner is caller-selected and is not attested or authorized by this command. No policy or HSWM state is applied.",
].join("\n")

const requireText = (value: string | undefined, flag: string): string => {
  if (!value?.trim()) throw new UsageError(`--${flag} is required`)
  return value
}
const json = (text: string, label: string): Json => {
  try { return JSON.parse(text) as Json }
  catch (error) { throw new Error(`${label} must contain JSON: ${error instanceof Error ? error.message : String(error)}`) }
}
const realFile = async (file: string, label: string): Promise<string> => {
  const resolved = await fs.realpath(file).catch(error => { throw new Error(`${label} is unavailable: ${error instanceof Error ? error.message : String(error)}`) })
  const info = await fs.stat(resolved)
  if (!info.isFile()) throw new Error(`${label} must be a regular file`)
  return resolved
}
const readJsonFile = async (file: string, label: string): Promise<{ readonly path: string; readonly raw: string; readonly value: Json }> => {
  const resolved = await realFile(file, label)
  const raw = await readUtf8Bounded(resolved, MAX_ARTIFACT_BYTES)
  return { path: resolved, raw, value: json(raw, label) }
}
const object = (value: Json, label: string): Record<string, Json> => {
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new Error(`${label} must be a JSON object`)
  return value
}
const artifactPath = async (root: string, relative: unknown, label: string): Promise<string> => {
  if (typeof relative !== "string" || !relative.trim()) throw new Error(`handoff artifacts.${label} must be a nonempty relative path`)
  if (path.isAbsolute(relative)) throw new Error(`handoff artifacts.${label} must be relative`)
  const lexical = path.resolve(root, relative)
  const lexicalRelative = path.relative(root, lexical)
  if (!lexicalRelative || lexicalRelative === ".." || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative)) {
    throw new Error(`handoff artifacts.${label} escapes handoff root`)
  }
  const resolved = await realFile(lexical, `handoff artifacts.${label}`)
  // The staged learner resolves the handoff's lexical relative references.
  // Preserve that meaning by rejecting aliases rather than staging a different
  // normalized name for an input reached through a symlink.
  if (resolved !== lexical) throw new Error(`handoff artifacts.${label} must not traverse a symlink`)
  const actualRelative = path.relative(root, resolved)
  if (!actualRelative || actualRelative === ".." || actualRelative.startsWith(`..${path.sep}`) || path.isAbsolute(actualRelative)) {
    throw new Error(`handoff artifacts.${label} resolves outside handoff root`)
  }
  return resolved
}
const readArtifacts = async (handoffFile: string, handoff: Json) => {
  const root = path.dirname(handoffFile)
  const declared = object(object(handoff, "--handoff").artifacts ?? (() => { throw new Error("handoff.artifacts is required") })(), "handoff.artifacts")
  const names = ["dataset", "report", "baselineSource", "candidateSource"] as const
  const paths = await Promise.all(names.map(name => artifactPath(root, declared[name], name)))
  if (new Set(paths).size !== paths.length) throw new Error("handoff artifact paths must be distinct")
  const loaded = await Promise.all(paths.map(async (artifact, index) => {
    const raw = await readUtf8Bounded(artifact, MAX_ARTIFACT_BYTES)
    return { name: names[index]!, path: artifact, relativePath: path.relative(root, artifact), raw, value: json(raw, `handoff artifacts.${names[index]!}`) }
  }))
  const bytes = loaded.reduce((total, artifact) => total + Buffer.byteLength(artifact.raw, "utf8"), 0)
  if (bytes > MAX_TOTAL_ARTIFACT_BYTES) throw new Error("handoff artifacts exceed total byte budget")
  const runtime = Object.fromEntries(loaded.map(artifact => [artifact.name, artifact.raw]))
  const sources = Object.fromEntries(loaded.map(artifact => [artifact.name, { path: artifact.path, relativePath: artifact.relativePath, raw: artifact.raw, digest: sha256(artifact.raw) }]))
  const values = Object.fromEntries(loaded.map(artifact => [artifact.name, artifact.value]))
  // Runtime receives parsed frozen inputs and exact source-byte pins.  It owns
  // semantic pin checks and deliberately has no filesystem or process access.
  return { runtime, sources, values }
}
const datasetEvidence = async (handoffRoot: string, datasetPath: string, dataset: Json, usedBytes: number) => {
  const datasetRoot = path.dirname(datasetPath)
  const entries = object(dataset, "dataset").evidence
  if (!Array.isArray(entries) || entries.length > MAX_DATASET_EVIDENCE) throw new Error("dataset.evidence must be an array within its entry limit")
  const names = new Set<string>(), paths = new Set<string>()
  const loaded: Array<{ readonly path: string; readonly relativePath: string; readonly raw: string }> = []
  let total = usedBytes
  for (const entry of entries) {
    const record = object(entry as Json, "dataset evidence entry")
    if (typeof record.id !== "string" || !record.id || names.has(record.id)) throw new Error("dataset evidence IDs must be unique")
    names.add(record.id)
    if (typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error("dataset evidence sha256 must be lowercase hex")
    // HSWM resolves source evidence relative to the dataset itself, rather
    // than relative to the outer USL handoff file.
    const source = await artifactPath(datasetRoot, record.path, `dataset evidence ${record.id}`)
    if (paths.has(source)) throw new Error("dataset evidence paths must be distinct")
    paths.add(source)
    const raw = await readUtf8Bounded(source, MAX_ARTIFACT_BYTES)
    total += Buffer.byteLength(raw, "utf8")
    if (total > MAX_TOTAL_ARTIFACT_BYTES) throw new Error("review inputs exceed total byte budget")
    if (sha256(raw) !== `sha256:${record.sha256}`) throw new Error(`dataset evidence hash mismatch: ${record.id}`)
    const relativePath = path.relative(handoffRoot, source)
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) throw new Error("dataset evidence resolves outside handoff root")
    loaded.push({ path: source, relativePath, raw })
  }
  return loaded
}
const stage = async (inputs: ReadonlyArray<{ readonly path: string; readonly relativePath: string; readonly raw: string }>) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "usl-rule-weight-review-"))
  try {
    const paths = new Set<string>()
    for (const input of inputs) {
      if (!input.relativePath || input.relativePath === ".." || input.relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(input.relativePath)) throw new Error("unsafe staged relative path")
      const target = path.resolve(directory, input.relativePath)
      const relation = path.relative(directory, target)
      if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) throw new Error("unsafe staged target path")
      if (paths.has(target)) continue
      paths.add(target)
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
      await fs.writeFile(target, input.raw, { encoding: "utf8", flag: "wx", mode: 0o600 })
    }
    const source = (original: string) => {
      const item = inputs.find(input => input.path === original)
      if (!item) throw new Error("staged source is missing")
      return path.join(directory, item.relativePath)
    }
    return { directory, source }
  } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error }
}
const runLearner = async (executable: string, cwd: string, args: readonly string[]) => {
  // PATH is retained only for a selected executable's shebang interpreter
  // (for example `/usr/bin/env python3`); arguments remain an exact array.
  const result = await runCliProcess({ executable, args, cwd, env: { PATH: process.env.PATH ?? "" }, input: "", timeoutMs: LEARNER_TIMEOUT_MS, maxOutputBytes: MAX_LEARNER_OUTPUT_BYTES })
  if (result.reason !== null) throw new Error(`learner ${args.slice(1).join(" ")} failed: ${result.reason}`)
  const value = json(result.stdout, `learner ${args.slice(1).join(" ")} stdout`)
  return { value, receipt: { exitCode: result.exitCode, stdoutDigest: sha256(result.stdout), stderrDigest: sha256(result.stderr), outputBytes: result.outputBytes } }
}
const validateLearnerOutput = (value: Json, dataset: Json): void => {
  const validation = object(value, "learner validate stdout")
  if (validation.schema !== "hswm-w-learning/v1" || validation.status !== "VALID" || validation.sourceBytesVerified !== true
    || validation.inputDigest !== sha256(JSON.stringify(dataset)).slice("sha256:".length)) throw new Error("learner validate receipt does not bind the staged dataset")
  const episodes = object(dataset, "dataset").episodes, contexts = object(object(dataset, "dataset").graph ?? (() => { throw new Error("dataset.graph is required") })(), "dataset graph").contexts
  if (validation.episodes !== undefined && (!Number.isSafeInteger(validation.episodes) || !Array.isArray(episodes) || validation.episodes !== episodes.length)) throw new Error("learner validate episode count mismatch")
  if (validation.contexts !== undefined && (!Number.isSafeInteger(validation.contexts) || !Array.isArray(contexts) || validation.contexts !== contexts.length)) throw new Error("learner validate context count mismatch")
}
const assertNewOutput = async (file: string, inputs: readonly string[]): Promise<string> => {
  const absolute = path.resolve(file)
  if (inputs.some(input => path.resolve(input) === absolute)) throw new UsageError("--out must differ from all inputs")
  const parent = await fs.realpath(path.dirname(absolute)).catch(error => { throw new UsageError(`--out parent is unavailable: ${error instanceof Error ? error.message : String(error)}`) })
  if (!(await fs.stat(parent)).isDirectory()) throw new UsageError("--out parent must be a directory")
  const target = path.join(parent, path.basename(absolute))
  const prior = await fs.lstat(target).catch(error => (error as NodeJS.ErrnoException).code === "ENOENT" ? null : Promise.reject(error))
  if (prior !== null) throw new UsageError("--out must name a new file")
  return target
}
const publishNew = async (file: string, text: string): Promise<void> => {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`)
  try {
    const handle = await fs.open(temp, "wx", 0o600)
    try { await handle.writeFile(text); await handle.sync() } finally { await handle.close() }
    await fs.link(temp, file).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new UsageError("--out became occupied; review receipt was not published")
      throw error
    })
  } finally { await fs.rm(temp, { force: true }) }
}

const main = async (): Promise<void> => {
  const values = parseArgs({ args: process.argv.slice(2), allowPositionals: false, options: {
    handoff: { type: "string" }, host: { type: "string" }, learner: { type: "string" }, out: { type: "string" }, help: { type: "boolean" },
  } }).values
  if (values.help) { process.stdout.write(`${usage}\n`); return }
  const handoffInput = await readJsonFile(requireText(values.handoff, "handoff"), "--handoff")
  const hostInput = await readJsonFile(requireText(values.host, "host"), "--host")
  const learner = await realFile(requireText(values.learner, "learner"), "--learner")
  const artifacts = await readArtifacts(handoffInput.path, handoffInput.value)
  const bridge = await import("../src/addons/rule-weight-review.js") as unknown as ReviewBridge
  // All pins are checked before either external program is started.
  const prepared = bridge.prepareRuleWeightReview(handoffInput.value, hostInput.value, artifacts.runtime)
  const outputPath = values.out === undefined ? undefined : await assertNewOutput(values.out, [handoffInput.path, hostInput.path, learner, ...Object.values(artifacts.sources).map(source => source.path)])
  const primary = Object.values(artifacts.sources)
  const primaryBytes = Buffer.byteLength(handoffInput.raw, "utf8") + Buffer.byteLength(hostInput.raw, "utf8")
    + primary.reduce((total, input) => total + Buffer.byteLength(input.raw, "utf8"), 0)
  const handoffRoot = path.dirname(handoffInput.path)
  const extra = await datasetEvidence(handoffRoot, artifacts.sources.dataset!.path, artifacts.values.dataset!, primaryBytes)
  const staged = await stage([...primary, ...extra])
  let validation: Awaited<ReturnType<typeof runLearner>>, replay: Awaited<ReturnType<typeof runLearner>>
  let validationArgs: readonly string[] = [], replayArgs: readonly string[] = []
  try {
    const dataset = staged.source(artifacts.sources.dataset!.path), report = staged.source(artifacts.sources.report!.path)
    validationArgs = ["w", "validate", dataset]
    replayArgs = ["w", "replay", dataset, report]
    validation = await runLearner(learner, staged.directory, validationArgs)
    validateLearnerOutput(validation.value, artifacts.values.dataset!)
    replay = await runLearner(learner, staged.directory, replayArgs)
  } finally { await fs.rm(staged.directory, { recursive: true, force: true }) }
  const completed = bridge.completeRuleWeightReview(prepared, replay.value)
  const receipt = {
    schema: "usl-rule-weight-review-cli-receipt/v1", review: completed,
    learner: { executable: learner, runtimeTrust: "CALLER_SELECTED_EXECUTABLE_NOT_ATTESTED",
      validation: { args: validationArgs, ...validation.receipt }, replay: { args: replayArgs, ...replay.receipt } },
    execution: "LOCAL_REVIEW_ONLY", authority: "NOT_GRANTED",
  }
  const text = output(receipt)
  if (outputPath === undefined) process.stdout.write(text)
  else { await publishNew(outputPath, text); process.stdout.write(output({ out: outputPath })) }
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = error instanceof UsageError ? 64 : 1 })
