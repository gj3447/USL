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
const uslIdentifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
const requiredText = (value: unknown, detail: string): string => {
  if (!nonEmpty(value)) fail(detail)
  return value as string
}
const identifier = (prefix: string, identity: string) => `${prefix}_${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`
const freeze = <A>(value: A): A => {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}
const fail = (detail: string, phase: "parse" | "compile" = "compile"): never => { throw new LanguageError({ phase, detail }) }

export interface PropertyGraphAdaptation {
  readonly plan: SemanticPlan
  /** v2 binds the directed native relation tuple and description presence. */
  readonly source: { readonly adapter: "property-graph/v2"; readonly digest: string }
  readonly identities: { readonly resources: Readonly<Record<string, string>>; readonly links: Readonly<Record<string, string>> }
}
export interface PropertyGraphAdaptOptions { readonly namespace: string; readonly kgSource?: string }

interface NodeInput { readonly uid: string; readonly properties: ObjectValue }
interface ParticipantInput { readonly role: string; readonly uid: string }
interface RelationInput {
  readonly identity: string
  readonly uid?: string
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
  return value as ObjectValue
}
const checkedContract = (value: unknown): MeaningContract | undefined => {
  if (value === undefined) return undefined
  if (!object(value)) fail("relation properties.contract must be an object")
  const contract = value as ObjectValue, keys = Object.keys(contract)
  if (keys.some((key) => key !== "scope" && key !== "checks") || !nonEmpty(contract.scope) || !Array.isArray(contract.checks)) fail("relation properties.contract is invalid")
  const names = new Set<string>()
  const checks = (contract.checks as unknown[]).map((raw: unknown, index: number) => {
    if (!object(raw)) fail(`relation contract check ${index} is invalid`)
    const check = raw as ObjectValue
    if (Object.keys(check).some((key) => key !== "name" && key !== "description" && key !== "evidenceRoles") || !uslIdentifier(check.name) || !nonEmpty(check.description) || !Array.isArray(check.evidenceRoles) || check.evidenceRoles.length === 0 || !check.evidenceRoles.every(uslIdentifier) || names.has(check.name)) fail(`relation contract check ${index} is invalid`)
    const name = check.name as string, description = check.description as string, evidenceRoles = [...check.evidenceRoles as unknown[]] as string[]
    names.add(name)
    return { name, description, evidenceRoles }
  })
  return { scope: requiredText(contract.scope, "relation properties.contract is invalid"), checks }
}
const checkedParticipants = (value: unknown, fromUid: string, toUid: string): ReadonlyArray<ParticipantInput> => {
  if (value === undefined) return [{ role: "source", uid: fromUid }, { role: "target", uid: toUid }]
  if (!Array.isArray(value) || value.length < 2) fail("relation properties.participants must contain at least two participants")
  const roles = new Set<string>()
  const participants = (value as unknown[]).map((raw: unknown, index: number) => {
    if (!object(raw)) fail(`relation participant ${index} is invalid`)
    const participant = raw as ObjectValue
    if (Object.keys(participant).some((key) => key !== "role" && key !== "uid") || !uslIdentifier(participant.role) || !nonEmpty(participant.uid) || roles.has(participant.role)) fail(`relation participant ${index} is invalid`)
    const role = participant.role as string, uid = participant.uid as string
    roles.add(role)
    return { role, uid }
  })
  if (!participants.some((entry) => entry.uid === fromUid) || !participants.some((entry) => entry.uid === toUid)) fail("relation participants must include from_uid and to_uid")
  // Roles are named bindings, not an ordered edge-list. Canonicalize only this
  // role→UID mapping; the raw source digest retains the owner's original bytes.
  return participants.sort((a, b) => a.role < b.role ? -1 : a.role > b.role ? 1 : 0)
}

