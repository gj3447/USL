/** Local transport-size measurement; does not invoke a model or claim billed token usage. */
import { readFile } from "node:fs/promises"
import { Either } from "effect"
import { compactAgentContext, compileSource } from "../src/language/index.js"

const source = await readFile(new URL("agent-navigation.usl", import.meta.url), "utf8")
const compile = (text: string) => Either.getOrThrowWith(compileSource(text), (error) => error)
const query = { focus: "concept", target: "checkout" }
const first = Either.getOrThrow(compactAgentContext(compile(source), query))
const repeat = Either.getOrThrow(compactAgentContext(compile(source), query, { knownContextDigest: first.contextDigest }))
const changed = Either.getOrThrow(compactAgentContext(compile(source.replace("구현한다는 선언", "구현하지 않는다는 선언")), query, { knownContextDigest: first.contextDigest }))
console.log(JSON.stringify({
  schema: "usl-context-budget-example/v1",
  fixture: "examples/agent-navigation.usl",
  measurement: "UTF8_JSON_BYTES_NOT_MODEL_TOKENS",
  baseline: "MINIFIED_AGENT_CONTEXT_V1_WITH_NEWLINE",
  first: { mode: first.mode, contextDigest: first.contextDigest, ...first.stats },
  repeat: { mode: repeat.mode, contextDigest: repeat.contextDigest, ...repeat.stats },
  meaningChanged: { mode: changed.mode, contextDigest: changed.contextDigest, ...changed.stats },
}, null, 2))
