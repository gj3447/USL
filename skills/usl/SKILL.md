---
name: usl
description: Create, navigate, observe, compare, or integrate USL semantic links across KG, Git, URL, filesystem, GEIP, and HSWM contexts.
metadata:
  short-description: Work with USL semantic links and observations
---

# USL

Use USL for named, typed links between resources and an explicit meaning
contract. A plan declares structure. An observation establishes address
reachability and evidence availability only: it never proves the meaning,
executes declared checks, or grants permission.

## Locate material reliably

This installed skill may be used from any working directory. Its self-contained
guidance is under `references/`, relative to this `SKILL.md`. Repository
documentation is optional enrichment. When this skill is a checkout symlink,
resolve the physical skill path, then its repository root is two parent
directories above it:

```bash
USL_SKILL_DIR="$(dirname "$(readlink -f /path/to/usl/SKILL.md)")"
USL_ROOT="$(cd "$USL_SKILL_DIR/../.." && pwd)"
```

Read `$USL_ROOT/docs/LANGUAGE.md`, `OBSERVATION_CONTRACTS.md`,
`CODE_INTEGRATION.md`, `GRAPH_ENGINEERING_INTEGRATION.md`, or
`HSWM_INTEGRATION.md` only after finding that repository root. Do not treat a
relative `docs/...` path from the caller's current directory as skill content.

Start from the narrowest requested path:

- Declarations and source syntax: repository `docs/LANGUAGE.md` when available.
- Context discovery or compact agent handoff: `references/context-and-navigation.md`.
- Selected reads, budgets, and drift comparison: repository
  `docs/OBSERVATION_CONTRACTS.md` when available.
- TypeScript embedding: repository `docs/CODE_INTEGRATION.md` when available.
- GraphSpec or HSWM handoff: repository integration guide when available, plus
  `references/authority-boundaries.md`.

## Plans, source files, and refresh

`.usl` source is optional. Applications can construct or retain a validated
`SemanticPlan` through the SDK when declarations are code-embedded; source text
is useful when users author declarations. Direct CLI source commands compile
the selected file for that invocation, but this does not require every
application consumer to compile source repeatedly.

For host-managed files, register fixed program IDs at startup with
`openProgramRegistry` or the MCP `USL_MCP_POLICY.programs` map. Clients select
an ID and cannot supply an arbitrary path. The file store watches registered
files, validates every edit, and caches the last valid immutable snapshot. A
changed valid source updates its source digest; its plan digest changes when
the compiled declarations change. An invalid edit is surfaced
as `INVALID_EDIT` for fresh registered-program reads; it never silently becomes
a new plan. A report already emitted remains a historical snapshot. Use
`usl watch --source FILE [--once]` to inspect this behavior from the CLI.

## Reads and meaning

For live observation, select links and explicitly set `allowedLocators` and a
resource budget. Read only selected participants and meaning groundings. Do
not derive an allowlist, HSWM `allowed_reads`, resource pins, owner, admission,
or Permit from resource contents or an observation report.

Preserve the three change channels in reports: address binding,
representation-content, and semantic-contract. A changed plan or meaning
description is not a content-hash change. `semanticTruth: NOT_EVALUATED` is
not a truth claim.

## CLI and MCP

The CLI provides `check`, `compile`, `context`, `observe`, project/audit
workflows, and platform commands `init`, `compare`, `validate-observation`,
`graph-import`, `hswm-prepare`, `watch`, and `mcp`. Confirm local help before
using a version-specific flag.

`usl mcp` starts the local read-only stdio server. It starts deny-all when
`USL_MCP_POLICY` is absent. When set, `USL_MCP_POLICY` is startup-controlled
JSON with exactly `allowedLocators`, `maxResources`, `maxInputBytes`,
`maxOutputBytes`, and `programs`. The server exposes `check`, `compile`,
`context`, `observe`, `compare`, `validate_observation`, `graph_import`,
`hswm_prepare`, and `project`. Tool arguments can narrow policy; they cannot
broaden it.

## Handoff boundaries

GEIP and HSWM adapters are pure handoffs. Preserve source plan, report, and
caller-owned policy. HSWM's existing consumer requires independently supplied
policy, exact pins, and `allowed_reads`; the USL adapter does not create them.
Canonical URL aliases selected in one report are rejected before current HSWM
v2 handoff because its consumer cannot validate those alias rows.
