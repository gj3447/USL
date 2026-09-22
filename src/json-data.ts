/** Low-level JSON boundary shared by contracts and the application layer. */
export class UslApplicationError extends Error { readonly _tag = "UslApplicationError" }
const fail = (message: string): never => { throw new UslApplicationError(message) }

// This boundary accepts JSON data. Reject options that JSON/structuredClone
// would silently erase (inherited limits, accessors, sparse arrays, undefined).
export const assertJsonData = (value: unknown, ancestors = new Set<object>()): void => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return
  if (typeof value === "number" && Number.isFinite(value)) return
  if (typeof value !== "object" || value === null) fail("input must contain JSON data only")
  const item = value as object
  const prototype = Object.getPrototypeOf(item)
  if (Array.isArray(item) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail("input must use plain JSON objects; inherited options are not supported")
  if (ancestors.has(item)) fail("input must not contain cycles")
  ancestors.add(item)
  const descriptors = Object.getOwnPropertyDescriptors(item)
  if (Array.isArray(item) && Object.keys(descriptors).length !== item.length + 1) fail("input arrays must be dense JSON arrays")
  for (const key of Reflect.ownKeys(descriptors)) {
    if (Array.isArray(item) && key === "length") continue
    if (typeof key !== "string") return fail("input cannot contain symbol keys")
    const descriptor = descriptors[key]!
    if (!descriptor.enumerable || !("value" in descriptor)) fail("input must contain enumerable JSON values, not accessors")
    if (Array.isArray(item) && !/^(0|[1-9][0-9]*)$/.test(key)) fail("input arrays cannot carry extra options")
    assertJsonData(descriptor.value, ancestors)
  }
  ancestors.delete(item)
}
