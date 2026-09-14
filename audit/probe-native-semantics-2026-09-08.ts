/** Read-only reproduction probes for the property-graph adapter. */
import { Either } from "effect"
import { adaptPropertyGraph } from "../src/integrations/property-graph.js"
import { planDigest } from "../src/language/digest.js"

const options = { namespace: "audit.native", kgSource: "canonical" }
const adapt = (raw: string) => Either.getOrThrow(adaptPropertyGraph(raw, options))
const graph = (participants: ReadonlyArray<{ readonly role: string; readonly uid: string }>, from = "a", to = "b") => JSON.stringify({
  nodes: [{ uid: "a" }, { uid: "b" }, { uid: "e" }],
  relations: [{ uid: "r", from_uid: from, to_uid: to, type: "MEMBER_OF", properties: { description: "membership", participants } }],
})
const row = (name: string, before: string, after: string) => {
  const a = adapt(before), b = adapt(after)
  return { name, sourceDigest: [a.source.digest, b.source.digest], planDigest: [planDigest(a.plan), planDigest(b.plan)], planEqual: planDigest(a.plan) === planDigest(b.plan) }
}

const normal = graph([{ role: "member", uid: "a" }, { role: "group", uid: "b" }, { role: "evidence", uid: "e" }])
const reversedEndpoints = graph([{ role: "member", uid: "a" }, { role: "group", uid: "b" }, { role: "evidence", uid: "e" }], "b", "a")
const reorderedRoles = graph([{ role: "evidence", uid: "e" }, { role: "group", uid: "b" }, { role: "member", uid: "a" }])
const duplicateKey = '{"nodes":[{"uid":"a"},{"uid":"b"}],"relations":[{"uid":"r","from_uid":"a","to_uid":"b","type":"FIRST","type":"SECOND"}]}'
const lastWins = '{"nodes":[{"uid":"a"},{"uid":"b"}],"relations":[{"uid":"r","from_uid":"a","to_uid":"b","type":"SECOND"}]}'
const kgMismatch = JSON.stringify({ nodes: [{ uid: "native:a", properties: { locator: "kg://canonical/other" } }, { uid: "b" }], relations: [{ uid: "r", from_uid: "native:a", to_uid: "b", type: "REL" }] })

const nary = adapt(normal)
const mismatched = adapt(kgMismatch)
console.log(JSON.stringify({
  endpointDirection: row("endpoint-direction", normal, reversedEndpoints),
  participantOrder: row("participant-order", normal, reorderedRoles),
  duplicateJsonKey: row("duplicate-json-key", duplicateKey, lastWins),
  kgUidLocatorMismatch: { sourceDigest: mismatched.source.digest, resource: mismatched.plan.resources.find((resource) => resource.name === mismatched.identities.resources["native:a"]), accepted: Either.isRight(adaptPropertyGraph(kgMismatch, options)) },
  naryProvenance: nary.plan.links[0]!.participants,
}, null, 2))
