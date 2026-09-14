import { hostname } from "node:os"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { connectUsl, readLean4Export, adaptLean4Export, leanDeclarationId, type Lean4AdaptOptions } from "../src/index.js"

const cwd = fileURLToPath(new URL("../lean/", import.meta.url))
const file = "Examples/Connections.lean"
const options: Lean4AdaptOptions = {
  namespace: "example.lean4",
  source: { id: "lean:usl-example", locator: `file://${hostname()}${cwd}${file}` },
  bindings: [{ declaration: "Demo.dash_requires_ground", description: "The Lean theorem formalizes the grounded dash precondition.",
    resource: { id: "game:dash", types: ["urn:game:Requirement"], locator: "kg://canonical-neo4j/game:dash" } }],
}
const connection = connectUsl({ read: () => readLean4Export({ cwd, file }), adapt: raw => adaptLean4Export(raw, options) })
const context = await Effect.runPromise(connection.context(undefined, {
  focus: "game:dash", target: leanDeclarationId(options.source.id, "Demo.dash_requires_ground"),
}, { compact: true }))
console.log(JSON.stringify(context, null, 2))
