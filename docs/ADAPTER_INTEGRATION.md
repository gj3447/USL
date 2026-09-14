# Adapter integration

2026-09-14: this document describes the existing property-graph adapter. For open domain types and JSON-LD/PROV exchange use [resource-graph/v1](RESOURCE_GRAPH.md); for selected Lean declarations use [Lean 4](LEAN4_INTEGRATION.md). All use the same transient connection boundary.

For `hswm`, omit `authority.now` for normal live observation: freshness is
evaluated after endpoint reads finish. Supply an explicit timestamp for replay.
A timestamp captured before IO may legitimately make later observations appear
to be from the future to HSWM; explicit timestamps are never silently changed.

For connection queries, `focus` and `target` use native resource UIDs.
`routes[].meaning` uses a native relationship UID; `enter` and `exit` keep
the original participant role names. Observation `links` also uses native
relationship UIDs. Unknown identities fail instead of widening the request.

An adapter lets a host expose an existing graph or projected query result through
USL without requiring a `.usl` file, a USL database, or a USL cache. The host
owns a configured connection ID, its read callback, and its graph-to-USL
adapter. A client supplies a request and navigation query; it never supplies a
Cypher string, a database address, or a filesystem path.

```ts
const connection = connectUsl({
  read: request => Effect<string>,
  adapt: raw => Either<AdaptedGraph, Error>,
  policy,
})

await Effect.runPromise(connection.context(request, { focus: "native-uid" }, { compact: true }))
await Effect.runPromise(connection.observe(request, { links: ["selected"] }))
await Effect.runPromise(connection.snapshot(request))
await Effect.runPromise(connection.hswm(request, observeOptions, authority))
```

Each valid call reads the host once, adapts that exact result to a `SemanticPlan`, and
then performs the requested USL operation. It does not persist the adapted
plan. `snapshot` returns the `AdaptedGraph` only, not the raw native response.
`AdaptedGraph.source.digest` is the SHA-256 of that raw host response. The
adapter receipt binds this source digest, the adapted plan digest, and the
operation result digest. It is separate from `ProgramObservation.sourceDigest`,
which is `null` because no USL text was compiled.
`context` navigates the resulting plan; `observe` resolves only the selected
participants allowed by the connection policy. A host may map native graph UIDs
to resource names so `focus: "native-uid"` reaches the adapted resource.

Malformed options, excessive request budgets, and invalid HSWM authority fail
before the host read. `context` accepts only `compact`, `maxBytes`, and
`knownContextDigest` in its third argument; it cannot replace the separate query.
`snapshot` and operations share plan/source/identity-map validation.
The public snapshot is also bounded by `maxOutputBytes`; internal snapshots
do not consume the output budget of a compact result. `adapterResult` returns
a private, deeply frozen JSON snapshot, keeping its receipt stable if the
caller later changes the original result object.

`hswm` checks the caller's authority shape before the host read, validates its
plan pins against that snapshot before endpoint reads, and then observes and
purely prepares the HSWM argument bundle. The caller independently supplies the HSWM
authority, policy, pins, and allowed reads. It neither contacts HSWM nor grants
an authority from an adapted graph. A graph with no USL text produces an
observation whose `sourceDigest` is `null`.

## HSWM v2 source binding

The existing HSWM v2 consumer explicitly permits `report.sourceDigest: null`
only when the independently supplied policy also has `source_digest: null`.
It labels that result `source_binding: "ABSENT"`; it does not recompile or
authenticate source bytes. This is suitable for a native graph adaptation only
when the caller accepts that limitation and still pins the adapted USL plan,
meanings, selected resources, and report. Supplying a non-null policy source
digest with a null report is rejected.

This behavior is enforced in HSWM
`src/hswm/infrastructure/usl_observation_v2.py` (`validate_report`, source
digest pin) and covered by
`tests/test_usl_adapter_v2.py::test_v2_explicit_null_source_is_allowed_only_when_policy_pins_null`.

## Property-graph and Cypher boundary

