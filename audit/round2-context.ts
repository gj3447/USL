// Deterministic differential checks over compiler-produced n-ary plans. No IO resolvers.
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import { Either } from "effect"
import { agentContext, compactAgentContext, compileSource } from "../src/language/index.js"

let state = 20260908
const random = (n: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n }
const roles = ["left", "right", "evidence"]
let checkedPaths = 0
for (let trial = 0; trial < 80; trial++) {
  const names = Array.from({ length: 8 }, (_, i) => `r${i}`)
  const bindings = Array.from({ length: 12 }, () => roles.map(() => names[random(names.length)]!))
  const source = `usl "0.1"; namespace "round2.context${trial}";
    ${names.map((n) => `resource ${n} = "https://fixture.invalid/${n}";`).join("\n")}
    meaning rel(left: url, right: url, evidence: url) = "declared relation";
    ${bindings.map((b, i) => `link l${i} = rel(${roles.map((r, j) => `${r}: ${b[j]}`).join(", ")});`).join("\n")}`
  const plan = Either.getOrThrow(compileSource(source))
  const focus = names[random(names.length)]!, target = names[random(names.length)]!
  const routes = trial % 3 === 0 ? undefined : roles.flatMap((enter) => roles.flatMap((exit) =>
    enter !== exit && random(2) ? [{ meaning: "rel", enter, exit }] : []))
  const maxHops = trial % 4
  const query = { focus, target, maxHops, maxResources: 100, maxLinks: 100, maxVisits: 1000, ...(routes === undefined ? {} : { routes }) }
  const context = Either.getOrThrow(agentContext(plan, query))
  // Independently materialize pairwise directed edges for this small test graph.
  const edges = new Map(names.map((name) => [name, new Set<string>()]))
  for (const binding of bindings) for (let i = 0; i < roles.length; i++) for (let j = 0; j < roles.length; j++) {
    if (i !== j && (routes === undefined || routes.some((r) => r.enter === roles[i] && r.exit === roles[j]))) edges.get(binding[i]!)!.add(binding[j]!)
  }
  const distances = new Map([[focus, 0]])
  const queue = [focus]
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i]!, depth = distances.get(at)!
    if (depth === maxHops) continue
    for (const next of edges.get(at)!) if (!distances.has(next)) { distances.set(next, depth + 1); queue.push(next) }
  }
  assert.deepEqual(new Map(context.paths.map((p) => [p.resource, p.steps.length])), distances, `distances trial ${trial}`)
  assert.equal(context.target!.status === "FOUND", distances.has(target), `target trial ${trial}`)
  const full = Either.getOrThrow(compactAgentContext(plan, query, { maxBytes: 100_000 }))
  const packet = JSON.parse(full.text)
  for (const p of packet.paths) {
    let at = focus
    const steps = p.steps.map(([linkName, enter, exit]: string[]) => {
      const link = packet.links.find((l: { name: string }) => l.name === linkName)
      const from = link.participants.find((p: { role: string }) => p.role === enter).resource
      const to = link.participants.find((p: { role: string }) => p.role === exit).resource
      assert.equal(from, at)
      at = to
      return { link: linkName, meaning: link.meaning, from, enteredRole: enter, to, exitedRole: exit }
    })
    assert.equal(at, p.resource)
    assert.deepEqual(steps, context.paths.find((path) => path.resource === p.resource)!.steps)
    checkedPaths++
  }
  assert.deepEqual(packet.resources, context.resources)
  assert.deepEqual(packet.meanings, context.meanings)
  assert.deepEqual(packet.links, context.links)
  assert.ok(Either.isLeft(compactAgentContext(plan, query, { maxBytes: full.stats.deliveredBytes - 1 })))
  const cached = Either.getOrThrow(compactAgentContext(plan, query, { maxBytes: 100_000, knownContextDigest: full.contextDigest }))
  assert.equal(cached.mode, "UNCHANGED")
}
const result = { seed: 20260908, trials: 80, checkedPaths, outcome: "RESISTED", checks: ["reference directed BFS distances", "target existence", "lossless compact role/path reconstruction", "declaration preservation", "byte budget", "exact cache reuse"], isolation: "pure compiler/navigation/serialization, no resolver IO" }
await fs.writeFile("audit/round2-context-results.json", JSON.stringify(result, null, 2) + "\n")
console.log(JSON.stringify(result, null, 2))
