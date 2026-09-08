import { usl } from "../src/language/index.js"

const kg = usl.resource("concept", "kg://canonical-neo4j/sym:Concept:x")
const file = usl.resource("code", "file://dev-01/game.ts")
const meaning = usl.meaning("implements", { roles: { concept: "kg", implementation: "filesystem" }, description: "x" } as const)
usl.link("valid", meaning, { concept: kg, implementation: file })
// @ts-expect-error missing required role
usl.link("missing", meaning, { concept: kg })
// @ts-expect-error resource kind does not satisfy the implementation role
usl.link("wrong", meaning, { concept: kg, implementation: kg })
// @ts-expect-error extra role is rejected
usl.link("extra", meaning, { concept: kg, implementation: file, extra: file })
usl.meaning("bad_check", {
  roles: { concept: "kg", implementation: "filesystem" }, description: "x",
  contract: { scope: "example", checks: [{ name: "check", description: "check",
    // @ts-expect-error check evidence must name a declared role
    evidenceRoles: ["missing_role"],
  }] },
})
