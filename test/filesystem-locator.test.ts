import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, realpath, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { Effect, Either, Layer } from "effect"
import { filesystemLocatorPath, nativeFilesystemPath, parseLocator } from "../src/locator.js"
import { Config, ResolversLive, Resolvers, sha256, type ResolverConfig } from "../src/resolve.js"
import { temporary } from "./fixtures.js"

// The pure mapping takes the path flavor explicitly, so Windows semantics are
// exercised on every host; the resolver tests below run against the real host.
const win32 = path.win32, posix = path.posix

test("Windows drive locator paths read back as native drive paths (RFC 8089 drive-letter form)", () => {
  for (const native of ["D:\\a\\USL\\restored-pt04\\notes\\a.md", "C:\\", "c:\\Users\\runner\\with space\\x.txt", "Z:\\100%25\\%41"]) {
    const locatorPath = filesystemLocatorPath(native, win32)
    assert.match(locatorPath, /^\/[A-Za-z]:\//)
    assert.equal(nativeFilesystemPath(locatorPath, win32), native, native)
  }
  assert.equal(nativeFilesystemPath("/D:/a/b.txt", win32), "D:\\a\\b.txt")
  // No percent-decoding: the grammar carries path characters literally on every platform.
  assert.equal(nativeFilesystemPath("/D:/100%25", win32), "D:\\100%25")
  assert.equal(nativeFilesystemPath("/srv/100%25", posix), "/srv/100%25")
  const parsed = parseLocator(`file://test-host${filesystemLocatorPath("D:\\a\\b.txt", win32)}#L1-L2`)
  assert.ok(Either.isRight(parsed) && parsed.right.kind === "filesystem" && parsed.right.path === "/D:/a/b.txt" && parsed.right.lineStart === 1)
})

test("Windows locator paths without a drive, UNC, device, backslash or stream forms are refused, not guessed", () => {
  for (const locatorPath of ["/a/b", "/", "/D:", "/D:a\\b", "/D:relative", "//server/share/a", "/D:/a\\..\\..\\x", "/\\\\?\\D:\\a", "/D:/a/file.txt:stream", "/D:/a/CON:"]) {
    assert.equal(nativeFilesystemPath(locatorPath, win32), undefined, locatorPath)
  }
  // The writer leaves every form the reader cannot read back unchanged, so the locator grammar rejects it.
  for (const native of ["\\\\server\\share\\a.md", "\\\\?\\D:\\a.md", "\\\\.\\PhysicalDrive0", "D:relative", "D:\\a\\file.txt:stream", "D:\\a/b"]) {
    assert.equal(filesystemLocatorPath(native, win32), native, native)
    assert.ok(Either.isLeft(parseLocator(`file://test-host${filesystemLocatorPath(native, win32)}`)), native)
  }
})

test("POSIX locator paths are native paths unchanged in both directions", () => {
  for (const native of ["/srv/repo/a.md", "/D:/looks/like/a/drive", "/a\\b", "/x:y"]) {
    assert.equal(filesystemLocatorPath(native, posix), native)
    assert.equal(nativeFilesystemPath(native, posix), native)
  }
  assert.equal(filesystemLocatorPath("C:\\not\\converted\\on\\posix", posix), "C:\\not\\converted\\on\\posix")
})

const resolveOn = (cfg: ResolverConfig, locator: string) => {
  const parsed = parseLocator(locator)
  assert.ok(Either.isRight(parsed), locator)
  return Effect.runPromise(Effect.either(Effect.flatMap(Resolvers, r => r.resolve(parsed.right)).pipe(
    Effect.provide(ResolversLive.pipe(Layer.provide(Layer.succeed(Config, cfg)))))))
}

test("resolveFs reads a host file through its locator path and reports the same locator form", async (t) => {
  const dir = await realpath(await temporary(t)), nested = path.join(dir, "nested")
  await mkdir(nested)
  const file = path.join(nested, "note.txt")
  await writeFile(file, "one\ntwo\nthree\n")
  const cfg: ResolverConfig = { hostname: "test-host", gitRepos: {}, kgMcpUrl: "http://kg.invalid/mcp", fetchImpl: fetch }
  const locator = `file://test-host${filesystemLocatorPath(file)}`
  if (path.sep === "\\") assert.match(locator, /^file:\/\/test-host\/[A-Za-z]:\//)

  const whole = await resolveOn(cfg, locator)
  assert.ok(Either.isRight(whole), Either.isLeft(whole) ? whole.left.message : "")
  assert.equal(whole.right.resolvedLocator, locator)
  assert.equal(whole.right.contentHash, sha256(Buffer.from("one\ntwo\nthree\n")))

  const lines = await resolveOn(cfg, `${locator}#L2-L3`)
  assert.ok(Either.isRight(lines) && lines.right.contentHash === sha256("two\nthree") && lines.right.resolvedLocator === `${locator}#L2-L3`)

  const directory = await resolveOn(cfg, `file://test-host${filesystemLocatorPath(nested)}`)
  assert.ok(Either.isRight(directory) && directory.right.resolvedLocator === `file://test-host${filesystemLocatorPath(nested)}`)

  // An allow-list names the canonical locator form, never the native spelling.
  const allowed = await resolveOn({ ...cfg, allowedLocators: [locator] }, locator)
  assert.ok(Either.isRight(allowed))
})

test("resolveFs refuses locator paths the host cannot read without guessing", async () => {
  const cfg: ResolverConfig = { hostname: "test-host", gitRepos: {}, kgMcpUrl: "http://kg.invalid/mcp", fetchImpl: fetch }
  if (path.sep === "\\") {
    // Rooted without a drive is drive-relative on Windows: refused before touching the filesystem.
    const rooted = await resolveOn(cfg, "file://test-host/Windows/win.ini")
    assert.ok(Either.isLeft(rooted) && rooted.left.reason === "AMBIGUOUS", "rooted path without a drive")
  } else {
    // On POSIX a drive-looking locator path is an ordinary absolute path.
    const missing = await resolveOn(cfg, "file://test-host/D:/usl-no-such-dir/a.txt")
    assert.ok(Either.isLeft(missing) && missing.left.reason === "ORPHAN")
  }
  const remote = await resolveOn(cfg, "file://other-host/D:/a.txt")
  assert.ok(Either.isLeft(remote) && remote.left.reason === "IO")
})
