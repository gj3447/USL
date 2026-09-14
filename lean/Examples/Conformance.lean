import Usl

open Lean Usl

def graph : Graph := {
  resources := ["a", "b", "c", "d", "isolated"]
  links := [
    ⟨"ab", "implements", [⟨"implementation", "a"⟩, ⟨"specification", "b"⟩]⟩,
    ⟨"bcd", "supports", [⟨"subject", "b"⟩, ⟨"proof", "c"⟩, ⟨"evidence", "d"⟩]⟩,
    ⟨"ca", "references", [⟨"source", "c"⟩, ⟨"target", "a"⟩]⟩] }

#eval IO.println <| (Json.mkObj [
  ("paths", toJson <| graph.resources.flatMap fun start => graph.resources.flatMap fun target =>
    (List.range 4).map fun hops => Json.mkObj [
      ("start", toJson start), ("target", toJson target), ("hops", toJson hops),
      ("found", toJson (reachableWithin graph start target hops))]),
  ("reads", toJson (selectReads graph.resources ["a", "c"]))]).compress
