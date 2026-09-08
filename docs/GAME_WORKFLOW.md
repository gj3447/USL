# Game workflow observation benchmark

`examples/game-workflow.ts` is a reproducible, synthetic game-development fixture. It copies only `examples/fixtures/game-workflow` to a private temporary directory and resolves its files through `resolveWith`; it never scans or changes another game repository.

Run it with:

```sh
npx tsx examples/game-workflow.ts
```

It prints one JSON artifact. Timings are local process measurements only. The report intentionally does not claim a human-time saving or a speedup.

A [recorded run](../examples/game-workflow-result.json) contains the measured timings, read counters, version digests and the three separate change comparisons. Its timings are one local run, not a stable performance target.

The fixture contains a dash specification, implementation, test evidence, and unrelated audio resources. It compares two synthetic lookup strategies:

- `repository_scan`: observes every declared fixture resource, modelling a broad reference lookup.
- `targeted_link_lookup`: observes only `dash_behavior`, modelling a selected-link lookup.

The targeted method first runs the pure `agentContext` lookup from `dash_spec` to `dash_code`, then observes only the returned link names. Its report separates `navigationElapsedMs` from `observationElapsedMs`; the broad scan has only an observation time because it already assumes every declared resource is selected. The reported read counts come from an instrumented resolver that forwards the observation's allowlist and intersects it with the fixture policy. `referenceLookupReads` is the broad scan count and `targetedLookupReads` is the selected-link count; they are a reproducible proxy for lookup work, not a measurement of human search time.

The runner then compares three changes against a baseline observation:

| Change | What changed | Expected response |
| --- | --- | --- |
| Evidence edit | Same dash-code locator, different file content | Re-run the declared dash check. |
| Semantic reversal | Same endpoints, but the meaning definition says air dashes are allowed | Review the meaning contract and its evidence; endpoint hashes alone cannot detect this. |
| Path move | Dash code resource points to a moved file | Repair the address/reference, then resolve it again. |

`staleEvidenceCaught` counts changed dash evidence that the comparison reports as content change. `unnecessaryRechecksAvoided` is the number of unrelated resources avoided by the selected-link lookup during the unchanged baseline run. These are fixture counters, not production-rate claims.

Each observation embeds `planDigest` and `meaningsDigest`, plus per-meaning and per-link contract digests. The emitted benchmark retains this identity metadata for the baseline and each changed run under `observedMeaningVersions`; consumers should retain these fields with any observation report, because a report without them cannot state which authored meaning version it observed.
