import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from "node:http"
import { test } from "node:test"
import { createNativeAgentChatModel, NativeAgentHttpError } from "../src/addons/native-agent-http.js"

const request = (signal = new AbortController().signal) => ({ messages: [{ role: "system" as const, content: "first" }, { role: "user" as const, content: "second" }], tool: { name: "usl_action" as const, description: "pinned", parameters: { type: "object" } }, signal })
const server = async (handler: RequestListener<typeof IncomingMessage, typeof ServerResponse>) => {
  const value = createServer(handler); await new Promise<void>(resolve => value.listen(0, "127.0.0.1", resolve)); const address = value.address(); if (!address || typeof address === "string") throw new Error("listen failed")
  return { endpoint: `http://127.0.0.1:${address.port}/chat/completions`, close: () => new Promise<void>(resolve => value.close(() => resolve())) }
}
const rejects = async (value: Promise<unknown>, code: string) => assert.rejects(value, error => error instanceof NativeAgentHttpError && error.code === code)

test("P10 posts the exact pinned chat request and parses final and tool replies", async t => {
  const seen: unknown[] = [], s = await server(async (req, res) => { const parts: Buffer[] = []; for await (const part of req) parts.push(part); seen.push({ method: req.method, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(parts).toString("utf8")) }); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "final" } }] })) }); t.after(s.close)
  const model = createNativeAgentChatModel({ id: "urn:test:agent", endpoint: s.endpoint, model: "local", allowHttp: true, getAuthorization: () => "Bearer local" })
  assert.deepEqual(await model.complete(request()), { kind: "final", content: "final" })
  assert.deepEqual(seen, [{ method: "POST", authorization: "Bearer local", body: { model: "local", messages: request().messages, tools: [{ type: "function", function: request().tool }], tool_choice: "auto", parallel_tool_calls: false, stream: false, max_tokens: 1024 } }])
  await s.close()
  const tools = await server((_req, res) => { res.end(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ type: "function", function: { name: "usl_action", arguments: '{"x":1}' } }] } }] })) }); t.after(tools.close)
  const toolModel = createNativeAgentChatModel({ id: "urn:test:tool", endpoint: tools.endpoint, model: "local", allowHttp: true })
  assert.deepEqual(await toolModel.complete(request()), { kind: "tool", name: "usl_action", arguments: { x: 1 } })
})

test("P10 rejects redirects, malformed tool replies, and bounded or cancelled transports", async t => {
  const redirect = await server((_req, res) => { res.writeHead(302, { location: "/chat/completions" }); res.end() }); t.after(redirect.close)
  await rejects(createNativeAgentChatModel({ id: "urn:test:redirect", endpoint: redirect.endpoint, model: "x", allowHttp: true }).complete(request()), "TRANSPORT_FAILED")
  const malformed = await server((_req, res) => res.end(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ type: "function", function: { name: "usl_action", arguments: "[]" } }, { type: "function", function: { name: "usl_action", arguments: "{}" } }] } }] }))); t.after(malformed.close)
  await rejects(createNativeAgentChatModel({ id: "urn:test:malformed", endpoint: malformed.endpoint, model: "x", allowHttp: true }).complete(request()), "RESPONSE_TOOL_INVALID")
  const slow = await server(async (_req, res) => { await new Promise(resolve => setTimeout(resolve, 50)); res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "late" } }] })) }); t.after(slow.close)
  await rejects(createNativeAgentChatModel({ id: "urn:test:slow", endpoint: slow.endpoint, model: "x", allowHttp: true, timeoutMs: 1 }).complete(request()), "TIMEOUT")
  const controller = new AbortController(); controller.abort()
  await rejects(createNativeAgentChatModel({ id: "urn:test:abort", endpoint: slow.endpoint, model: "x", allowHttp: true }).complete(request(controller.signal)), "ABORTED")
})

test("P10 rejects invalid requests before network and malformed, invalid-UTF8, or oversized replies", async t => {
  let calls = 0
  const s = await server((_req, res) => { calls++; res.end(Buffer.from([0xff])) }); t.after(s.close)
  const model = createNativeAgentChatModel({ id: "urn:test:strict", endpoint: s.endpoint, model: "x", allowHttp: true, maxResponseBytes: 8 })
  await rejects(model.complete({ ...request(), messages: [{ role: "assistant" as unknown as "system", content: "no" }] }), "REQUEST_INVALID")
  assert.equal(calls, 0)
  await rejects(model.complete(request()), "RESPONSE_MALFORMED")
  const refusal = await server((_req, res) => res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "no", refusal: "policy" } }] }))); t.after(refusal.close)
  await rejects(createNativeAgentChatModel({ id: "urn:test:refusal", endpoint: refusal.endpoint, model: "x", allowHttp: true }).complete(request()), "RESPONSE_REFUSAL")
  const wrongTool = await server((_req, res) => res.end(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ type: "function", function: { name: "other", arguments: "{}" } }] } }] }))); t.after(wrongTool.close)
  await rejects(createNativeAgentChatModel({ id: "urn:test:tool-name", endpoint: wrongTool.endpoint, model: "x", allowHttp: true }).complete(request()), "RESPONSE_TOOL_INVALID")
  const oversized = await server((_req, res) => { res.setHeader("content-length", "99"); res.end("x") }); t.after(oversized.close)
  await rejects(createNativeAgentChatModel({ id: "urn:test:size", endpoint: oversized.endpoint, model: "x", allowHttp: true, maxResponseBytes: 8 }).complete(request()), "RESPONSE_TOO_LARGE")
})

test("P10 applies configured request budgets and aborts a slow response body", async t => {
  let calls = 0
  const s = await server((_req, res) => { calls++; res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }] })) }); t.after(s.close)
  const large = "x".repeat(1024 * 1024 + 32 * 1024)
  const tight = createNativeAgentChatModel({ id: "urn:test:tight", endpoint: s.endpoint, model: "x", allowHttp: true, maxRequestBytes: 1024 * 1024 })
  await rejects(tight.complete({ ...request(), messages: [{ role: "user", content: large }] }), "REQUEST_TOO_LARGE")
  assert.equal(calls, 0)
  const wide = createNativeAgentChatModel({ id: "urn:test:wide", endpoint: s.endpoint, model: "x", allowHttp: true, maxRequestBytes: 2 * 1024 * 1024 })
  assert.deepEqual(await wide.complete({ ...request(), messages: [{ role: "user", content: large }] }), { kind: "final", content: "ok" })
  assert.equal(calls, 1)
  const slow = await server(async (_req, res) => { res.write('{"choices":['); await new Promise(resolve => setTimeout(resolve, 40)); res.end('{"finish_reason":"stop","message":{"content":"late"}}]}') }); t.after(slow.close)
  await rejects(createNativeAgentChatModel({ id: "urn:test:chunk-timeout", endpoint: slow.endpoint, model: "x", allowHttp: true, timeoutMs: 5 }).complete(request()), "TIMEOUT")
})

test("P10 rejects HTTP endpoints unless explicitly enabled", () => {
  assert.throws(() => createNativeAgentChatModel({ id: "urn:test:https", endpoint: "http://127.0.0.1:1/chat/completions", model: "x" }), error => error instanceof NativeAgentHttpError && error.code === "ENDPOINT_INVALID")
  assert.throws(() => createNativeAgentChatModel({ id: "urn:test:credentials", endpoint: "https://user:pass@example.test/chat/completions", model: "x" }), error => error instanceof NativeAgentHttpError)
})
