# CLI

`npm run usl -- --help` lists the installed command surface. Existing `check`, `compile`, `context`, `observe`, record lifecycle, and `project` commands remain available.

Create a standalone declaration with `usl init --out game.usl`; it refuses to overwrite an existing file. `usl watch --source game.usl --once` validates and prints the current source/plan digests. Without `--once`, it emits JSONL status updates and keeps the last valid plan after an invalid edit.

Use `usl compare --before old.json --after new.json` and `usl validate-observation --report report.json` for report-only work. Both return exit 0 when their input is valid; `compare` reports required review actions in JSON and does not read a declared resource.

Use `usl graph-import --graph graphspec.json --bindings bindings.json --out wrapper.json` for a GEIP wrapper. The CLI supplies the exact `--graph` text as `bindings.source.text` and rejects a conflicting supplied value.

Use `usl hswm-prepare --input handoff.json --out prepared.json` for a pure HSWM handoff. Pins, policy, and allowed reads remain caller-owned.

Use `usl mcp` to start the local stdio MCP server. Its configuration is read from the documented MCP environment configuration; stdout is reserved for MCP messages.

All `--out` values use atomic writes and must differ from every input path, including symlink aliases.
