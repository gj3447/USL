# metahumocoin participation connection

`metahumocoin-participation-v1` connects the owner graph for HSWM, OMC and
metahumocoin participation intent. Source quotations, AI interpretations,
design observations, open decisions and validation plans remain distinct.
Existing HSWM/OMC UIDs are preserved; this projection does not rewrite KG canon.

From the sibling `metahumocoin` directory:

```sh
python3 tools/participation_graph.py validate
python3 tools/participation_graph.py build
python3 tools/participation_graph.py context participation
python3 tools/participation_graph.py questions
python3 tools/participation_graph.py verify
```

The owner validates source snapshots, relationships and competency questions,
then creates immutable revisions under its ignored `.local/usl/revisions/`.
`current` selects one revision. Rebuilding identical content is idempotent.
Earlier revisions remain available for inspection; a changed owner graph must
be built before current CLI navigation. To roll back, restore the corresponding
owner source revision and rebuild; do not modify immutable generated files.

The owner CLI checks source/exporter and revision-file digests before navigation.
The generic MCP connection checks the graph/profile schema on each request and
returns the selected snapshot digest; it does not run the owner's current-source
comparison. Use the owner CLI and `sources` for that comparison. README/DESIGN
snapshots preserve the earlier design bytes; later guide links in those files
are reported as `CHANGED_SINCE_CAPTURE`, not silently rewritten into old evidence.

From USL, use the fixed registration with the existing read-only MCP server:

```sh
node dist/src/cli.js mcp --config connections/metahumocoin/participation.json
```

Example `context` arguments:

```json
{
  "connection": "metahumocoin-participation-v1",
  "query": { "focus": "urn:metahumocoin:project" },
  "compact": true
}
```

The configuration contains relative paths only. Host paths and snapshots stay
in the owner's local export. `allowedLocators: []` grants no evidence reads;
navigation uses metadata already in the selected projection. Registration does
not start a permanent service, grant resource access, execute P2P work, issue a
coin or admit anything to HSWM. Economic utility and efficacy remain unmeasured.
See the [owner guide](../../../metahumocoin/docs/HSWM_OMC_PARTICIPATION.md).
