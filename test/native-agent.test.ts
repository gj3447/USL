import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { test, type TestContext } from "node:test"
import { createNativeAgentSession, handoffNativeAgentSession, invalidateNativeAgentSession, runNativeAgentTurn, type NativeAgentCompletion, type NativeAgentHost } from "../src/addons/native-agent.js"
import { createNativeAgentChatModel } from "../src/addons/native-agent-http.js"
import { prepareNativeHttp, recheckNativeHttp } from "../src/addons/native-http.js"
import { createNativeProfileSnapshot } from "../src/addons/native-profile.js"
import { nativeDispatchFixture } from "./native-dispatch-fixture.js"

const host = async (t: TestContext, completion: (request: Parameters<NativeAgentHost["model"]["complete"]>[0]) => Promise<NativeAgentCompletion>, options: Partial<Pick<NativeAgentHost, "instructionOrder" | "modelTimeoutMs">> = {}): Promise<{ readonly agent: NativeAgentHost; readonly fixture: Awaited<ReturnType<typeof nativeDispatchFixture>> }> => {
  const fixture = await nativeDispatchFixture(t)
  const config = JSON.parse(await readFile(fixture.host.registration.cli.configFile, "utf8"))
  const sourceId = fixture.snapshot.manifest.requiredSources[0]!.id
  return { fixture, agent: {
    harnessId: "urn:test:native-agent:harness", dispatch: fixture.host, tool: config.actions[0]!.descriptor,
    model: { id: fixture.host.registration.targetId, complete: completion },
    read: async () => ({ bytes: await readFile(`${fixture.workspace}/rule.json`), revision: "r1" }),
    instructionOrder: options.instructionOrder ?? [sourceId], ...(options.modelTimeoutMs === undefined ? {} : { modelTimeoutMs: options.modelTimeoutMs }),
  } }
}
const turn = (id: string) => ({ invocationId: `urn:test:native-agent:invocation:${id}`, admissionId: `urn:test:native-agent:admission:${id}`, attemptId: `urn:test:native-agent:attempt:${id}`, prompt: "perform the bounded task" })

test("P10 traces ordered full instruction delivery through exactly one P09 tool dispatch", async t => {
  let modelMessages: readonly { readonly role: "system" | "user"; readonly content: string }[] = []
  const value = await host(t, async request => { modelMessages = request.messages; return { kind: "tool", name: "usl_action", arguments: { requested: true } } })
  const session = createNativeAgentSession(value.agent, { sessionId: "urn:test:native-agent:session:one" })
  const result = await runNativeAgentTurn(session, turn("one"))
  assert.equal(result.report.status, "COMPLETED", JSON.stringify(result.report))
  assert.equal(result.report.instructions.length, 1); assert.equal(result.report.instructions[0]?.sourceId, value.fixture.snapshot.manifest.requiredSources[0]?.id)
  assert.ok(result.report.instructionChainDigest); assert.ok(result.report.deliveryDigest); assert.ok(result.report.admissionDigest)
  assert.deepEqual(modelMessages.map(message => message.role), ["system", "system", "user"])
  assert.equal(modelMessages[1]?.content, '{"rule":"required selected source"}\n')
  assert.equal(result.dispatch?.report.status, "SUCCEEDED")
  assert.equal(await readFile(value.fixture.marker, "utf8"), "ran\n")
})

test("P10 holds wrong instruction order and unregistered model tools before any effect", async t => {
  const wrong = await host(t, async () => ({ kind: "final", content: "ignored" }), { instructionOrder: [] })
  const wrongSession = createNativeAgentSession(wrong.agent, { sessionId: "urn:test:native-agent:session:wrong-order" })
  assert.ok((await runNativeAgentTurn(wrongSession, turn("wrong-order"))).report.reasons.includes("INSTRUCTION_ORDER_OR_COVERAGE_MISMATCH"))
  await assert.rejects(readFile(wrong.fixture.marker), /ENOENT/u)
  const tool = await host(t, async () => ({ kind: "tool", name: "shell", arguments: {} }))
  const toolSession = createNativeAgentSession(tool.agent, { sessionId: "urn:test:native-agent:session:wrong-tool" })
  const result = await runNativeAgentTurn(toolSession, turn("wrong-tool"))
  assert.equal(result.report.status, "HOLD"); assert.ok(result.report.reasons.includes("UNREGISTERED_AGENT_TOOL"))
  await assert.rejects(readFile(tool.fixture.marker), /ENOENT/u)
})

test("P10 compaction aborts the active turn, revokes its context, then permits a fresh epoch", async t => {
  let release!: () => void, entered!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const enteredModel = new Promise<void>(resolve => { entered = resolve })
  const value = await host(t, async () => { entered(); await waiting; return { kind: "final", content: "late" } })
  const session = createNativeAgentSession(value.agent, { sessionId: "urn:test:native-agent:session:compact" })
  const pending = runNativeAgentTurn(session, turn("compact-one"))
  await enteredModel
  invalidateNativeAgentSession(session, "COMPACTION"); release()
  const held = await pending
  assert.equal(held.report.status, "HOLD"); assert.ok(held.report.reasons.includes("CONTEXT_REVOKED_OR_ABORTED"))
  const fresh = await runNativeAgentTurn(session, turn("compact-two"))
  assert.equal(fresh.report.status, "COMPLETED"); assert.equal(fresh.report.contextEpoch, 2)
})

