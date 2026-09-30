/** Presentation contracts only: command execution and option validation stay with their owners. */
import { TOOL_VERSION } from "./domain.js"

export const CLI_FAMILIES = [
  { name: "core", summary: "Check, compile, navigate and observe binding declarations." },
  { name: "platform", summary: "Create declarations, compare reports and connect platform tools." },
  { name: "adapter", summary: "Use existing graphs through explicit bindings and optional profiles." },
  { name: "capability", summary: "Discover registered capabilities and check invocation conditions." },
  { name: "host", summary: "Select resource representations and use host-registered programs." },
  { name: "legacy", summary: "Maintain and project link records." },
] as const
export type CliFamily = typeof CLI_FAMILIES[number]["name"]
export interface CliCommandContract {
  readonly name: string
  readonly families: readonly CliFamily[]
  readonly summary: string
  readonly usages: readonly string[]
  readonly notes?: readonly string[]
}

const projectOptions = "    [--anchors FILE] [--title TEXT] [--date YYYY-MM-DD] [--evidence TEXT] [--target-kg-source SOURCE]"
export const CLI_COMMANDS: readonly CliCommandContract[] = [
  { name: "check", families: ["core"], summary: "Validate a binding declaration.", usages: ["usl check --source FILE.usl"] },
  { name: "compile", families: ["core"], summary: "Compile a declaration to its binding plan.", usages: ["usl compile --source FILE.usl [--out PLAN.json]"] },
  { name: "context", families: ["core"], summary: "Select bounded graph context from a declaration.", usages: [
    "usl context --source FILE.usl --focus NAME [--target NAME]",
    "    [--max-hops N] [--max-resources N] [--max-links N] [--max-visits N]",
    "    [--via MEANING:ENTER:EXIT] [--out CONTEXT.json]",
    "    [--compact] [--max-bytes N] [--known-context SHA256] [--stats]",
  ], notes: ["--max-bytes, --known-context and --stats require --compact. --stats writes JSON to stderr.", "--via may be repeated."] },
  { name: "observe", families: ["core"], summary: "Observe selected resources within the permitted read scope.", usages: [
    "usl observe --source FILE.usl [--link NAME] [--allow-locator LOC | --deny-all]",
    "    [--max-resources N] [--baseline REPORT.json] [--out REPORT.json]",
  ], notes: ["--link and --allow-locator may be repeated."] },
  { name: "project", families: ["core", "legacy"], summary: "Project a declaration or link records into a semantic bundle.", usages: [
    "usl project --source FILE.usl --out BUNDLE.json --bundle-uid UID --utterance-file FILE",
    projectOptions,
    "usl project --records FILE --out BUNDLE.json --bundle-uid UID --utterance-file FILE",
    projectOptions,
  ], notes: ["Choose one input form: --source or --records. --evidence may be repeated.", "--anchors maps KG locators to target UIDs for declarations, and link IDs to endpoint anchors for records."] },
  { name: "init", families: ["platform"], summary: "Create an example declaration in a new file.", usages: ["usl init --out FILE.usl"] },
  { name: "compare", families: ["platform"], summary: "Compare observation reports.", usages: ["usl compare --before REPORT --after REPORT [--out FILE]"] },
  { name: "validate-observation", families: ["platform"], summary: "Validate an observation report.", usages: ["usl validate-observation --report REPORT [--out FILE]"] },
  { name: "graph-import", families: ["platform"], summary: "Wrap a graph-engineering export with explicit bindings.", usages: ["usl graph-import --graph FILE --bindings FILE [--out FILE]"] },
  { name: "hswm-prepare", families: ["platform"], summary: "Prepare an HSWM handoff from explicit input.", usages: ["usl hswm-prepare --input JSON [--out FILE]"] },
  { name: "watch", families: ["platform"], summary: "Report declaration changes, or inspect once.", usages: ["usl watch --source FILE [--once]"], notes: ["Emits JSONL status updates; without --once, keeps watching."] },
  { name: "mcp", families: ["platform"], summary: "Start the configured local stdio MCP server.", usages: ["usl mcp [--config FILE.json]"], notes: ["stdout is reserved for MCP protocol messages during execution."] },
  { name: "adapt", families: ["adapter"], summary: "Adapt an existing graph without changing its native resource IDs.", usages: [
    "usl adapt --graph FILE.json --namespace NAME [--format property-graph|resource-graph]",
    "    [--profile PROFILE.json] [--kg-source SOURCE] [--operation check|context|observe|jsonld]",
    "    [--focus UID] [--target UID] [--compact] [--link REL_UID]",
    "    [--allow-locator LOC | --deny-all] [--max-resources N] [--out FILE]",
  ], notes: ["--focus, --target and --compact require context; --focus is required for context.", "--profile and jsonld require resource-graph; --kg-source is only for property-graph.", "--link, --allow-locator and --deny-all require observe. --link and --allow-locator may be repeated."] },
  { name: "capability-discover", families: ["capability"], summary: "Search host-registered capability catalogs.", usages: ["usl capability-discover --config FILE --input REQUEST.json [--out FILE]"] },
  { name: "capability-preflight", families: ["capability"], summary: "Check capability invocation conditions without executing it.", usages: ["usl capability-preflight --config FILE --input REQUEST.json [--out FILE]"] },
  { name: "cli-list", families: ["host"], summary: "List host-registered CLI actions.", usages: ["usl cli-list --config FILE"] },
  { name: "locate", families: ["host"], summary: "Select a resource representation using the host mapping.", usages: ["usl locate --config FILE --resource ID [--representation ID]"] },
  { name: "inspect-binding", families: ["host"], summary: "Inspect a selected representation and its local pins.", usages: ["usl inspect-binding --config FILE --resource ID --representation ID"] },
  { name: "bind-graph", families: ["host"], summary: "Bind a resource graph to explicit representation selections.", usages: ["usl bind-graph --config HOST --graph RESOURCE_GRAPH.json --selections SELECTIONS.json [--out FILE]"] },
  { name: "cli-plan", families: ["host"], summary: "Plan a host-registered action.", usages: ["usl cli-plan --config FILE --action ID --input INVOCATION.json [--out FILE]"] },
  { name: "cli-run", families: ["host"], summary: "Execute a host-authorized action against an expected plan.", usages: ["usl cli-run --config FILE --action ID --input INVOCATION.json --expected-plan sha256:... --receipt-dir NEW_DIRECTORY [--operation-key KEY]"] },
  { name: "cli-inspect", families: ["host"], summary: "Inspect durable attempt receipts.", usages: ["usl cli-inspect --receipt-dir DIRECTORY"] },
  { name: "pierce", families: ["legacy"], summary: "Create a link record from two resolved endpoints.", usages: ["usl pierce --link-id ID --relation REL --from LOC --to LOC [--records FILE] [--replace]", "    [--direction directed|undirected]"] },
  { name: "audit", families: ["legacy"], summary: "Audit link records while preserving their original snapshots.", usages: ["usl audit --records FILE [--write] [--check]"], notes: ["Emits one JSON report per record (JSONL). Rebind explicitly replaces a snapshot after both ends resolve."] },
  { name: "rebind", families: ["legacy"], summary: "Explicitly replace a record's endpoint snapshots.", usages: ["usl rebind --records FILE --link-id ID"] },
  { name: "validate", families: ["legacy"], summary: "Validate stored link records.", usages: ["usl validate --records FILE"] },
]

