# Graph Engineering integration

2026-09-28: the separate [CLI host](CLI_GRAPH_ARCHITECTURE.md) can bind one declared `code`/`tool` entry node to a host-registered process. It checks source/graph/plan pins and refuses incoming dependencies. Its result records `ENTRY_NODE_ONLY` and `wholeGraphExecution: NOT_EXECUTED`; it does not execute GraphSpec lifecycle, gate, or workflow policies. The import adapter described below retains its original pure declaration boundary.

`src/integrations/graph-engineering.ts` imports a GEIP v0alpha1 GraphSpec as a
lossless wrapper around a compiled USL plan. It preserves `metadata.graph_id`,
`graph_version`, full `authority`, full `identity`, topology, and evidence.
GEIP's `graphspec_sha256` is checked with its own sorted-key compact JSON
algorithm before a plan is returned; it is not a USL `digestJson` value.

A GraphSpec node ID and an evidence reference are not native USL locators.
Callers therefore supply explicit bindings to actual USL locators. Only an edge
whose source and target nodes are both bound becomes a USL link; all nodes and
edges, including unbound ones, remain in the wrapper. The graph source binding
also requires exact JSON source text and records its SHA-256 source digest.
`examples/fixtures/graph-engineering/bindings.json` shows node and PROV receipt
bindings. The generated plan says only that GraphSpec declared the structure:
`geipValidation` is `NOT_RUN` and execution is `NOT_EXECUTED`.

The fixture is a `SECONDARY_AI` GEIP v0alpha1 draft. Its node types include
`code`, `router`, `model`, `tool`, `join`, `human`, and `checkpoint`; it also
declares data/control/gate edges and loop budgets (`max_steps: 32`,
`max_effect_attempts: 4`, `max_wall_time_ms: 300000`, `max_tokens: 100000`,
`max_cost: 20`, `max_causal_depth: 8`). USL preserves those declarations in
the GraphSpec wrapper and edge meaning contracts. It does not execute node
code or enforce those budgets. The two bound local files (`seed.ts`,
`router.ts`) demonstrate one declared edge, while the local validator receipt
binds the declared PROV reference.

`graphspec.json` is a standalone copy of the upstream fixture. Pass its raw
text to `parseGraphEngineeringSource(sourceText)`: that preserves JSON numeric
lexemes such as `20.0` and fractional budgets. Passing an already parsed object
is supported only when every number is a safe integer, because `JSON.parse`
otherwise loses the integer/float distinction needed for the GEIP digest. The unit test
checks its byte SHA-256 against `validator-receipt.json`; a changed copy must
be revalidated and have its receipt updated. The adapter accepts only ASCII
object keys. Raw JSON numbers are rendered with Python-compatible float
spelling; non-finite values, negative zero, and unsafe integer values fail
closed.

Upstream validator check recorded in
`examples/fixtures/graph-engineering/validator-receipt.json` on 2026-09-08:

```sh
python3 -m venv /tmp/usl-geip-validator
/tmp/usl-geip-validator/bin/python -m pip install -r \
  /home/lagyeongjun/CD/SYMPOSIUM/THEORY/GRAPH_ENGINEERING/service/requirements.lock
/tmp/usl-geip-validator/bin/python \
  /home/lagyeongjun/CD/SYMPOSIUM/THEORY/GRAPH_ENGINEERING/service/graphspec_validator.py \
  validate --kind graphspec \
  /home/lagyeongjun/CD/SYMPOSIUM/THEORY/GRAPH_ENGINEERING/examples/graphspec-valid.json
```

An isolated temporary venv installed the upstream locked requirements,
including `jsonschema[format-nongpl]`; its format checkers rejected the four
validator probe values. The upstream `graphspec-valid.json` then passed
GEIP-001 through GEIP-015 with no identity or schema errors and verdict
`STRUCTURALLY_CONFORMANT`. The receipt pins the graph source, schema and
validator SHA-256 values. This is GEIP document-structural validation for a
`SECONDARY_AI` draft, never international-standard certification, workflow
execution, or runtime conformance.