test("P10 serializes opaque sessions, maps model timeout to UNKNOWN, and hands off only to a new target", async t => {
  let release!: () => void, entered!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  const enteredModel = new Promise<void>(resolve => { entered = resolve })
  const concurrent = await host(t, async () => { entered(); await wait; return { kind: "final", content: "done" } })
  const session = createNativeAgentSession(concurrent.agent, { sessionId: "urn:test:native-agent:session:busy" })
  const first = runNativeAgentTurn(session, turn("busy-one")); await enteredModel
  const second = await runNativeAgentTurn(session, turn("busy-two")); assert.equal(second.report.status, "HOLD"); assert.ok(second.report.reasons.includes("AGENT_TURN_BUSY"))
  release(); assert.equal((await first).report.status, "COMPLETED")
  let timeoutModelEntered = false
  const timeout = await host(t, async () => { timeoutModelEntered = true; return new Promise(() => undefined) }, { modelTimeoutMs: 1000 })
  const timed = createNativeAgentSession(timeout.agent, { sessionId: "urn:test:native-agent:session:timeout" })
  const unknown = await runNativeAgentTurn(timed, turn("timeout")); assert.equal(unknown.report.status, "UNKNOWN"); assert.equal(unknown.dispatch, null)
  assert.equal(timeoutModelEntered, true)
  const parent = createNativeAgentSession(concurrent.agent, { sessionId: "urn:test:native-agent:session:parent" })
  let childReads = 0
  const childHost: NativeAgentHost = { ...concurrent.agent, dispatch: { ...concurrent.agent.dispatch, registration: { ...concurrent.agent.dispatch.registration, targetId: "urn:test:native-agent:child-target" } }, model: { ...concurrent.agent.model, id: "urn:test:native-agent:child-target" }, read: async request => { childReads++; return concurrent.agent.read(request) } }
  const child = handoffNativeAgentSession(parent, childHost, { sessionId: "urn:test:native-agent:session:child" })
  assert.equal((await runNativeAgentTurn(parent, turn("parent-after-handoff"))).report.status, "HOLD")
  assert.equal(child.parentSessionId, parent.sessionId)
  const childResult = await runNativeAgentTurn(child, turn("child")); assert.equal(childResult.report.status, "COMPLETED"); assert.equal(childReads, 1)
})

test("P10 cloned/reused sessions cannot create a second effect, and compaction during P09 evaluation stops the CLI", async t => {
  const basic = await host(t, async () => ({ kind: "tool", name: "usl_action", arguments: {} }))
  const session = createNativeAgentSession(basic.agent, { sessionId: "urn:test:native-agent:session:opaque" })
  assert.equal((await runNativeAgentTurn(structuredClone(session), turn("clone"))).report.status, "HOLD")
  assert.equal((await runNativeAgentTurn(session, turn("once"))).report.status, "COMPLETED")
  assert.equal((await runNativeAgentTurn(session, turn("once"))).report.status, "HOLD")
  assert.equal(await readFile(basic.fixture.marker, "utf8"), "ran\n")

  let entered!: () => void, release!: () => void
  const evaluatorEntered = new Promise<void>(resolve => { entered = resolve }), evaluatorRelease = new Promise<void>(resolve => { release = resolve })
  const gated = await host(t, async () => ({ kind: "tool", name: "usl_action", arguments: {} }))
  const agent: NativeAgentHost = { ...gated.agent, dispatch: { ...gated.agent.dispatch, evaluators: [{ ...gated.agent.dispatch.evaluators[0]!, evaluate: async () => { entered(); await evaluatorRelease; return { status: "PASS", evidenceDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } } }] } }
  const gatedSession = createNativeAgentSession(agent, { sessionId: "urn:test:native-agent:session:evaluator-compaction" })
  const pending = runNativeAgentTurn(gatedSession, turn("evaluator-compaction")); await evaluatorEntered
  invalidateNativeAgentSession(gatedSession, "COMPACTION"); release()
  const stopped = await pending
  assert.equal(stopped.report.status, "HOLD"); assert.ok(stopped.report.reasons.includes("CONTEXT_REVOKED_OR_ABORTED"))
  await assert.rejects(readFile(gated.fixture.marker), /ENOENT/u)
})

