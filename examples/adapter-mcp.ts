import { readFile } from "node:fs/promises"
import { Either } from "effect"
import { DEFAULT_USL_POLICY } from "../src/application.js"
import { adaptPropertyGraph } from "../src/integrations/property-graph.js"
import { startUslMcpServer } from "../src/mcp.js"

// A host owns the read operation and connection IDs. The same callback can read
// an existing KG API; the MCP caller never supplies a query or filesystem path.
await startUslMcpServer({ policy: { ...DEFAULT_USL_POLICY, getConnection: async id => {
  if (id !== "game") throw new Error("unknown connection")
  const raw = await readFile(new URL("./fixtures/native-graph.json", import.meta.url), "utf8")
  return Either.getOrThrow(adaptPropertyGraph(raw, { namespace: "game.adapter" }))
} } })
