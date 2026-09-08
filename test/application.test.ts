import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect, Either } from "effect"
import { executeUslOperation, type UslOperationPolicy } from "../src/application.js"
import { compileSource } from "../src/language/compiler.js"
import { formatLocator } from "../src/locator.js"

const source = (namespace = "application_test", description = "declared relation") => `usl "0.1";
namespace "${namespace}";
resource a = "file://application-test/tmp/a.ts";
resource b = "file://application-test/tmp/b.ts";
meaning relates(left: filesystem, right: filesystem) = "${description}";
link relation = relates(left: a, right: b);
`
const locator = "file://application-test/tmp/a.ts"
const policy = (calls: { value: number }, allowedLocators: readonly string[] = [locator]): UslOperationPolicy => ({
  allowedLocators, maxResources: 2, maxInputBytes: 100_000, maxOutputBytes: 100_000,
  resolvers: { resolve: (item) => { calls.value++; return Effect.succeed({ locator: item, resolvedLocator: formatLocator(item), contentHash: "fixture", resolvedAt: "2026-09-08T00:00:00.000Z", guaranteeLevel: "pure" as const, matchCount: 1 }) } },
})
const reject = async (promise: Promise<unknown>, expression: RegExp) => assert.rejects(promise, expression)

test("application observe defaults to no reads and never lets an input expand its allowlist", async () => {
  const calls = { value: 0 }
  const denied = await executeUslOperation("observe", { source: source() }, policy(calls, [])) as { metrics: { resolverCalls: number } }
  assert.equal(denied.metrics.resolverCalls, 0)
  assert.equal(calls.value, 0)
  await reject(executeUslOperation("observe", { source: source(), options: { allowedLocators: [locator] } }, policy(calls, [])), /expand the server read allowlist/)
})

test("application rejects broad inputs, null options, excess resource limits and mismatched baselines", async () => {
  const calls = { value: 0 }, configured = policy(calls)
  await reject(executeUslOperation("check", { source: source(), surprise: true }, configured), /unknown input field/)
  await reject(executeUslOperation("observe", { source: source(), options: null }, configured), /options must be an object/)
  await reject(executeUslOperation("observe", { source: source(), options: { maxResources: 3 } }, configured), /exceeds server policy/)
  const baseline = await executeUslOperation("observe", { source: source() }, configured)
  await reject(executeUslOperation("observe", { source: source("other_namespace"), baseline }, configured), /baseline namespace differs/)
})

test("compact context stays bounded and registered programs are lookup IDs, not paths", async () => {
  const calls = { value: 0 }, compiled = Either.getOrThrow(compileSource(source("registered")))
  const configured: UslOperationPolicy = { ...policy(calls), getProgram: async (id) => {
    if (id !== "registered") throw new Error(`unknown registered program: ${id}`)
    return { source: source("registered"), plan: compiled }
  } }
  const compact = await executeUslOperation("context", { program: "registered", query: { focus: "a" }, compact: true, maxBytes: 10_000 }, configured) as { context: { namespace: string } }
  assert.equal(compact.context.namespace, "registered")
  await reject(executeUslOperation("context", { program: "registered", query: { focus: "a" }, compact: true, maxBytes: 100_001 }, configured), /maxBytes exceeds/)
  await reject(executeUslOperation("check", { program: "/tmp/registered.usl" }, configured), /unknown registered program/)
})

test("permission-bearing getters and inherited input cannot elevate an observation", async () => {
  const calls = { value: 0 }
  let reads = 0
  const getterPolicy = { maxResources: 2, maxInputBytes: 100_000, maxOutputBytes: 100_000,
    get allowedLocators() { reads++; return reads === 1 ? [] : [locator] },
    resolvers: policy(calls).resolvers! }
  await reject(executeUslOperation("observe", { source: source(), options: { allowedLocators: [locator] } }, getterPolicy), /expand the server read allowlist/)
  assert.equal(reads, 1)
  const inherited = Object.create({ source: source() })
  await reject(executeUslOperation("check", inherited, policy(calls)), /plain JSON|prototype|accessor/)
})

test("nested observe options must be plain JSON data before defaults are applied", async () => {
  const calls = { value: 0 }
  const multiLinkSource = `usl "0.1";
namespace "nested_options";
resource a = "file://application-test/tmp/a.ts";
resource b = "file://application-test/tmp/b.ts";
resource c = "file://application-test/tmp/c.ts";
resource d = "file://application-test/tmp/d.ts";
meaning relates(left: filesystem, right: filesystem) = "declared relation";
link one = relates(left: a, right: b);
link two = relates(left: c, right: d);
`
  const allowed = ["file://application-test/tmp/a.ts", "file://application-test/tmp/b.ts", "file://application-test/tmp/c.ts", "file://application-test/tmp/d.ts"]
  const inheritedOptions = Object.create({ links: ["one"], maxResources: 0 })
  await reject(executeUslOperation("observe", { source: multiLinkSource, options: inheritedOptions }, policy(calls, allowed)), /plain JSON|prototype|accessor/)
  const accessorOptions: Record<string, unknown> = {}
  Object.defineProperty(accessorOptions, "links", { enumerable: true, get: () => ["one"] })
  await reject(executeUslOperation("observe", { source: multiLinkSource, options: accessorOptions }, policy(calls, allowed)), /plain JSON|prototype|accessor/)
  assert.equal(calls.value, 0)
})
