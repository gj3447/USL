# HSWM integration

2026-09-14: source pins in dated 2026-09-08 receipts describe historical builds. New USL adapters and compiler changes require independently reviewed current source pins before a new pinned HSWM run. This repository preserves prior evidence rather than rewriting it. See [current architecture](ARCHITECTURE.md).

For existing-system inputs, `connectUsl(...).hswm(request, observeOptions,
authority)` now obtains one native response, observes its selected participants,
and prepares these arguments from the same snapshot. No `.usl` file is needed.
See [ADAPTER_INTEGRATION.md](ADAPTER_INTEGRATION.md). Run
`npm run build` then `node audit/native-adapter-smoke.mjs` for the local native
graph → file observations → existing Python HSWM consumer verification.

`prepareHswmAdapterArguments` prepares the exact values consumed by HSWM's
existing Python `adapt_usl` v2 adapter: `plan`, `report`, `policy`,
`allowed_reads`, `now`, and `revision`. It is pure and deep-copies its input.

The caller must supply the HSWM policy and `allowed_reads` independently. USL
does not turn a report into permission, a pin, an owner, a Permit, admission,
credit, or learning input. HSWM remains responsible for checking its sorted-key
`plan_digest`, resource pins, freshness, and the final `READY` or `UNKNOWN`
projection.

```ts
const input = prepareHswmAdapterArguments({
  plan,
  report,
  policy, // hswm-usl-observation-policy/v2, owned by the caller
  allowed_reads: [["game_reference", "resolves"]],
  now: Date.now() / 1000,
  revision: "game-dash-2026-09-08",
})
```

Serialize `allowed_reads` as pairs; the Python consumer converts them to its
required `set(tuple(pair) for pair in allowed_reads)` form. `policy.plan_digest`
uses HSWM's sorted-key JSON SHA-256 without a prefix. `usl_plan_digest` and
`source_digest` bind the USL v2 report.

The example policy in tests and the smoke program derives fixture pins only to
exercise a consumer. It is not a production policy-authoring pattern: obtain
policy, pins, and `allowed_reads` from the caller's independent HSWM authority.

To run the cross-repository smoke without network or resolver IO:

```bash
npx tsx audit/hswm-adapter-smoke.ts
```

It invokes the local HSWM Python consumer and records hashes of
`usl_adapter.py` and `usl_observation_v2.py` in its result artifact.

The current HSWM v2 validator cannot consume two selected raw locator spellings
that normalize to one URL identity, because it requires each report row's
resolution locator to equal that row's authored locator. This adapter rejects
such canonical aliases before handoff. Re-observe with one spelling or update
the HSWM consumer's alias contract first.
