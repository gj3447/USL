/**
 * Adapt a read-only property-graph export into declared USL links.
 * This adapter never connects to a database, runs Cypher, resolves a locator,
 * or treats graph properties as authority.
 */
import { createHash } from "node:crypto"
import { Either } from "effect"
import { parseLocator } from "../locator.js"
import { compileProgram } from "../language/compiler.js"
import { digestSource } from "../language/digest.js"
import { LanguageError, type MeaningContract, type Program, type SemanticPlan } from "../language/model.js"

type ObjectValue = Record<string, unknown>
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value)
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
const identifier = (prefix: string, identity: string) => `${prefix}_${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`
const freeze = <A>(value: A): A => {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}
const fail = (detail: string, phase: "parse" | "compile" = "compile"): never => { throw new LanguageError({ phase, detail }) }

export interface PropertyGraphAdaptation {
  readonly plan: SemanticPlan
  readonly source: { readonly adapter: "property-graph/v1"; readonly digest: string }
  readonly identities: { readonly resources: Readonly<Record<string, string>>; readonly links: Readonly<Record<string, string>> }
}
export interface PropertyGraphAdaptOptions { readonly namespace: string; readonly kgSource?: string }

interface NodeInput { readonly uid: string; readonly properties: ObjectValue }
interface ParticipantInput { readonly role: string; readonly uid: string }
interface RelationInput {
  readonly identity: string
  readonly uid: string | undefined
  readonly fromUid: string
  readonly toUid: string
  readonly type: string
  readonly description: string
  readonly contract: MeaningContract | undefined
  readonly participants: ReadonlyArray<ParticipantInput>
}

const checkedProperties = (value: unknown, label: string): ObjectValue => {
  if (value === undefined) return {}
  if (!object(value)) fail(`${label} must be an object when supplied`)
  return value
}
const checkedContract = (value: unknown): MeaningContract | undefined => {
  if (value === undefined) return undefined
  if (!object(value)) fail("relation properties.contract must be an object")
  const keys = Object.keys(value)
  if (keys.some((key) => key !== "scope" && key !== "checks") || !nonEmpty(value.scope) || !Array.isArray(value.checks)) fail("relation properties.contract is invalid")
  const names = new Set<string>()
  const checks = value.checks.map((raw, index) => {
    if (!object(raw) || Object.keys(raw).some((key) => key !== "name" && key !== "description" && key !== "evidenceRoles") || !nonEmpty(raw.name) || !nonEmpty(raw.description) || !Array.isArray(raw.evidenceRoles) || raw.evidenceRoles.length === 0 || !raw.evidenceRoles.every(nonEmpty) || names.has(raw.name)) fail(`relation contract check ${index} is invalid`)
    names.add(raw.name)
    return { name: raw.name, description: raw.description, evidenceRoles: [...raw.evidenceRoles] }
  })
  return { scope: value.scope, checks }
}
const checkedParticipants = (value: unknown, fromUid: string, toUid: string): ReadonlyArray<ParticipantInput> => {
  if (value === undefined) return [{ role: "source", uid: fromUid }, { role: "target", uid: toUid }]
  if (!Array.isArray(value) || value.length < 2) fail("relation properties.participants must contain at least two participants")
  const roles = new Set<string>()
  const participants = value.map((raw, index) => {
    if (!object(raw) || Object.keys(raw).some((key) => key !== "role" && key !== "uid") || !nonEmpty(raw.role) || !nonEmpty(raw.uid) || roles.has(raw.role)) fail(`relation participant ${index} is invalid`)
    roles.add(raw.role)
    return { role: raw.role, uid: raw.uid }
  })
  if (!participants.some((entry) => entry.uid === fromUid) || !participants.some((entry) => entry.uid === toUid)) fail("relation participants must include from_uid and to_uid")
  return participants
}

