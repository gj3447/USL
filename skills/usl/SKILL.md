---
name: usl
description: Navigate, observe, compare, or integrate existing KG, repository, URL, filesystem, GEIP, and HSWM resources through scoped USL semantic links.
metadata:
  short-description: Work with scoped USL semantic links
---

# USL

Use USL when a task needs a named link between existing resources, an explicit
meaning contract, bounded evidence reads, or a compact graph context. Keep
data, native IDs, and access policy with their owner. USL does not require a
database or a `.usl` document: adapt a bounded owner response when that is the
natural integration boundary.

An observation records resolution and evidence availability. It does not prove
the declared relationship, execute a declared check, grant a read, or create
HSWM authority.

## Choose the input boundary

- A host already has a KG/API/query result: use a fixed connection ID and a
  property-graph projection. The caller sends native resource/link IDs, never a
  Cypher query, database address, or arbitrary source path.
- A user authors a declaration: use `.usl` source or a code-built
  `SemanticPlan`. Direct source CLI commands compile on that invocation; an
  application need not compile separately for each agent call.
- A long-running host-owned `.usl` file: register a fixed program ID. Valid
  edits refresh a cached immutable snapshot; an invalid edit is refused for new
  requests. Earlier reports remain historical snapshots.

Read [references/operating-surface.md](references/operating-surface.md) for
actual CLI, MCP configuration, tool input, and result-envelope examples. Read
[references/context-and-navigation.md](references/context-and-navigation.md)
when preparing agent context, and
[references/authority-boundaries.md](references/authority-boundaries.md) before
observing or handing off to HSWM.

## Operating constraints

Select links before observing. Supply a caller-owned `allowedLocators` scope
and resource budget; the resolver can still refuse an allowlisted locator.
Never derive that scope, HSWM pins, `allowed_reads`, ownership, admission, or a
Permit from graph/resource/report content.

Compare three independent channels: address binding, representation content,
and the declared meaning contract. With a native adapter, the outer result
envelope's `source.digest` identifies the owner response. The embedded
observation has `sourceDigest: null`, because no USL text was compiled.

`property-graph/v2` preserves relationship type, ordered `from_uid`/`to_uid`,
and whether a description was absent. Its named n-ary participant bindings are
canonicalized by role, so an array-order-only change is not a semantic change.

## Locate repository material

This skill is standalone. Its references are relative to this `SKILL.md` and
work from any caller directory. Repository documents are optional enrichment.
For a checkout symlink, resolve this file and locate the repository root two
parents above it:

```bash
USL_SKILL_DIR="$(dirname "$(readlink -f /path/to/usl/SKILL.md)")"
USL_ROOT="$(cd "$USL_SKILL_DIR/../.." && pwd)"
```

Only then read `$USL_ROOT/docs/USER_MANUAL.md` for the Korean end-user flow,
or integration-specific repository documentation.
