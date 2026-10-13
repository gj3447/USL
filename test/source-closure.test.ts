import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { sourceClosure } from "../scripts/source-closure.js"
import { temporary } from "./fixtures.js"

const tree = async (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), text)
  }
}

test("evidence pins follow imports and spawned code, and leave unrelated sources out", async (t) => {
  const root = await temporary(t)
  await tree(root, {
    "test/a.test.ts": [
      'import { b } from "../src/b.js"',
      'import type { T } from "../src/types.js"',
      'const lazy = () => import("../src/lazy.js")',
      'execFile(process.execPath, ["--import", "tsx", "src/cli.ts"])',
      'const mcp = new URL("../src/mcp.ts", import.meta.url)',
      'const host = join(root, "src", "host-entry.ts")',
      'const notAFile = "file://game/src/dash.ts"',
      'import x from "effect"',
    ].join("\n"),
    "src/b.ts": 'export { c } from "./nested/c.js"\nexport const b = 1',
    "src/nested/c.ts": "export const c = 1",
    "src/types.ts": "export type T = 1",
    "src/lazy.ts": "export const lazy = 1",
    "src/cli.ts": 'import "./cli-only.js"',
    "src/cli-only.ts": "",
    "src/mcp.ts": "",
    "src/host-entry.ts": "",
    "src/unrelated.ts": 'import "./b.js"',
    "src/addons/unrelated.ts": "",
  })
  assert.deepEqual(sourceClosure(root, ["test/a.test.ts"]), [
    "src/b.ts", "src/cli-only.ts", "src/cli.ts", "src/host-entry.ts", "src/lazy.ts", "src/mcp.ts", "src/nested/c.ts", "src/types.ts", "test/a.test.ts",
  ])
  // A dependency added later is pinned; non-code entries are kept as leaves.
  await tree(root, { "src/nested/c.ts": 'import "../addons/unrelated.js"', "schemas/shape.ttl": "" })
  assert.ok(sourceClosure(root, ["test/a.test.ts", "schemas/shape.ttl"]).includes("src/addons/unrelated.ts"))
  assert.ok(sourceClosure(root, ["test/a.test.ts", "schemas/shape.ttl"]).includes("schemas/shape.ttl"))
})

test("an unresolved relative import or missing entry fails closed", async (t) => {
  const root = await temporary(t)
  await tree(root, { "test/a.test.ts": 'import "../src/missing.js"' })
  assert.throws(() => sourceClosure(root, ["test/a.test.ts"]), /unresolved relative import/)
  assert.throws(() => sourceClosure(root, ["test/none.test.ts"]), /missing/)
})
