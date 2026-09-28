import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parseResourceBindings, resolveResourceRepresentation, selectResourceRepresentation } from "../src/resource-bindings.js"
import { temporary } from "./fixtures.js"

const commit = "0123456789abcdef0123456789abcdef01234567"
const document = () => parseResourceBindings({
  schema: "usl-resource-bindings/v1",
  resources: [{ id: "urn:usl:repo:USL", representations: [
    { id: "engine-local", relation: "working-copy", kind: "workspace", workspace: "checkout", path: "src/engine.ts", digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { id: "engine-git", relation: "snapshot", kind: "locator", locator: `git://github.com/example/engine@${commit}:src/engine.ts` },
    { id: "engine-docs", relation: "documentation", kind: "locator", locator: "https://example.com/engine" },
  ] }],
})

test("stable resource IDs allow root relocation while representations remain explicit", async (t) => {
  const first = await temporary(t), second = await temporary(t)
  for (const root of [first, second]) { await mkdir(join(root, "src")); await writeFile(join(root, "src", "engine.ts"), "export {}\n") }
  const bindings = document()
  assert.throws(() => selectResourceRepresentation(bindings, { resource: "urn:usl:repo:USL" }), /ambiguous/)
  const selected = selectResourceRepresentation(bindings, { resource: "urn:usl:repo:USL", representation: "engine-local" })
  assert.equal(selected.resource.id, "urn:usl:repo:USL")
  const one = await resolveResourceRepresentation(bindings, { resource: "urn:usl:repo:USL", representation: "engine-local" }, { workspaces: { checkout: first }, hostname: "test-host" })
  const two = await resolveResourceRepresentation(bindings, { resource: "urn:usl:repo:USL", representation: "engine-local" }, { workspaces: { checkout: second }, hostname: "test-host" })
  assert.equal(one.resource, two.resource)
  assert.equal(one.representation, two.representation)
  assert.notEqual(one.locator, two.locator)
  assert.equal(one.path, join(first, "src", "engine.ts"))
  assert.equal(one.relativePath, "src/engine.ts")
  assert.equal(one.expectedDigest, "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
})

test("locator selection is explicit and carries no local workspace requirement", async () => {
  const bindings = document()
  const resolved = await resolveResourceRepresentation(bindings, { resource: "urn:usl:repo:USL", representation: "engine-git" }, { workspaces: {} })
  assert.equal(resolved.kind, "locator")
  assert.equal(resolved.locator, `git://github.com/example/engine@${commit}:src/engine.ts`)
})

test("parser rejects mutable, credentialed and nonportable representations", () => {
  const base = { schema: "usl-resource-bindings/v1", resources: [{ id: "x", representations: [] as unknown[] }] }
  for (const representation of [
    { id: "a", relation: "snapshot", kind: "locator", locator: "git://github.com/example/repo@abcdef12:file.txt" },
    { id: "a", relation: "snapshot", kind: "locator", locator: `git://github.com/example/repo@${"a".repeat(41)}:file.txt` },
    { id: "a", relation: "documentation", kind: "locator", locator: "https://token@example.com/private" },
    { id: "a", relation: "working-copy", kind: "workspace", workspace: "root", path: "../outside" },
  ]) assert.throws(() => parseResourceBindings({ ...base, resources: [{ id: "x", representations: [representation] }] }))
})

test("public boundaries capture immutable data and reject inherited/getter fields", () => {
  const bindings = document()
  const mutable = structuredClone(bindings) as unknown as ReturnType<typeof document> & { resources: Array<{ id: string; representations: unknown[] }> }
  const selected = selectResourceRepresentation(mutable, { resource: "urn:usl:repo:USL", representation: "engine-git" })
  mutable.resources[0]!.id = "changed"
  assert.equal(selected.resource.id, "urn:usl:repo:USL")
  assert.ok(Object.isFrozen(selected.resource))
  const inherited = Object.create({ schema: "usl-resource-bindings/v1", resources: [] })
  assert.throws(() => parseResourceBindings(inherited), /plain JSON objects/)
  const getter = { schema: "usl-resource-bindings/v1", get resources() { throw new Error("getter must not run") } }
  assert.throws(() => parseResourceBindings(getter), /enumerable JSON values/)
  assert.throws(() => selectResourceRepresentation(bindings, { resource: "urn:usl:repo:USL", representation: "engine-git", extra: true } as never), /unknown representation selection field/)
})

test("workspace resolution rejects a symlink that leaves its registered root", async (t) => {
  const root = await temporary(t), outside = await temporary(t)
  await writeFile(join(outside, "secret.ts"), "secret")
  await symlink(outside, join(root, "linked"))
  const bindings = parseResourceBindings({ schema: "usl-resource-bindings/v1", resources: [{ id: "x", representations: [
    { id: "x-local", relation: "working-copy", kind: "workspace", workspace: "root", path: "linked/secret.ts" },
  ] }] })
  await assert.rejects(resolveResourceRepresentation(bindings, { resource: "x" }, { workspaces: { root } }), /outside its root/)
})

test("native IDs and a filesystem-root workspace remain representable", async () => {
  const current = process.cwd()
  const bindings = parseResourceBindings({ schema: "usl-resource-bindings/v1", resources: [{ id: "node:a", representations: [
    { id: "root-current", relation: "working-copy", kind: "workspace", workspace: "root", path: current.slice(1) },
  ] }] })
  const resolved = await resolveResourceRepresentation(bindings, { resource: "node:a" }, { workspaces: { root: "/" }, hostname: "test-host" })
  assert.equal(resolved.path, current)
  assert.equal(resolved.relativePath, current.slice(1))
})

test("literal filenames cannot turn into a different file's line selector", async t => {
  const root = await temporary(t)
  await writeFile(join(root, "source#L1-L2"), "literal hash filename")
  const bindings = parseResourceBindings({ schema: "usl-resource-bindings/v1", resources: [{ id: "source", representations: [
    { id: "local", relation: "working-copy", kind: "workspace", workspace: "root", path: "source#L1-L2" },
  ] }] })
  await assert.rejects(resolveResourceRepresentation(bindings, { resource: "source" }, { workspaces: { root } }), /cannot be represented/)
})
