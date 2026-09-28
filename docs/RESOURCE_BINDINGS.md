# Stable resource identities and portable representations

`usl-resource-bindings/v1` separates an owner-stable resource ID from its
representations. It is a portable binding document, not an access grant,
content verifier, graph executor, or equivalence claim.

```json
{
  "schema": "usl-resource-bindings/v1",
  "resources": [{
    "id": "validator",
    "representations": [
      { "id": "validator-worktree", "relation": "working-copy", "kind": "workspace", "workspace": "project", "path": "tools/validate.ts" },
      { "id": "validator-release", "relation": "snapshot", "kind": "locator", "locator": "git://github.com/example/project@0123456789abcdef0123456789abcdef01234567:tools/validate.ts" }
    ]
  }]
}
```

Workspace roots are host configuration, for example `{ "project":
"/checkout/on/this/machine" }`; absolute paths never enter the document. A
workspace `path` is relative and cannot contain traversal segments. Resolution
uses `realpath` for both root and candidate, and refuses a symbolic link that
escapes the root. Moving a checkout only changes the host mapping.

For `locate` and `bind-graph` without any executable actions, a minimal host file is:

```json
{
  "schema": "usl-cli-host/v1",
  "bindings": "resource-bindings.json",
  "workspaces": { "project": ".." },
  "maxSourceBytes": 8388608,
  "actions": []
}
```

Both paths above are relative to that host file's directory.

Locator representations accept only HTTP(S) and Git locators. URL credentials
are refused. Git representations require an exactly 40 or 64 digit commit. A `snapshot`
relation labels a representation's intended role; an HTTPS URL itself is not a
promise of immutable content. Optional `sha256:` values are expected-content
declarations returned by resolution; the resolver does not read bytes to verify
them.

`selectResourceRepresentation` refuses an omitted selection whenever a resource
has more than one representation. It never assumes a worktree, Git URL, mirror,
or documentation URL is equivalent to another representation. The caller then
passes that selected ID to `resolveResourceRepresentation` with host-owned
workspace roots. For a workspace representation, its result has `path` as the
canonical absolute local path for a registered host runner and `relativePath`
as the portable value from the document.

`bindResourceGraph` (from the main SDK export) applies explicit selections to an
existing `resource-graph/v1` while preserving its resource IDs, meaning/role
links and metadata. The `bind-graph` CLI returns the rebound `graph` with a
`bindingReceipt`; see [the graph/CLI architecture](CLI_GRAPH_ARCHITECTURE.md).
