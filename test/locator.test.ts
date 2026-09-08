import { test } from "node:test"
import assert from "node:assert/strict"
import { Either } from "effect"
import { formatLocator, parseLocator } from "../src/locator.js"

const roundTrip = (s: string) => {
  const p = parseLocator(s)
  assert.ok(Either.isRight(p), `parse failed: ${s}`)
  const back = formatLocator(Either.getOrThrow(p))
  assert.equal(back, s)
  return Either.getOrThrow(p)
}
test("kg locator round-trips", () => { const l = roundTrip("kg://canonical-neo4j/sym:Concept:usl"); assert.equal(l.kind, "kg") })
test("url locator round-trips", () => { const l = roundTrip("https://www.rfc-editor.org/rfc/rfc3986#section-3"); assert.equal(l.kind, "url") })
test("git locator round-trips with symbol and lines", () => {
  const l = roundTrip("git://github.com/gj3447/symposium@78d4234e87383e2d5e95ccf4b78ea0254943a0c9:THEORY/LONGINUS/SOURCES.md::section8@L219-L234")
  assert.equal(l.kind, "git_repo"); if (l.kind === "git_repo") { assert.equal(l.symbol, "section8"); assert.equal(l.lineStart, 219) }
})
test("git locator without symbol/lines", () => { const l = roundTrip("git://github.com/gj3447/HSWM@88bba3bc:README.md"); assert.equal(l.kind, "git_repo") })
test("file locator requires host and absolute path", () => {
  roundTrip("file://dev-01/home/lagyeongjun/CD/SYMPOSIUM/kg/README.md#L5-L8")
  assert.ok(Either.isLeft(parseLocator("file:///home/x")))          // missing host
  assert.ok(Either.isLeft(parseLocator("file://dev-01//home/x")))   // double slash (bug the doc lens caught)
})
test("unknown scheme fails closed", () => { assert.ok(Either.isLeft(parseLocator("ftp://x/y"))) })

test("line ranges reject zero, reversed and unsafe integers", () => {
  for (const range of ["L0-L1", "L3-L2", "L1-L9007199254740992"]) {
    assert.ok(Either.isLeft(parseLocator(`file://dev-01/x#${range}`)))
    assert.ok(Either.isLeft(parseLocator(`git://fixture/repo@abcdef12:x@${range}`)))
  }
  for (const p of ["../x", "/x", "a/./b", "a//b"]) assert.ok(Either.isLeft(parseLocator(`git://fixture/repo@abcdef12:${p}`)))
})