const exitContract = "Exit: 0 success, 1 operation/validation failure, 2 observation unresolved/changed, audit --check drift or host REJECTED/INDETERMINATE, 64 usage error."
const usageLines = (command: CliCommandContract): string => command.usages.map(line => `  ${line}`).join("\n")
export const renderFamilyUsage = (family: CliFamily): string => CLI_COMMANDS.filter(command => command.families.includes(family)).map(usageLines).join("\n")

export const renderRootHelp = (): string => [
  `USL ${TOOL_VERSION} — binding syntax and CLI programs`,
  "", "Usage: usl <command> [options]", "       usl help [family|command]", "       usl <command> --help", "",
  ...CLI_FAMILIES.flatMap(family => [
    `${family.name}: ${family.summary}`,
    ...CLI_COMMANDS.filter(command => command.families.includes(family.name)).map(command => `  ${command.name.padEnd(22)} ${command.summary}`), "",
  ]),
  "Help writes text to stdout; diagnostics write to stderr. Commands keep their own output contracts.", exitContract,
].join("\n")

export const renderCommandHelp = (name: string): string | undefined => {
  const command = CLI_COMMANDS.find(command => command.name === name)
  if (!command) return undefined
  return [`usl ${command.name} — ${command.summary}`, `Family: ${command.families.join(", ")}`, "", "Usage:", usageLines(command),
    ...(command.notes ? ["", ...command.notes] : []), "", exitContract].join("\n")
}

export const renderHelpTopic = (topic?: string): string | undefined => {
  if (topic === undefined) return renderRootHelp()
  const family = CLI_FAMILIES.find(family => family.name === topic)
  if (!family) return renderCommandHelp(topic)
  return [`usl help ${family.name} — ${family.summary}`, "", renderFamilyUsage(family.name), "",
    "Use usl help <command> or usl <command> --help for details.", "", exitContract].join("\n")
}
