/** Build a small, portable graph of current USL syntax/CLI facts and proposed graph work. */
import { readFile, writeFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { Either } from "effect"
import { digestSource } from "../src/language/digest.js"
import { adaptResourceGraph, resourceGraphJsonLd, type ResourceGraph } from "../src/integrations/resource-graph.js"
import { checkResourceGraphProfile, type DomainProfile } from "../src/domain-profile.js"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const check = process.argv.slice(2).includes("--check")
if (process.argv.slice(2).some(arg => arg !== "--check")) throw new Error("usage: build-syntax-cli-architecture.ts [--check]")
const read = (file: string) => readFile(resolve(root, file), "utf8")
const catalog = JSON.parse(await read("research/architecture/syntax-cli.catalog.json")) as { schema: string; authority: string; sourceCommit: string; sourcePins: Record<string, string>; userStatements: Array<{ id: string; status: string; text: string }>; implemented: Array<[string, string, string[]]>; proposals: Array<[string, string, string]> }
if (catalog.schema !== "usl-syntax-cli-architecture-catalog/v1" || catalog.authority !== "SECONDARY_AI" || !/^[a-f0-9]{40}$/.test(catalog.sourceCommit) ||
  !catalog.sourcePins || !Array.isArray(catalog.userStatements) || !Array.isArray(catalog.implemented) || !Array.isArray(catalog.proposals)) throw new Error("invalid syntax-cli architecture catalog")
for (const statement of catalog.userStatements) if (!/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/.test(statement.id) || statement.status !== "USER_PRIMARY" || !statement.text.trim()) throw new Error("invalid user statement")
for (const item of catalog.implemented) if (!Array.isArray(item) || item.length !== 3 || !item[0].startsWith("feature:") || !item[1].trim() || !Array.isArray(item[2]) || item[2].some(path => typeof path !== "string" || !path.startsWith("src/"))) throw new Error("invalid implemented feature")
for (const item of catalog.proposals) if (!Array.isArray(item) || item.length !== 3 || !item[0].startsWith("proposal:") || item.slice(1).some(value => !value.trim())) throw new Error("invalid proposal")
const commit = catalog.sourceCommit
const prefix = "urn:usl:syntax-cli:"
const location = (path: string) => `git://github.com/gj3447/USL@${commit}:${path}`
const publicLocation = (path: string) => `https://github.com/gj3447/USL/blob/master/${path}`
const graph: ResourceGraph = { schema: "usl-resource-graph/v1", resources: [], meanings: [], links: [], provenance: { sources: ["source:catalog", "source:generator"], activity: "activity:architecture", agent: "agent:secondary" } }
type Meta = NonNullable<ResourceGraph["resources"][number]["metadata"]>
type LinkMeta = NonNullable<ResourceGraph["links"][number]["metadata"]>
const add = (id: string, type: string | string[], locator: string, metadata: Meta) => { graph.resources.push({ id, types: (Array.isArray(type) ? type : [type]).map(t => t.startsWith("http") ? t : prefix + t), locator, metadata }); return id }
const addFile = async (path: string) => {
  const pinned = catalog.sourcePins[path]
  if (!pinned) throw new Error(`missing catalog source pin: ${path}`)
  const current = digestSource(await read(path))
  const historical = digestSource(execFileSync("git", ["show", `${commit}:${path}`], { cwd: root, encoding: "buffer" }).toString("utf8"))
  if (current !== pinned || historical !== pinned) throw new Error(`source pin mismatch: ${path}`)
  return add(`artifact:${path}`, "Artifact", location(path), { path, sourceDigest: pinned, scope: "LOCAL_CURRENT_AND_LOCAL_GIT_COMMIT_BYTES", remoteObservation: "NOT_PERFORMED" })
}
const rules: Array<[string, Array<[string, string]>]> = [
  ["interpreted_as", [["statement", "UserStatement"], ["feature", "ImplementedFeature"]]],
  ["implemented_by", [["feature", "ImplementedFeature"], ["artifact", "Artifact"]]],
  ["trace", [["statement", "UserStatement"], ["feature", "ImplementedFeature"], ["artifact", "Artifact"]]],
  ["bounded_by", [["feature", "ImplementedFeature"], ["limitation", "Limitation"]]],
  ["addresses", [["proposal", "Proposal"], ["requirement", "UserStatement"]]],
  ["depends_on", [["proposal", "Proposal"], ["prerequisite", "Proposal"]]],
]
const profile: DomainProfile = { schema: "usl-domain-profile/v1", id: prefix + "profile", version: "1", closedMeanings: true,
  meanings: rules.map(([id, roles]) => ({ id: prefix + id, allowExtraRoles: false, roles: roles.map(([role, type]) => ({ role, required: true, types: [prefix + type], metadata: [] })) })) }
graph.meanings = rules.map(([id]) => ({ id: prefix + id, description: `Architecture trace relation ${id}; declaration only.` }))
const link = (meaning: string, participants: Record<string, string>, metadata: LinkMeta = {}) => graph.links.push({ id: `${meaning}:${Object.values(participants).join(":")}`, meaning: prefix + meaning, participants: Object.entries(participants).map(([role, resource]) => ({ role, resource })), metadata })
add("source:catalog", "Source", publicLocation("research/architecture/syntax-cli.catalog.json"), { path: "research/architecture/syntax-cli.catalog.json", sourceDigest: digestSource(await read("research/architecture/syntax-cli.catalog.json")), authority: "SECONDARY_AI", locationStatus: "DECLARED_PUBLIC_LOCATION", remoteObservation: "NOT_PERFORMED" })
add("source:generator", "Source", publicLocation("scripts/build-syntax-cli-architecture.ts"), { path: "scripts/build-syntax-cli-architecture.ts", sourceDigest: digestSource(await read("scripts/build-syntax-cli-architecture.ts")), scope: "DETERMINISTIC_GENERATOR", locationStatus: "DECLARED_PUBLIC_LOCATION", remoteObservation: "NOT_PERFORMED" })
add("activity:architecture", ["ArchitectureActivity", "http://www.w3.org/ns/prov#Activity"], publicLocation("research/architecture/syntax-cli.catalog.json"), { status: "DECLARED", scope: "CURRENT_IMPLEMENTATION_AND_PROPOSAL_SEPARATION", runtimeTests: "NOT_CLAIMED" })
add("agent:secondary", ["Agent", "http://www.w3.org/ns/prov#Agent"], publicLocation("research/architecture/syntax-cli.catalog.json"), { authority: "SECONDARY_AI", ratification: "NOT_CLAIMED" })
add("subject:usl", "ArchitectureSubject", "git://github.com/gj3447/USL", { name: "USL", role: "LANGUAGE_AND_CLI_BINDING_LAYER" })
for (const statement of catalog.userStatements) add(statement.id, "UserStatement", publicLocation("research/architecture/syntax-cli.catalog.json"), { status: statement.status, text: statement.text, authority: "USER_PRIMARY", locationStatus: "DECLARED_PUBLIC_LOCATION", remoteObservation: "NOT_PERFORMED" })
const artifacts = new Map<string, string>()
for (const [feature, title, paths] of catalog.implemented) {
  add(feature, "ImplementedFeature", location("README.md"), { title, status: "IMPLEMENTED_CURRENT_SOURCE", semanticTruth: "NOT_EVALUATED", runtimeTests: "NOT_CLAIMED" })
  for (const path of paths) { const id = artifacts.get(path) ?? await addFile(path); artifacts.set(path, id); link("implemented_by", { feature, artifact: id }) }
  link("interpreted_as", { statement: "user:syntax-cli", feature }, { authority: "SECONDARY_AI", status: "INTERPRETATION" })
}
const limitations: Array<[string, string, string]> = [
  ["limitation:weights", "Semantic weight adjustment is not implemented.", "feature:hyperedge"],
  ["limitation:m-map", "No persistent or derived M-map index is implemented.", "feature:navigation"],
  ["limitation:hierarchy", "No typed parent/child hierarchy or ancestry query is implemented.", "feature:navigation"],
  ["limitation:cli-consolidation", "CLI commands are functional but help is not a consolidated graph-oriented interface.", "feature:cli"],
]
for (const [id, detail, feature] of limitations) { add(id, "Limitation", location("README.md"), { detail, status: "CURRENT_GAP" }); link("bounded_by", { feature, limitation: id }) }
for (const [id, title, detail] of catalog.proposals) { add(id, "Proposal", publicLocation("research/architecture/syntax-cli.catalog.json"), { title, detail, status: "PROPOSED", authority: "SECONDARY_AI", implementation: "NOT_STARTED" }); link("addresses", { proposal: id, requirement: "user:weighted-hypergraph" }, { authority: "SECONDARY_AI", status: "INTERPRETATION" }) }
link("addresses", { proposal: "proposal:graph-cli", requirement: "user:syntax-cli" }, { authority: "SECONDARY_AI", status: "INTERPRETATION" })
// This three-role edge is intentionally retained as the canonical n-ary trace.
link("trace", { statement: "user:syntax-cli", feature: "feature:hyperedge", artifact: artifacts.get("src/language/compiler.ts")! }, { authority: "SECONDARY_AI", status: "TRACEABILITY" })
const raw = JSON.stringify(graph, null, 2) + "\n"
const report = checkResourceGraphProfile(graph, profile)
if (report.status !== "CONFORMS") throw new Error(JSON.stringify(report.issues))
Either.getOrThrow(adaptResourceGraph(raw, { namespace: "usl.syntax.cli.architecture", profile }))
const jsonld = Either.getOrThrow(resourceGraphJsonLd(raw, { namespace: "usl.syntax.cli.architecture", profile }))
const shapes = ["@prefix usl: <urn:usl:vocab:> .", "@prefix arc: <urn:usl:syntax-cli:> .", "@prefix sh: <http://www.w3.org/ns/shacl#> .", "",
  `arc:ArchitectureRoleShape a sh:NodeShape ; sh:targetClass usl:Link ; sh:or ( ${rules.map(([id]) => `arc:${id}Shape`).join(" ")} ) .`, "",
  ...rules.map(([id, roles]) => [`arc:${id}Shape a sh:NodeShape ;`, `  sh:property [ sh:path (usl:meaning usl:nativeId) ; sh:hasValue ${JSON.stringify(prefix + id)} ] ;`,
    `  sh:property [ sh:path (usl:participant usl:role) ; sh:in ( ${roles.map(([role]) => JSON.stringify(role)).join(" ")} ) ] ;`,
    ...roles.map(([role, type]) => `  sh:property [ sh:path usl:participant ; sh:qualifiedMinCount 1 ; sh:qualifiedMaxCount 1 ; sh:qualifiedValueShape [ sh:property [ sh:path usl:role ; sh:hasValue ${JSON.stringify(role)} ] ; sh:property [ sh:path usl:resource ; sh:class arc:${type} ] ] ] ;`),
  ].join("\n").replace(/;$/, ".")), ""].join("\n")
const outputs: Record<string, string> = {
  "research/architecture/syntax-cli.graph.json": raw,
  "research/architecture/syntax-cli.graph.jsonld": JSON.stringify(jsonld, null, 2) + "\n",
  "research/architecture/syntax-cli.profile.json": JSON.stringify(profile, null, 2) + "\n",
  "research/architecture/syntax-cli.shacl.ttl": shapes,
}
for (const [path, value] of Object.entries(outputs)) { if (check) { if (await read(path) !== value) throw new Error(`generated artifact differs: ${path}`) } else await writeFile(resolve(root, path), value) }
console.log(JSON.stringify({ resources: graph.resources.length, links: graph.links.length, profile: report.status, sourceCommit: commit, mode: check ? "CHECKED" : "BUILT" }))
