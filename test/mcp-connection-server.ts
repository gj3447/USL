import { readFile } from "node:fs/promises"
import { Either } from "effect"
import { adaptPropertyGraph } from "../src/integrations/property-graph.js"
import { startUslMcpServer } from "../src/mcp.js"
import { DEFAULT_USL_POLICY } from "../src/application.js"

const path = process.argv[2]
if (!path) throw new Error("connection JSON path is required")
await startUslMcpServer({ policy: { ...DEFAULT_USL_POLICY, getConnection: async (id) => {
  if (id !== "game") throw new Error("unknown connection")
  return Either.getOrThrow(adaptPropertyGraph(await readFile(path, "utf8"), { namespace: "native_mcp" }))
} } })
