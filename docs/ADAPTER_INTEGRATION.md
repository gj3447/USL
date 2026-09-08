# Adapter integration

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

Each call reads the host once, adapts that exact result to a `SemanticPlan`, and
then performs the requested USL operation. It does not persist the adapted
plan. `snapshot` returns the source representation and adapted plan identity;
`context` navigates the resulting plan; `observe` resolves only the selected
participants allowed by the connection policy. A host may map native graph UIDs
to resource names so `focus: "native-uid"` reaches the adapted resource.

`hswm` is a pure preparation step. The caller independently supplies the HSWM
authority, policy, pins, and allowed reads. It neither contacts HSWM nor grants
an authority from an adapted graph. A graph with no DSL source produces an
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
maps nodes, edges, declared evidence, and original native UIDs into USL
resources, meanings, links, and metadata. The concrete projection schema is an
adapter contract, not a claim that every Cypher result has one universal USL
meaning. It must preserve the original UID beside any generated USL name.

Cypher itself remains behind the host callback. Neo4j documents `MATCH` as a
read pattern clause and documents parameters for values, expressions, and node
or relationship IDs; labels, relationship types, and property keys remain
query structure. A host should therefore select a fixed, parameterized,
read-only projection per configured connection rather than concatenate a
client-provided query. See Neo4j's official [MATCH documentation](https://neo4j.com/docs/cypher-manual/current/clauses/match/) and [parameter rules](https://neo4j.com/docs/cypher-manual/25/syntax/parameters/).

No adapter call writes a KG, executes Cypher from a client, changes a live
service, proves a declared semantic relation, or executes an HSWM action.
