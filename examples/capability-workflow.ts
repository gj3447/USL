/** Local fixture demonstration: imports a protocol description and executes only host-provided code. */
import { Effect } from "effect"
import { importMcpTools, discoverCapabilities, connectCapability, contractDigest, type CapabilityInvocation, type CapabilityPolicy } from "../src/index.js"

const source = JSON.stringify({ tools: [{ name: "read_sample", description: "Read a locally supplied sample.",
  inputSchema: { type: "object", properties: { seconds: { type: "number", minimum: 0 } }, required: ["seconds"], additionalProperties: false },
  outputSchema: { type: "object", properties: { sample: { type: "number" } }, required: ["sample"], additionalProperties: false },
}] })
const inventory = importMcpTools(source, { connection: "local-demo", complete: true, bindings: {
  read_sample: { meanings: ["urn:example:sample"], effect: "READ", requiredScopes: ["sample:read"], inputTypes: ["urn:example:Duration"], outputTypes: ["urn:example:Sample"], inputUnit: "urn:unit:SECOND" },
} })
const found = discoverCapabilities(inventory.capabilities, { meaning: "urn:example:sample", maxResults: 4, maxInspected: 16 }, inventory.complete)
const descriptor = found.matches[0]!.descriptor, descriptorDigest = contractDigest(descriptor)
const policy: CapabilityPolicy = { connection: "local-demo", capabilityId: descriptor.id, descriptorDigest,
  sourceDigest: inventory.sourceDigest, allowedEffects: ["READ"], allowedScopes: ["sample:read"], allowLossy: false,
  maxInputBytes: 4096, maxOutputBytes: 4096, timeoutMs: 1000 }
let calls = 0
const connection = connectCapability({ descriptor, policy, execute: () => Effect.sync(() => { calls++; return { sample: 42 } }) })
const request: CapabilityInvocation = { descriptorDigest, sourceDigest: inventory.sourceDigest,
  input: { types: ["urn:example:Duration"], unit: "urn:unit:SECOND", value: { seconds: 1 } } }
const accepted = await Effect.runPromise(connection.invoke(request))
const rejected = await Effect.runPromise(connection.invoke({ ...request, input: { ...request.input, unit: "urn:unit:METRE" } }))
console.log(JSON.stringify({ discovered: found.matches.length, accepted: accepted.status, rejected: rejected.status,
  rejectionCodes: rejected.preflight.issues.map(i => i.code), calls, semanticTruth: accepted.semanticTruth }, null, 2))