test("P10 accepts a registered loopback HTTP reader only after its representation is rechecked", async t => {
  const body = '{"rule":"required selected source"}\n', etag = '"agent-rule-v1"'
  const server = createServer((request, response) => {
    response.setHeader("ETag", etag)
    if (request.headers["if-none-match"] === etag) { response.writeHead(304); response.end(); return }
    response.writeHead(200); response.end(body)
  })
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  t.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() }))
  const address = server.address(); assert.ok(address && typeof address === "object")
  const url = `http://127.0.0.1:${address.port}/rule`, scope = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  const value = await host(t, async () => ({ kind: "tool", name: "usl_action", arguments: { via: "http" } }))
  const agent: NativeAgentHost = { ...value.agent, read: async request => {
    const prepared = await prepareNativeHttp({ url, scopeDigest: scope, allowedUrls: [url], maxBytes: request.source.bytes })
    if (prepared.report.status !== "PASS" || prepared.report.bodyDigest !== request.source.digest) throw new Error("HTTP_PIN_HELD")
    const response = await fetch(url), bytes = new Uint8Array(await response.arrayBuffer())
    if ((await recheckNativeHttp(prepared)).status !== "PASS") throw new Error("HTTP_RECHECK_HELD")
    return { bytes, revision: request.source.revision }
  } }
  const session = createNativeAgentSession(agent, { sessionId: "urn:test:native-agent:session:http" })
  const result = await runNativeAgentTurn(session, turn("http-reader"))
  assert.equal(result.report.status, "COMPLETED", JSON.stringify(result.report))
  assert.equal(result.dispatch?.report.status, "SUCCEEDED")
  assert.equal(await readFile(value.fixture.marker, "utf8"), "ran\n")
})

test("P10 preserves exact two-source order and full bytes in model context", async t => {
  let received: readonly { readonly role: string; readonly content: string }[] = []
  const value = await host(t, async request => { received = request.messages; return { kind: "final", content: "complete" } })
  const first = value.fixture.snapshot.manifest.requiredSources[0]!, second = { ...first, id: "urn:test:native-agent:required-rule-selector", selector: { kind: "json-pointer" as const, value: "/rule" } }
  const manifest = { ...value.fixture.snapshot.manifest, requiredSources: [first, second] }
  const snapshot = createNativeProfileSnapshot(manifest, 2, value.fixture.snapshot.hostBindingDigest)
  const state = await value.fixture.store.read(), activated = await value.fixture.store.activate(state.digest, snapshot)
  assert.equal(activated.status, "COMMITTED")
  const ordered: NativeAgentHost = { ...value.agent, instructionOrder: [first.id, second.id] }
  const session = createNativeAgentSession(ordered, { sessionId: "urn:test:native-agent:session:two-sources" })
  const result = await runNativeAgentTurn(session, turn("two-sources"))
  assert.equal(result.report.status, "COMPLETED")
  assert.deepEqual(result.report.instructions.map(item => item.sourceId), [first.id, second.id])
  assert.deepEqual(received.map(item => item.role), ["system", "system", "system", "user"])
  assert.deepEqual(received.slice(1, 3).map(item => item.content), ['{"rule":"required selected source"}\n', '{"rule":"required selected source"}\n'])
})

test("P10 OpenAI-compatible loopback model receives pinned context and its function proposal alone reaches P09", async t => {
  const requests: unknown[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")))
    const index = requests.length
    response.setHeader("content-type", "application/json")
    if (index === 1) response.end(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ type: "function", function: { name: "usl_action", arguments: '{"from":"loopback"}' } }] } }] }))
    else response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { refusal: "declined", content: null } }] }))
  })
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  t.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() }))
  const address = server.address(); assert.ok(address && typeof address === "object")
  const value = await host(t, async () => ({ kind: "final", content: "unused" }))
  const model = createNativeAgentChatModel({ id: value.fixture.host.registration.targetId, endpoint: `http://127.0.0.1:${address.port}/chat/completions`, model: "loopback", allowHttp: true })
  const agent: NativeAgentHost = { ...value.agent, model }
  const session = createNativeAgentSession(agent, { sessionId: "urn:test:native-agent:session:chat-http" })
  const executed = await runNativeAgentTurn(session, turn("chat-http-one"))
  assert.equal(executed.report.status, "COMPLETED", JSON.stringify(executed.report)); assert.equal(executed.dispatch?.report.status, "SUCCEEDED")
  const first = requests[0] as { readonly messages: readonly { readonly content: string }[]; readonly tools: readonly { readonly function: { readonly parameters: unknown } }[] }
  assert.equal(first.messages[1]?.content, '{"rule":"required selected source"}\n'); assert.deepEqual(first.tools[0]?.function.parameters, { type: "object" })
  assert.ok(executed.report.modelRequestDigest && executed.report.modelResponseDigest && executed.report.effectDigest && executed.report.cliReceiptDigest)
  assert.equal(executed.report.modelRegistrationDigest, model.registrationDigest)
  const refused = await runNativeAgentTurn(session, turn("chat-http-two"))
  assert.equal(refused.report.status, "UNKNOWN"); assert.equal(refused.dispatch, null)
  assert.equal(await readFile(value.fixture.marker, "utf8"), "ran\n")
})
