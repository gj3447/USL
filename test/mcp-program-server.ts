import { startUslMcpServer } from "../src/mcp.js"
import { DEFAULT_USL_POLICY } from "../src/application.js"

const path = process.argv[2]
if (!path) throw new Error("registered program path is required")
await startUslMcpServer({ programs: { registered: path }, policy: DEFAULT_USL_POLICY })