const parseInput = (rawText: string, options: PropertyGraphAdaptOptions) => {
  if (!nonEmpty(rawText)) fail("property-graph rawText must be non-empty", "parse")
  if (!object(options) || !nonEmpty(options.namespace) || options.namespace !== options.namespace.trim()) fail("property-graph namespace is required")
  if (options.kgSource !== undefined && (!nonEmpty(options.kgSource) || !/^[A-Za-z0-9._-]+$/.test(options.kgSource))) fail("property-graph kgSource is invalid")
  let raw: unknown
  try { raw = JSON.parse(rawText) } catch { fail("property-graph rawText must be JSON", "parse") }
  if (!object(raw) || Object.keys(raw).some((key) => key !== "nodes" && key !== "relations") || !Array.isArray(raw.nodes) || !Array.isArray(raw.relations)) fail("property-graph bundle needs only nodes and relations")
  const nodes: NodeInput[] = []
  const nodeUids = new Set<string>()
  for (const [index, rawNode] of raw.nodes.entries()) {
    if (!object(rawNode) || Object.keys(rawNode).some((key) => key !== "uid" && key !== "properties") || !nonEmpty(rawNode.uid) || nodeUids.has(rawNode.uid)) fail(`node ${index} has an invalid or duplicate uid`)
    const properties = checkedProperties(rawNode.properties, `node ${rawNode.uid} properties`)
    if (properties.locator !== undefined && (!nonEmpty(properties.locator) || Either.isLeft(parseLocator(properties.locator)))) fail(`node ${rawNode.uid} locator must be a USL locator`)
    if (properties.locator === undefined && options.kgSource === undefined) fail(`node ${rawNode.uid} needs properties.locator or kgSource`)
    nodeUids.add(rawNode.uid); nodes.push({ uid: rawNode.uid, properties })
  }
  const relations: RelationInput[] = [], relationIds = new Set<string>()
  for (const [index, rawRelation] of raw.relations.entries()) {
    if (!object(rawRelation) || Object.keys(rawRelation).some((key) => key !== "uid" && key !== "from_uid" && key !== "to_uid" && key !== "type" && key !== "properties") || (rawRelation.uid !== undefined && !nonEmpty(rawRelation.uid)) || !nonEmpty(rawRelation.from_uid) || !nonEmpty(rawRelation.to_uid) || !nonEmpty(rawRelation.type)) fail(`relation ${index} is invalid`)
    if (!nodeUids.has(rawRelation.from_uid) || !nodeUids.has(rawRelation.to_uid)) fail(`relation ${index} references a missing endpoint`)
    const properties = checkedProperties(rawRelation.properties, `relation ${index} properties`)
    if (properties.description !== undefined && !nonEmpty(properties.description)) fail(`relation ${index} description must be a non-empty string`)
    const identity = rawRelation.uid === undefined ? `derived:${JSON.stringify({ from_uid: rawRelation.from_uid, to_uid: rawRelation.to_uid, type: rawRelation.type })}` : rawRelation.uid
    if (relationIds.has(identity)) fail(`relation ${index} has a duplicate identity`)
    relationIds.add(identity)
    relations.push({ identity, ...(rawRelation.uid === undefined ? {} : { uid: rawRelation.uid }), fromUid: rawRelation.from_uid, toUid: rawRelation.to_uid, type: rawRelation.type,
      description: properties.description === undefined ? `Declared KG relation: ${rawRelation.type}` : properties.description,
      contract: checkedContract(properties.contract), participants: checkedParticipants(properties.participants, rawRelation.from_uid, rawRelation.to_uid) })
  }
  return { nodes, relations }
}

/** Convert a supplied property-graph JSON snapshot into a compiled declaration plan. */
export const adaptPropertyGraph = (rawText: string, options: PropertyGraphAdaptOptions): Either.Either<PropertyGraphAdaptation, LanguageError> => Either.try({
  try: () => {
    if (!object(options)) fail("property-graph options are required")
    // Capture each option before validation or compilation; later accessor reads
    // cannot splice a different namespace or fallback source into this snapshot.
    const namespace = options.namespace, kgSource = options.kgSource
    const capturedOptions: PropertyGraphAdaptOptions = { namespace, ...(kgSource === undefined ? {} : { kgSource }) }
    const parsed = parseInput(rawText, capturedOptions)
    const resourceNames = new Map(parsed.nodes.map((node) => [node.uid, identifier("pg_resource", node.uid)]))
    const declarations: Program["declarations"] = parsed.nodes.map((node) => ({ tag: "resource", name: resourceNames.get(node.uid)!, locator: node.properties.locator === undefined ? `kg://${options.kgSource}/${node.uid}` : node.properties.locator as string }))
    const links: Record<string, string> = {}, resources: Record<string, string> = Object.fromEntries(resourceNames)
    for (const relation of parsed.relations) {
      const link = identifier("pg_link", relation.identity), meaning = identifier("pg_meaning", relation.identity)
      links[relation.identity] = link
      const roleNames = new Map<string, string>(relation.participants.map((participant) => [participant.role, identifier("pg_role", participant.role)]))
      const roles = relation.participants.map((participant) => ({ name: roleNames.get(participant.role)!, kind: "any" as const }))
      const contract = relation.contract === undefined ? undefined : {
        scope: relation.contract.scope,
        checks: relation.contract.checks.map((check) => ({ name: identifier("pg_check", check.name), description: check.description,
          evidenceRoles: check.evidenceRoles.map((role) => roleNames.get(role) ?? fail(`relation ${relation.identity} contract references unknown participant role ${role}`)) })),
      }
      declarations.push({ tag: "meaning", name: meaning, roles, description: relation.description, ...(contract === undefined ? {} : { contract }) })
      declarations.push({ tag: "link", name: link, meaning, participants: relation.participants.map((participant) => ({ role: roleNames.get(participant.role)!, resource: resourceNames.get(participant.uid) ?? fail(`relation ${relation.identity} references missing participant`) })) })
    }
    const compiled = compileProgram({ languageVersion: "0.1", namespace: capturedOptions.namespace, declarations })
    if (Either.isLeft(compiled)) throw compiled.left
    return freeze({ plan: compiled.right, source: { adapter: "property-graph/v1" as const, digest: digestSource(rawText) }, identities: { resources, links } })
  },
  catch: (error) => error instanceof LanguageError ? error : new LanguageError({ phase: "compile", detail: String(error) }),
})