A property-graph adapter consumes a host-provided, bounded JSON projection and
maps nodes, relations, declared contracts, and original native UIDs into USL
resources, meanings, links, and identity maps. The concrete projection schema
is an adapter contract, not a claim that every Cypher result has one universal
USL meaning. It preserves the original UID beside each generated USL name.

The transformation is identified as `property-graph/v2`. Each meaning includes
an unambiguous JSON declaration with the relationship type, ordered
`direction: { from_uid, to_uid }`, and description (`null` when absent).
Reversing the native relationship therefore changes the plan and meaning
digests even when explicit n-ary participant roles stay the same. This retains
the start/end/type information in the [Cypher relationship model](https://neo4j.com/docs/cypher-manual/25/queries/concepts/#_relationships).

Participant bindings are identified by role name and sorted by that name.
Reordering their input array changes the native source digest but does not
change the adapted plan or trigger a semantic-contract review. Check sequences
retain their declared order. If participant order has domain meaning, express
it with distinct roles or an explicit contract rather than array position.

The native input shape is unchanged. Upgrading from `property-graph/v1` does
change generated meaning/plan digests, so obtain a fresh baseline and review
the corresponding independently owned HSWM plan pins once. Old reports remain
historical evidence; USL does not rewrite them or update authority automatically.

```json
{
  "nodes": [
    { "uid": "native:player", "properties": { "locator": "kg://canonical-neo4j/native:player" } },
    { "uid": "native:spec", "properties": { "locator": "https://example.invalid/spec" } }
  ],
  "relations": [
    {
      "uid": "native:implements:1",
      "from_uid": "native:player",
      "to_uid": "native:spec",
      "type": "IMPLEMENTS",
      "properties": {
        "description": "player implements the declared specification",
        "participants": [{ "role": "implementation", "uid": "native:player" }, { "role": "specification", "uid": "native:spec" }]
      }
    }
  ]
}
```

For a Neo4j driver, the host can run one fixed, bounded projection and pass the
single returned map into JSON serialization, for example:

```cypher
MATCH (n)-[r]->(m)
WHERE elementId(n) = $focus
RETURN {nodes: collect(DISTINCT n), relations: collect(r)} AS graph
```

The host converts `record.get("graph")` to the JSON shape above. Bounds,
labels, relationship types, and projection fields belong to the configured host
query, never to a client request.

Cypher remains behind the host callback. A host selects a fixed, bounded,
read-only projection per configured connection and supplies request values as
parameters rather than concatenating a client-provided query. See Neo4j's
official [MATCH documentation](https://neo4j.com/docs/cypher-manual/current/clauses/match/) and [parameter rules](https://neo4j.com/docs/cypher-manual/25/syntax/parameters/).

The CLI reads a local exported projection rather than a database:

```sh
usl adapt --graph graph.json --namespace game.graph --operation context --focus native:player --compact
usl adapt --graph graph.json --namespace game.graph --operation observe --link native:implements:1 --allow-locator https://example.invalid/spec --max-resources 1
```

`--operation` defaults to `check`; `--kg-source` supplies a KG fallback for
nodes without `properties.locator`; `--deny-all` removes all observation reads;
and `--out` writes the operation result. The CLI accepts `check`, `context`, or
`observe` only.

The CLI reads at most `maxInputBytes + 1` bytes from one opened regular file;
the extra byte detects overflow, including growth during the read. Oversized
input fails before producing output. Custom `read` callbacks remain responsible
for bounding their own database, network, or file IO while receiving data;
the SDK also checks the size of the completed response.

For MCP, the host installs a `policy.getConnection` callback at startup. It
maps a configured ID to an `AdaptedGraph`; the client sends an operation input
such as `{ "connection": "game-graph", "query": { "focus": "native:player" } }`.
The ID is not a Cypher string, endpoint, or path.

No adapter call writes a KG, executes Cypher from a client, changes a live
service, proves a declared semantic relation, or executes an HSWM action.
