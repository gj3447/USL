/** Owner-configured OpenAI-compatible chat transport for the native agent harness. */
import { z } from "zod"
import { contractDigest, contractIri, contractSnapshot } from "../contract-core.js"
import type { NativeAgentCompletionRequest, NativeAgentModel } from "./native-agent.js"

const bytes = z.number().int().min(1).max(4 * 1024 * 1024)
const duration = z.number().int().min(1).max(60_000)
const tokens = z.number().int().min(1).max(16_384)
const messagesSchema = z.array(z.strictObject({ role: z.enum(["system", "user"]), content: z.string() })).min(1).max(1024)
const toolSchema = z.strictObject({ name: z.literal("usl_action"), description: z.string(), parameters: z.json().refine(value => value !== null && !Array.isArray(value) && typeof value === "object", "tool parameters must be an object schema") })
export interface NativeAgentHttpConfig {
  readonly id: string
  /** Full owner-selected `/chat/completions` endpoint. */
  readonly endpoint: string
  readonly model: string
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
  readonly timeoutMs?: number
  readonly maxTokens?: number
  readonly allowHttp?: boolean
  readonly getAuthorization?: () => string | undefined
}
export interface NativeAgentHttpModel extends NativeAgentModel { readonly registrationDigest: string }
export class NativeAgentHttpError extends Error { constructor(readonly code: string) { super(code); this.name = "NativeAgentHttpError" } }
const fail = (code: string): never => { throw new NativeAgentHttpError(code) }
const bounded = (value: number | undefined, fallback: number) => bytes.parse(value ?? fallback)
const validEndpoint = (value: string, allowHttp: boolean): string => {
  let url: URL
  try { url = new URL(value) } catch { return fail("ENDPOINT_INVALID") }
  if (!((url.protocol === "https:") || (allowHttp && url.protocol === "http:")) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/chat/completions") || url.href !== value) fail("ENDPOINT_INVALID")
  return url.href
}
const responseBytes = async (response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> => {
  const declared = response.headers.get("content-length")
  if (declared !== null && (!/^[0-9]+$/u.test(declared) || Number(declared) > limit)) fail("RESPONSE_TOO_LARGE")
  const maybeReader = response.body?.getReader()
  if (!maybeReader) throw new NativeAgentHttpError("RESPONSE_BODY_MISSING")
  const reader = maybeReader
  const chunks: Uint8Array[] = []; let total = 0
  try { while (true) { if (signal.aborted) fail("ABORTED"); const next = await reader.read(); if (next.done) break; total += next.value.byteLength; if (total > limit) fail("RESPONSE_TOO_LARGE"); chunks.push(next.value) } }
  catch (error) { if (error instanceof NativeAgentHttpError) throw error; fail(signal.aborted ? "ABORTED" : "RESPONSE_READ_FAILED") }
  finally { reader.releaseLock() }
  const out = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength }; return out
}
const parseCompletion = (input: unknown, toolName: string) => {
  if (input === null || typeof input !== "object") fail("RESPONSE_MALFORMED")
  const choices = (input as Record<string, unknown>).choices
  if (!Array.isArray(choices) || choices.length !== 1 || choices[0] === null || typeof choices[0] !== "object") fail("RESPONSE_CHOICES_INVALID")
  const choice = (choices as unknown[])[0] as Record<string, unknown>, message = choice.message
  if (message === null || typeof message !== "object") fail("RESPONSE_MALFORMED")
  const value = message as Record<string, unknown>, calls = value.tool_calls
  if (value.role !== undefined && value.role !== "assistant") fail("RESPONSE_MALFORMED")
  if (value.refusal !== undefined && value.refusal !== null) fail("RESPONSE_REFUSAL")
  if (choice.finish_reason === "stop" && typeof value.content === "string" && (calls === undefined || (Array.isArray(calls) && calls.length === 0))) return { kind: "final" as const, content: value.content }
  if (!Array.isArray(calls) || (calls as unknown[]).length !== 1 || choice.finish_reason !== "tool_calls") fail("RESPONSE_TOOL_INVALID")
  const call = (calls as unknown[])[0]
  if (call === null || typeof call !== "object") fail("RESPONSE_TOOL_INVALID")
  const functionValue = (call as Record<string, unknown>).function
  if ((call as Record<string, unknown>).type !== "function" || functionValue === null || typeof functionValue !== "object") fail("RESPONSE_TOOL_INVALID")
  const fn = functionValue as Record<string, unknown>
  if (fn.name !== toolName || typeof fn.arguments !== "string") fail("RESPONSE_TOOL_INVALID")
  const argumentText = fn.arguments as string
  let args: unknown; try { args = JSON.parse(argumentText) } catch { return fail("RESPONSE_TOOL_ARGUMENTS_INVALID") }
  if (args === null || Array.isArray(args) || typeof args !== "object") fail("RESPONSE_TOOL_ARGUMENTS_INVALID")
  try { return { kind: "tool" as const, name: toolName, arguments: z.json().parse(args) } }
  catch { return fail("RESPONSE_TOOL_ARGUMENTS_INVALID") }
}

export const createNativeAgentChatModel = (input: NativeAgentHttpConfig): NativeAgentHttpModel => {
  const { getAuthorization: authorization, ...plain } = input
  const config = contractSnapshot(plain) as Omit<NativeAgentHttpConfig, "getAuthorization">
  if (authorization !== undefined && typeof authorization !== "function") fail("AUTHORIZATION_CALLBACK_INVALID")
  const id = contractIri.parse(config.id), allowHttp = config.allowHttp === true, endpoint = validEndpoint(config.endpoint, allowHttp)
  if (typeof config.model !== "string" || !config.model || config.model.length > 1024) fail("MODEL_INVALID")
  const maxRequestBytes = bounded(config.maxRequestBytes, 1024 * 1024), maxResponseBytes = bounded(config.maxResponseBytes, 1024 * 1024)
  const timeoutMs = duration.parse(config.timeoutMs ?? 30_000), maxTokens = tokens.parse(config.maxTokens ?? 1024)
  const registrationDigest = contractDigest({ id, endpoint, model: config.model, maxRequestBytes, maxResponseBytes, timeoutMs, maxTokens, allowHttp })
  return Object.freeze({ id, registrationDigest, complete: async (request: NativeAgentCompletionRequest) => {
    let captured: { messages: z.infer<typeof messagesSchema>; tool: z.infer<typeof toolSchema> }
    try { captured = { messages: messagesSchema.parse(request.messages), tool: toolSchema.parse(request.tool) } }
    catch { return fail("REQUEST_INVALID") }
    const signal = request.signal
    if (!(signal instanceof AbortSignal) || signal.aborted) fail("ABORTED")
    let token: string | undefined
    try { token = authorization?.() } catch { return fail("AUTHORIZATION_UNAVAILABLE") }
    if (token !== undefined && (typeof token !== "string" || !token || token.length > 8192 || /[\r\n]/u.test(token))) fail("AUTHORIZATION_INVALID")
    const body = { model: config.model, messages: captured.messages, tools: [{ type: "function", function: captured.tool }], tool_choice: "auto", parallel_tool_calls: false, stream: false, max_tokens: maxTokens }
    let encoded: Uint8Array, wire: string; try { wire = JSON.stringify(body); encoded = new TextEncoder().encode(wire) } catch { return fail("REQUEST_INVALID") }; if (encoded.byteLength > maxRequestBytes) fail("REQUEST_TOO_LARGE")
    const controller = new AbortController(), abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) controller.abort()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    try {
      let response: Response
      try { response = await fetch(endpoint, { method: "POST", redirect: "error", signal: controller.signal, headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: token }) }, body: wire }) }
      catch { return fail(signal.aborted ? "ABORTED" : timedOut ? "TIMEOUT" : "TRANSPORT_FAILED") }
      if (!response.ok) fail("HTTP_STATUS_REJECTED")
      let raw: Uint8Array; try { raw = await responseBytes(response, maxResponseBytes, controller.signal) } catch (error) { if (timedOut) return fail("TIMEOUT"); throw error }
      let value: unknown; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) } catch { return fail("RESPONSE_MALFORMED") }
      return parseCompletion(value, captured.tool.name)
    } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); controller.abort() }
  } })
}
