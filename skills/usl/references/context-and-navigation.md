# Context and navigation

Use `agentContext(plan, query)` for structured graph-local context. Its query
starts from a resource and can limit hops, resources, links, visits, target,
and permitted meaning-role routes. It does not resolve a locator.

Use `compactAgentContext(plan, query, options)` when transferring context to an
agent. It preserves plan identity, meaning contracts, and participant roles
while removing repeated paths. Supply a known context digest only when the
receiver actually holds that exact prior context; `UNCHANGED` is not evidence
that a different semantic plan is equivalent.

For command-line source workflows, `usl context --source FILE --focus NAME`
creates context, and `--compact` enables the compact transfer form. See
`docs/COMPACT_CONTEXT.md` for byte/token budget and cache behavior.
