import Lean

open Lean Elab Command

namespace Usl

private def declarationKind : ConstantInfo → String
  | .axiomInfo _ => "axiom"
  | .defnInfo _ => "definition"
  | .thmInfo _ => "theorem"
  | .opaqueInfo _ => "opaque"
  | .quotInfo _ => "quotient"
  | .inductInfo _ => "inductive"
  | .ctorInfo _ => "constructor"
  | .recInfo _ => "recursor"

/-- Export selected elaborated declarations. This is a report of the current
environment, not a proof that a linked external resource satisfies its meaning. -/
elab "#usl_export" "[" ids:ident,* "]" : command => do
  let mut declarations : Array Json := #[]
  for id in ids.getElems do
    let name ← liftCoreM <| resolveGlobalConstNoOverload id
    let info ← getConstInfo name
    let type ← liftTermElabM <| Meta.ppExpr info.type
    let axioms ← collectAxioms name
    declarations := declarations.push <| Json.mkObj [
      ("name", toJson name.toString),
      ("kind", toJson (declarationKind info)),
      ("type", toJson type.pretty),
      ("axioms", toJson ((axioms.qsort Name.lt).map Name.toString)),
      ("unsafe", toJson info.isUnsafe),
      ("partial", toJson info.isPartial)]
  logInfo <| "USL_LEAN4:" ++ (Json.mkObj [
    ("schema", toJson "usl-lean4-export/v1"),
    ("leanVersion", toJson Lean.versionString),
    ("declarations", Json.arr declarations)]).compress

end Usl