const parseInput = (rawText: string, options: PropertyGraphAdaptOptions) => {
  if (!nonEmpty(rawText)) fail("property-graph rawText must be non-empty", "parse")
  if (!object(options) || !nonEmpty(options.namespace) || options.namespace !== options.namespace.trim()) fail("property-graph namespace is required")
  if (options.kgSource !== undefined && (!nonEmpty(options.kgSource) || !/^[A-Za-z0-9._-]+$/.test(options.kgSource))) fail("property-graph kgSource is invalid")
  let raw: unknown
  try { raw = JSON.parse(rawText) } catch { fail("property-graph rawText must be JSON", "parse") }
  if (!object(raw)) fail("property-graph bundle needs only nodes and relations")
  const bundle = raw as ObjectValue
  if (!Array.isArray(bundle.nodes) || !Array.isArray(bundle.relations)) fail("property-graph bundle needs nodes and relations")
  const nodes: NodeInput[] = []
  const nodeUids = new Set<string>()
  for (const [index, rawNode] of (bundle.nodes as unknown[]).entries()) {
    if (!object(rawNode)) fail(`node ${index} has an invalid or duplicate uid`)
    const node = rawNode as ObjectValue, uid = requiredText(node.uid, `node ${index} has an invalid or duplicate uid`)
    if (nodeUids.has(uid)) fail(`node ${index} has an invalid or duplicate uid`)
    const properties = checkedProperties(node.properties, `node ${uid} properties`)
    if (properties.locator !== undefined && (!nonEmpty(properties.locator) || Either.isLeft(parseLocator(properties.locator)))) fail(`node ${uid} locator must be a USL locator`)
    if (properties.locator === undefined && options.kgSource === undefined) fail(`node ${uid} needs properties.locator or kgSource`)
    nodeUids.add(uid); nodes.push({ uid, properties })
  }
  const relations: RelationInput[] = [], relationIds = new Set<string>()
  for (const [index, rawRelation] of (bundle.relations as unknown[]).entries()) {
    if (!object(rawRelation)) fail(`relation ${index} is invalid`)
    const relation = rawRelation as ObjectValue
    if ((relation.uid !== undefined && !nonEmpty(relation.uid)) || !nonEmpty(relation.from_uid) || !nonEmpty(relation.to_uid) || !nonEmpty(relation.type)) fail(`relation ${index} is invalid`)
    const fromUid = relation.from_uid as string, toUid = relation.to_uid as string, type = relation.type as string, uid = relation.uid as string | undefined
    if (!nodeUids.has(fromUid) || !nodeUids.has(toUid)) fail(`relation ${index} references a missing endpoint`)
    const properties = checkedProperties(relation.properties, `relation ${index} properties`)
    if (properties.description !== undefined && !nonEmpty(properties.description)) fail(`relation ${index} description must be a non-empty string`)
    const identity = uid === undefined ? `derived:${JSON.stringify({ from_uid: fromUid, to_uid: toUid, type })}` : uid
    if (relationIds.has(identity)) fail(`relation ${index} has a duplicate identity`)
    relationIds.add(identity)
    // Neo4j relationships have an ordered start/end pair and exactly one type.
    // Preserve that tuple independently of an optional n-ary participant view.
    // `description: null` is deliberately distinct from a supplied string.
    const description = JSON.stringify({ schema: "property-graph-meaning/v2", type,
      direction: { from_uid: fromUid, to_uid: toUid }, description: properties.description ?? null })
    relations.push({ identity, ...(uid === undefined ? {} : { uid }), fromUid, toUid, type, description,
      contract: checkedContract(properties.contract), participants: checkedParticipants(properties.participants, fromUid, toUid) })
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
    const declarations: Array<Program["declarations"][number]> = [...parsed.nodes].sort((a, b) => a.uid.localeCompare(b.uid)).map((node) => ({ tag: "resource", name: resourceNames.get(node.uid)!, locator: node.properties.locator === undefined ? `kg://${capturedOptions.kgSource}/${node.uid}` : node.properties.locator as string }))
    const links: Record<string, string> = Object.create(null) as Record<string, string>, resources: Record<string, string> = Object.fromEntries(resourceNames)
    for (const relation of [...parsed.relations].sort((a, b) => a.identity.localeCompare(b.identity))) {
      const link = identifier("pg_link", relation.identity), meaning = identifier("pg_meaning", relation.identity)
      links[relation.identity] = link
      const roleNames = new Map<string, string>(relation.participants.map((participant) => [participant.role, participant.role]))
      const roles = relation.participants.map((participant) => ({ name: roleNames.get(participant.role)!, kind: "any" as const }))
      const contract = relation.contract === undefined ? undefined : {
        scope: relation.contract.scope,
        checks: relation.contract.checks.map((check) => ({ name: check.name, description: check.description,
          evidenceRoles: check.evidenceRoles.map((role) => roleNames.get(role) ?? fail(`relation ${relation.identity} contract references unknown participant role ${role}`)) })),
      }
      declarations.push({ tag: "meaning", name: meaning, roles, description: relation.description, ...(contract === undefined ? {} : { contract }) })
      declarations.push({ tag: "link", name: link, meaning, participants: relation.participants.map((participant) => ({ role: roleNames.get(participant.role)!, resource: resourceNames.get(participant.uid) ?? fail(`relation ${relation.identity} references missing participant`) })) })
    }
    const compiled = compileProgram({ languageVersion: "0.1", namespace: capturedOptions.namespace, declarations })
    if (Either.isLeft(compiled)) throw compiled.left
    return freeze({ plan: compiled.right, source: { adapter: "property-graph/v2" as const, digest: digestSource(rawText) }, identities: { resources, links } })
  },
  catch: (error) => error instanceof LanguageError ? error : new LanguageError({ phase: "compile", detail: String(error) }),
})
