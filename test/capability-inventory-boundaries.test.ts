import assert from "node:assert/strict"
import { test } from "node:test"
import { importMcpTools, importOpenApi, inventoryResourceGraph } from "../src/integrations/capability-inventory.js"

const options = { connection: "owner", complete: true, bindings: {} }
const response = (extra: Record<string, unknown> = {}) => ({ description: "ok", content: { "application/json": { schema: { type: "object" } } }, ...extra })

test("OpenAPI path templates stay unsupported without a parameter serializer", () => {
  const inventory = importOpenApi(JSON.stringify({ openapi: "3.1.1", paths: { "/users/{id}": { get: { responses: { "200": response() } } } } }), options)
  assert.ok(inventory.capabilities[0]!.mapping.unsupported.some(item => item.startsWith("path template:")))
})

test("OpenAPI response headers and links stay unsupported when their values would be dropped", () => {
  const inventory = importOpenApi(JSON.stringify({ openapi: "3.1.1", paths: { "/users": { get: { responses: {
    "200": response({ headers: { "X-Rate-Limit": { schema: { type: "integer" } } }, links: { next: { operationId: "listUsers" } } }),
  } } } } }), options)
  const unsupported = inventory.capabilities[0]!.mapping.unsupported
  assert.ok(unsupported.some(item => item.startsWith("response headers:")))
  assert.ok(unsupported.some(item => item.startsWith("response links:")))
})

test("inventory graph projection reimports the pinned source before accepting descriptors", () => {
  const raw = JSON.stringify({ tools: [{ name: "read", inputSchema: { type: "object" }, outputSchema: { type: "object" } }] })
  const inventory = importMcpTools(raw, options)
  assert.equal(inventoryResourceGraph(inventory, "file://fixture/tools.json").links.length, 1)

  const forgedOperation = structuredClone(inventory)
  forgedOperation.capabilities[0]!.nativeOperation = "delete"
  assert.throws(() => inventoryResourceGraph(forgedOperation, "file://fixture/tools.json"), /pinned source representation/)

  const forgedSchema = structuredClone(inventory)
  forgedSchema.capabilities[0]!.input.schema = { type: "string" }
  assert.throws(() => inventoryResourceGraph(forgedSchema, "file://fixture/tools.json"), /pinned source representation/)

  const paged = importMcpTools(JSON.stringify({ tools: [{ name: "read", inputSchema: { type: "object" } }], nextCursor: "next" }), options)
  const forgedComplete = { ...structuredClone(paged), complete: true }
  assert.throws(() => inventoryResourceGraph(forgedComplete, "file://fixture/tools.json"), /pinned source representation/)
})
