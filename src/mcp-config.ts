/** Administrator-owned startup configuration. Tool inputs never become paths. */
import { dirname, resolve } from "node:path"
import { Either } from "effect"
import { assertJsonData, DEFAULT_USL_POLICY, type UslOperationPolicy } from "./application.js"
import { parseLocator } from "./locator.js"
import { adaptPropertyGraph } from "./integrations/property-graph.js"
import { adaptResourceGraph } from "./integrations/resource-graph.js"
import { readUtf8Bounded } from "./bounded-read.js"
import { parseDomainProfile } from "./domain-profile.js"
import { parseCapabilityCatalog } from "./capability-catalog.js"

export interface FileGraphConnection { readonly graph: string; readonly namespace: string; readonly kgSource?: string; readonly format?: "property-graph" | "resource-graph"; readonly profile?: string }
export interface UslMcpFileConfig {
  readonly policy: UslOperationPolicy
  readonly programs: Readonly<Record<string, string>>
  readonly connections?: Readonly<Record<string, FileGraphConnection>>
  readonly capabilityCatalogs?: Readonly<Record<string, string>>
}
const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string`)
  return value
}
const keys = (value: Record<string, unknown>, allowed: readonly string[], label: string) => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`unknown ${label} field: ${key}`)
}
const namedFiles = (input: unknown, base: string, label: string): Readonly<Record<string, string>> =>
  Object.freeze(Object.fromEntries(Object.entries(record(input, `${label}s`)).map(([id, file]) => {
    text(id, `${label} ID`); return [id, resolve(base, text(file, `${label} file`))]
  })))
const connections = (input: unknown, base: string): Readonly<Record<string, FileGraphConnection>> => {
  const value = record(input, "connections")
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([id, raw]) => {
    text(id, "connection ID")
    const entry = record(raw, `connection ${id}`)
    keys(entry, ["graph", "namespace", "kgSource", "format", "profile"], `connection ${id}`)
    const format = entry.format
    if (format !== undefined && format !== "property-graph" && format !== "resource-graph") throw new Error("invalid connection format")
    if (format === "resource-graph" && entry.kgSource !== undefined) throw new Error("resource-graph uses explicit locators, not kgSource")
    if (entry.profile !== undefined && format !== "resource-graph") throw new Error("profile requires resource-graph")
    const namespace = text(entry.namespace, "namespace")
    if (namespace !== namespace.trim()) throw new Error("namespace must not have surrounding whitespace")
    const kgSource = entry.kgSource
    if (kgSource !== undefined && (typeof kgSource !== "string" || !/^[A-Za-z0-9._-]+$/.test(kgSource))) throw new Error("invalid kgSource")
    return [id, Object.freeze({ graph: resolve(base, text(entry.graph, "graph")), namespace,
      ...(entry.profile === undefined ? {} : { profile: resolve(base, text(entry.profile, "profile")) }),
      ...(kgSource === undefined ? {} : { kgSource: kgSource as string }), ...(format === undefined ? {} : { format }) })]
  })))
}

export const parseMcpConfig = (encoded: string, baseDirectory: string, label = "USL_MCP_POLICY"): UslMcpFileConfig => {
  let input: unknown
  try { input = JSON.parse(encoded) } catch { throw new Error(`${label} must be JSON`) }
  assertJsonData(input)
  const data = record(input, label)
  const required = ["allowedLocators", "maxResources", "maxInputBytes", "maxOutputBytes", "programs"]
  keys(data, [...required, "connections", "capabilityCatalogs"], label)
  for (const key of required) if (!Object.hasOwn(data, key)) throw new Error(`${label}.${key} is required`)
  if (!Array.isArray(data.allowedLocators) || data.allowedLocators.some(value => typeof value !== "string" || Either.isLeft(parseLocator(value)))) throw new Error(`${label}.allowedLocators must contain valid locators`)
  const limit = (key: string) => {
    const value = data[key]
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label}.${key} must be a nonnegative safe integer`)
    return value
  }
  const programs = namedFiles(data.programs, baseDirectory, "program")
  return { policy: Object.freeze({ allowedLocators: Object.freeze([...data.allowedLocators] as string[]), maxResources: limit("maxResources"), maxInputBytes: limit("maxInputBytes"), maxOutputBytes: limit("maxOutputBytes") }),
    programs, ...(data.connections === undefined ? {} : { connections: connections(data.connections, baseDirectory) }),
    ...(data.capabilityCatalogs === undefined ? {} : { capabilityCatalogs: namedFiles(data.capabilityCatalogs, baseDirectory, "capability catalog") }) }
}

export const readMcpConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): UslMcpFileConfig => {
  const encoded = env.USL_MCP_POLICY
  return !encoded ? { policy: DEFAULT_USL_POLICY, programs: {} } : parseMcpConfig(encoded, process.cwd())
}

/** Relative graph/program paths belong to the config file, not the client's cwd. */
export const readMcpConfig = async (file?: string, env: NodeJS.ProcessEnv = process.env): Promise<UslMcpFileConfig> => {
  if (file === undefined) return readMcpConfigFromEnv(env)
  if (env.USL_MCP_POLICY) throw new Error("choose --config or USL_MCP_POLICY, not both")
  const path = resolve(text(file, "config path"))
  return parseMcpConfig(await readUtf8Bounded(path, DEFAULT_USL_POLICY.maxInputBytes), dirname(path), "MCP config")
}

export const fileConnectionResolver = (input: Readonly<Record<string, FileGraphConnection>>, maxBytes: number): NonNullable<UslOperationPolicy["getConnection"]> => {
  assertJsonData(input)
  const registered = connections(structuredClone(input), process.cwd())
  return async id => {
    if (!Object.hasOwn(registered, id)) throw new Error(`unknown connection: ${id}`)
    const connection = registered[id]!
    const raw = await readUtf8Bounded(connection.graph, maxBytes)
    if (connection.format === "resource-graph") {
      const profile = connection.profile === undefined ? undefined : parseDomainProfile(JSON.parse(await readUtf8Bounded(connection.profile, maxBytes)))
      return Either.getOrThrowWith(adaptResourceGraph(raw, { namespace: connection.namespace, ...(profile === undefined ? {} : { profile }) }), failure => failure)
    }
    return Either.getOrThrowWith(adaptPropertyGraph(raw, { namespace: connection.namespace,
      ...(connection.kgSource === undefined ? {} : { kgSource: connection.kgSource }) }), failure => failure)
  }
}

/** Every request reads the selected registered file; invalid edits never fall back to old policy. */
export const fileCapabilityCatalogResolver = (input: Readonly<Record<string, string>>, maxBytes: number): NonNullable<UslOperationPolicy["getCapabilityCatalog"]> => {
  assertJsonData(input)
  const registered = namedFiles(structuredClone(input), process.cwd(), "capability catalog")
  return async id => {
    if (!Object.hasOwn(registered, id)) throw new Error(`unknown capability catalog: ${id}`)
    return parseCapabilityCatalog(JSON.parse(await readUtf8Bounded(registered[id]!, maxBytes)), maxBytes)
  }
}
