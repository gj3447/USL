#!/usr/bin/env node
import { Effect, Either, Layer } from "effect"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { parseArgs } from "node:util"
import { TOOL_VERSION } from "./domain.js"
import { audit, pierce, rebind } from "./pierce.js"
import { toBundle, type ProjectOptions } from "./project.js"
import { ConfigLive, ResolversLive } from "./resolve.js"
import { runPlatformCommand, PLATFORM_USAGE, PlatformUsageError } from "./cli-platform.js"
import { runAdapterCommand, ADAPTER_USAGE } from "./cli-adapter.js"
import { runCapabilityCommand, CAPABILITY_USAGE } from "./cli-capabilities.js"
import { runCliHostCommand, CLI_HOST_USAGE } from "./cli-host-command.js"
import { readRecords, writeRecords, writeTextAtomic } from "./storage.js"
import { agentContext, compactAgentContext, compareObservations, compileSource, observeProgram, toSemanticBundle, validateObservation, type NavigationQuery } from "./language/index.js"

class UsageError extends Error {}
const canonicalPath = async (file: string): Promise<string> => fs.realpath(file).catch(() => path.resolve(file))
const requireDistinctOutput = async (out: string, inputs: ReadonlyArray<string>, message: string): Promise<void> => {
  const output = await canonicalPath(out)
  for (const input of inputs) if (output === await canonicalPath(input)) throw new UsageError(message)
}
const usage = `USL ${TOOL_VERSION}
  usl check --source FILE.usl
  usl compile --source FILE.usl [--out PLAN.json]
  usl context --source FILE.usl --focus NAME [--target NAME] [--max-hops N] [--max-resources N] [--max-links N] [--max-visits N] [--via MEANING:ENTER:EXIT] [--out CONTEXT.json]
    [--compact] [--max-bytes N] [--known-context SHA256] [--stats]
  usl observe --source FILE.usl [--link NAME] [--allow-locator LOC | --deny-all] [--max-resources N] [--baseline REPORT.json] [--out REPORT.json]
  usl project --source FILE.usl --out BUNDLE.json --bundle-uid UID --utterance-file FILE
  usl pierce --link-id ID --relation REL --from LOC --to LOC [--records FILE] [--replace]
  usl audit --records FILE [--write] [--check]
  usl rebind --records FILE --link-id ID
  usl validate --records FILE
  usl project --records FILE --out FILE --bundle-uid UID --utterance-file FILE [--anchors FILE]
${PLATFORM_USAGE}
${ADAPTER_USAGE}
${CAPABILITY_USAGE}
${CLI_HOST_USAGE}

Audit preserves the original snapshot; rebind explicitly replaces it after both ends resolve.
Exit: 0 success, 1 operation/validation failure, 2 observation unresolved/changed or audit --check drift, 64 usage error.`
const main = async () => {
  if (await runCapabilityCommand(process.argv.slice(2))) return
  if (await runCliHostCommand(process.argv.slice(2))) return
  if (await runAdapterCommand(process.argv.slice(2))) return
  if (await runPlatformCommand(process.argv.slice(2))) return
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === "--help" || cmd === "help" || rest.includes("--help")) { console.log(usage); return }
  if (!cmd || !["check", "compile", "context", "observe", "pierce", "audit", "rebind", "validate", "project"].includes(cmd)) throw new UsageError(usage)
  let parsed: ReturnType<typeof parseCli>
  try { parsed = parseCli(rest) } catch (e) { throw new UsageError(String(e)) }
  const { values } = parsed
  if (cmd !== "observe" && [values.link, values["allow-locator"], values["deny-all"], values.baseline].some((v) => v !== undefined)) throw new UsageError("--link, --allow-locator, --deny-all and --baseline are observe options")
  if (cmd !== "context" && [values.compact, values["max-bytes"], values["known-context"], values.stats].some((v) => v !== undefined)) throw new UsageError("--compact, --max-bytes, --known-context and --stats are context options")
  if (!values.compact && [values["max-bytes"], values["known-context"], values.stats].some((v) => v !== undefined)) throw new UsageError("--max-bytes, --known-context and --stats require --compact")
  const required = (name: keyof typeof values): string => {
    const value = values[name]
    if (typeof value !== "string" || !value.trim()) throw new UsageError(`--${name} is required for ${cmd}`)
    return value
  }
  const recordsPath = values.records ?? "usl-records.json"
  const command = `usl ${process.argv.slice(2).join(" ")}`
  const live = () => ResolversLive.pipe(Layer.provide(ConfigLive()))
  if (["check", "compile", "context", "observe"].includes(cmd) || cmd === "project" && values.source !== undefined) {
    if (values.records !== undefined) throw new UsageError("--source and --records are separate inputs; choose one")
    const sourcePath = required("source")
    const sourceText = await fs.readFile(sourcePath, "utf8")
    const compiled = compileSource(sourceText)
    if (Either.isLeft(compiled)) throw compiled.left
    const plan = compiled.right
    if (cmd === "check") console.log(JSON.stringify({ valid: true, namespace: plan.namespace, resources: plan.resources.length, meanings: plan.meanings.length, links: plan.links.length }))
    else if (cmd === "observe") {
      if (values["deny-all"] && values["allow-locator"] !== undefined) throw new UsageError("choose --allow-locator or --deny-all")
      if (values["max-resources"] !== undefined && !/^\d+$/.test(values["max-resources"])) throw new UsageError("--max-resources must be a nonnegative integer")
      const previous = values.baseline ? Either.getOrThrowWith(validateObservation(JSON.parse(await fs.readFile(values.baseline, "utf8"))), (e) => e) : undefined
      if (previous && previous.namespace !== plan.namespace) throw new UsageError("baseline namespace differs from source")
      if (values.out) {
        const existingOut = await fs.realpath(values.out).catch(() => path.resolve(values.out!))
        for (const input of [sourcePath, ...(values.baseline ? [values.baseline] : [])]) {
          if (existingOut === await fs.realpath(input)) throw new UsageError("--out must differ from --source and --baseline")
        }
      }
      const result = await Effect.runPromise(observeProgram(plan, {
        sourceText,
        ...(values.link !== undefined ? { links: values.link } : {}),
        ...(values["deny-all"] ? { allowedLocators: [] } : values["allow-locator"] !== undefined ? { allowedLocators: values["allow-locator"] } : {}),
        ...(values["max-resources"] !== undefined ? { maxResources: Number(values["max-resources"]) } : {}),
      }).pipe(Effect.provide(live())))
      const comparison = previous ? Either.getOrThrowWith(compareObservations(previous, result), (e) => e) : undefined
      if (values.out) await writeTextAtomic(values.out, JSON.stringify(result, null, 2) + "\n")
      console.log(JSON.stringify(comparison ? { observation: result, comparison } : result))
      if (result.status === "UNRESOLVED" || comparison?.links.some((l) => l.actions.length > 0)) process.exitCode = 2
    } else {
      let output: unknown = plan
      let compactText: string | undefined
      if (cmd === "context") {
        const numeric = (flag: "max-hops" | "max-resources" | "max-links" | "max-visits"): number | undefined => {
          const value = values[flag]
          if (value === undefined) return undefined
          if (!/^\d+$/.test(value)) throw new UsageError(`--${flag} must be a nonnegative integer`)
          return Number(value)
        }
        const routes = values.via?.map((value) => {
          const parts = value.split(":")
          if (parts.length !== 3 || parts.some((p) => !p)) throw new UsageError("--via must be MEANING:ENTER:EXIT")
          return { meaning: parts[0]!, enter: parts[1]!, exit: parts[2]! }
        })
        const limits: Record<string, number> = {}
        for (const [flag, field] of [["max-hops", "maxHops"], ["max-resources", "maxResources"], ["max-links", "maxLinks"], ["max-visits", "maxVisits"]] as const) {
          const value = numeric(flag)
          if (value !== undefined) limits[field] = value
        }
        const query: NavigationQuery = { focus: required("focus"), ...limits, ...(values.target !== undefined ? { target: values.target } : {}), ...(routes !== undefined ? { routes } : {}) }
        if (values.compact) {
          if (values["max-bytes"] !== undefined && !/^\d+$/.test(values["max-bytes"])) throw new UsageError("--max-bytes must be a nonnegative integer")
          const context = compactAgentContext(plan, query, {
            ...(values["max-bytes"] !== undefined ? { maxBytes: Number(values["max-bytes"]) } : {}),
            ...(values["known-context"] !== undefined ? { knownContextDigest: values["known-context"] } : {}),
          })
          if (Either.isLeft(context)) throw new UsageError(context.left.message)
          compactText = context.right.text
          if (values.stats) console.error(JSON.stringify(context.right.stats))
        } else {
          const context = agentContext(plan, query)
          if (Either.isLeft(context)) throw new UsageError(context.left.message)
          output = context.right
        }
      }
      if (cmd === "project") {
        required("out")
        const bundle_uid = required("bundle-uid"), utteranceFile = required("utterance-file")
        const utterance = (await fs.readFile(utteranceFile, "utf8")).replace(/\r?\n$/, "")
        const rawAnchors: unknown = values.anchors ? JSON.parse(await fs.readFile(values.anchors, "utf8")) : {}
        if (!rawAnchors || typeof rawAnchors !== "object" || Array.isArray(rawAnchors) || !Object.values(rawAnchors).every((v) => typeof v === "string")) throw new UsageError("language --anchors must map KG locators to target-graph UIDs")
        const projected = toSemanticBundle(plan, { bundle_uid, title: values.title ?? `USL ${plan.namespace}`, trigger: { user_utterance_verbatim: utterance, utterance_date: values.date ?? new Date().toISOString().slice(0, 10), tool: TOOL_VERSION }, evidence: values.evidence ?? [], source: { name: sourcePath, text: sourceText }, kgAnchors: rawAnchors as Record<string, string>, ...(values["target-kg-source"] ? { targetKgSource: values["target-kg-source"] } : {}) })
        if (Either.isLeft(projected)) throw projected.left
        output = projected.right
      }
      const json = compactText ?? JSON.stringify(output, null, 2) + "\n"
      if (values.out) {
        await requireDistinctOutput(values.out, [sourcePath, ...(cmd === "project" ? [values["utterance-file"], values.anchors].filter((v): v is string => v !== undefined) : [])], "--out must differ from --source and other input files")
        await writeTextAtomic(values.out, json)
        console.log(JSON.stringify({ out: values.out, namespace: plan.namespace }))
      } else process.stdout.write(json)
    }
    return
  }
  if (values.source !== undefined) throw new UsageError(`--source is not supported by ${cmd}`)
  if (cmd === "pierce") {
    const link_id = required("link-id"), semantic_relation = required("relation"), from = required("from"), to = required("to")
    const direction = values.direction ?? "directed"
    if (direction !== "directed" && direction !== "undirected") throw new UsageError("--direction must be directed or undirected")
    const snapshot = await readRecords(recordsPath, true)
    if (!values.replace && snapshot.records.some((r) => r.link_id === link_id)) throw new UsageError(`link ${link_id} already exists; use rebind or pierce --replace`)
    const out = await Effect.runPromise(pierce({ link_id, semantic_relation, from, to, direction, command }).pipe(Effect.provide(live())))
    const records = [...snapshot.records.filter((r) => r.link_id !== link_id), out.record]
    await writeRecords(snapshot, records)
    console.log(JSON.stringify({ status: out.record.status, confidence: out.record.confidence, guarantee_level: out.record.guarantee_level, notes: out.notes, records: records.length }))
  } else if (cmd === "audit") {
    const snapshot = await readRecords(recordsPath)
    const reports = await Effect.runPromise(Effect.all(snapshot.records.map(audit), { concurrency: 4 }).pipe(Effect.provide(live())))
    if (values.write) await writeRecords(snapshot, reports.map((r) => r.updated))
    for (const report of reports) console.log(JSON.stringify(report))
    if (values.check && reports.some((r) => r.after !== "RESOLVES")) process.exitCode = 2
  } else if (cmd === "rebind") {
    const id = required("link-id")
    const snapshot = await readRecords(recordsPath)
    const current = snapshot.records.find((r) => r.link_id === id)
    if (!current) throw new UsageError(`unknown link_id: ${id}`)
    const out = await Effect.runPromise(rebind(current, { command }).pipe(Effect.provide(live())))
    await writeRecords(snapshot, snapshot.records.map((r) => r.link_id === id ? out.record : r))
    console.log(JSON.stringify({ link_id: id, status: out.record.status, records: snapshot.records.length }))
  } else if (cmd === "validate") {
    const snapshot = await readRecords(recordsPath)
    console.log(JSON.stringify({ valid: true, records: snapshot.records.length }))
  } else if (cmd === "project") {
    const out = required("out"), bundle_uid = required("bundle-uid"), utteranceFile = required("utterance-file")
    const snapshot = await readRecords(recordsPath)
    await requireDistinctOutput(out, [snapshot.path, utteranceFile, ...(values.anchors ? [values.anchors] : [])], "--out must differ from --records, --utterance-file and --anchors")
    const utterance = (await fs.readFile(utteranceFile, "utf8")).replace(/\r?\n$/, "")
    const endAnchors = values.anchors ? JSON.parse(await fs.readFile(values.anchors, "utf8")) as ProjectOptions["endAnchors"] : undefined
    if (endAnchors !== undefined && (endAnchors === null || typeof endAnchors !== "object" || Array.isArray(endAnchors))) throw new UsageError("--anchors must contain an object keyed by link_id")
    const bundle = toBundle(snapshot.records, { bundle_uid, title: values.title ?? "USL link records", trigger: { user_utterance_verbatim: utterance, utterance_date: values.date ?? new Date().toISOString().slice(0, 10), tool: TOOL_VERSION }, evidence: values.evidence ?? [], ...(endAnchors ? { endAnchors } : {}), ...(values["target-kg-source"] ? { targetKgSource: values["target-kg-source"] } : {}) })
    await writeTextAtomic(out, JSON.stringify(bundle, null, 2) + "\n")
    console.log(JSON.stringify({ nodes: bundle.nodes.length, relations: bundle.relations.length, anchors: bundle.anchors.length, out }))
  }
}
const parseCli = (args: string[]) => parseArgs({ args, options: {
  "link-id": { type: "string" }, relation: { type: "string" }, from: { type: "string" }, to: { type: "string" }, direction: { type: "string" }, records: { type: "string" },
  write: { type: "boolean" }, check: { type: "boolean" }, replace: { type: "boolean" }, out: { type: "string" }, "bundle-uid": { type: "string" }, title: { type: "string" },
  "utterance-file": { type: "string" }, date: { type: "string" }, anchors: { type: "string" }, evidence: { type: "string", multiple: true }, "target-kg-source": { type: "string" }, source: { type: "string" },
  focus: { type: "string" }, target: { type: "string" }, "max-hops": { type: "string" }, "max-resources": { type: "string" }, "max-links": { type: "string" }, "max-visits": { type: "string" }, via: { type: "string", multiple: true },
  link: { type: "string", multiple: true }, "allow-locator": { type: "string", multiple: true }, "deny-all": { type: "boolean" }, baseline: { type: "string" },
  compact: { type: "boolean" }, "max-bytes": { type: "string" }, "known-context": { type: "string" }, stats: { type: "boolean" },
}, allowPositionals: false })
main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = e instanceof UsageError || e instanceof PlatformUsageError ? 64 : 1 })
