import Usl.Core

namespace Usl

/-- A path of at most `hops` steps. Reflexivity may leave any budget unused. -/
inductive PathWithin (graph : Graph) : Nat → String → String → Prop where
  | here (hops resource) : PathWithin graph hops resource resource
  | step : Adjacent graph a b → PathWithin graph hops b c → PathWithin graph (hops + 1) a c

/-- Exact specification of the executable search, for every graph and hop budget. -/
theorem reachableWithin_correct {graph : Graph} {start target : String} {hops : Nat} :
    reachableWithin graph start target hops = true ↔ PathWithin graph hops start target := by
  induction hops generalizing start with
  | zero =>
    constructor
    · intro h
      simp only [reachableWithin, beq_iff_eq] at h
      subst start
      exact .here 0 _
    · intro h
      cases h
      exact reachableWithin_reflexive _ _ _
  | succ n ih =>
    constructor
    · intro h
      simp only [reachableWithin, Bool.or_eq_true, beq_iff_eq, List.any_eq_true,
        Bool.and_eq_true, List.contains_iff_mem] at h
      rcases h with h | ⟨link, hl, ha, next, hn, hr⟩
      · subst start; exact .here _ _
      · exact .step ⟨link, hl, ha, hn⟩ (ih.mp hr)
    · intro h
      cases h with
      | here => exact reachableWithin_reflexive _ _ _
      | step edge tail =>
        obtain ⟨link, hl, ha, hb⟩ := edge
        simp only [reachableWithin, Bool.or_eq_true, beq_iff_eq, List.any_eq_true,
          Bool.and_eq_true, List.contains_iff_mem]
        exact Or.inr ⟨link, hl, ha, _, hb, ih.mpr tail⟩

theorem PathWithin.mono {graph : Graph} {a b : String} {n m : Nat}
    (path : PathWithin graph n a b) (budget : n ≤ m) : PathWithin graph m a b := by
  induction path generalizing m with
  | here => exact .here _ _
  | step edge _ ih =>
    cases m with
    | zero => omega
    | succ m => exact .step edge (ih (by omega))

theorem PathWithin.trans {graph : Graph} {a b c : String} {n m : Nat}
    (first : PathWithin graph n a b) (second : PathWithin graph m b c) :
    PathWithin graph (n + m) a c := by
  induction first with
  | here => exact second.mono (by omega)
  | step edge _ ih =>
    simpa [Nat.add_assoc, Nat.add_comm, Nat.add_left_comm] using PathWithin.step edge (ih second)

theorem PathWithin.symm {graph : Graph} {a b : String} {n : Nat}
    (path : PathWithin graph n a b) : PathWithin graph n b a := by
  induction path with
  | here => exact .here _ _
  | step edge _ ih => exact ih.trans (.step (adjacent_symmetric edge) (.here 0 _))

theorem reachableWithin_monotone {graph : Graph} {a b : String} {n m : Nat}
    (budget : n ≤ m) (found : reachableWithin graph a b n = true) :
    reachableWithin graph a b m = true :=
  reachableWithin_correct.mpr ((reachableWithin_correct.mp found).mono budget)

theorem reachableWithin_symmetric {graph : Graph} {a b : String} {n : Nat}
    (found : reachableWithin graph a b n = true) : reachableWithin graph b a n = true :=
  reachableWithin_correct.mpr (reachableWithin_correct.mp found).symm

theorem reachableWithin_composition {graph : Graph} {a b c : String} {n m : Nat}
    (first : reachableWithin graph a b n = true) (second : reachableWithin graph b c m = true) :
    reachableWithin graph a c (n + m) = true :=
  reachableWithin_correct.mpr ((reachableWithin_correct.mp first).trans (reachableWithin_correct.mp second))

/-- Every finite path is found with a sufficiently large hop budget. -/
theorem reachableWithin_complete {graph : Graph} {a b : String}
    (path : Reachable graph a b) : ∃ hops, reachableWithin graph a b hops = true := by
  induction path with
  | refl => exact ⟨0, reachableWithin_reflexive _ _ _⟩
  | step edge _ ih =>
    obtain ⟨hops, found⟩ := ih
    exact ⟨hops + 1, reachableWithin_correct.mpr (.step edge (reachableWithin_correct.mp found))⟩

theorem reachable_iff_exists_budget {graph : Graph} {a b : String} :
    Reachable graph a b ↔ ∃ hops, reachableWithin graph a b hops = true := by
  constructor
  · exact reachableWithin_complete
  · rintro ⟨_, found⟩; exact reachableWithin_sound found

/-- A false bounded result excludes bounded paths, not paths at larger budgets. -/
theorem reachableWithin_false_iff {graph : Graph} {a b : String} {hops : Nat} :
    reachableWithin graph a b hops = false ↔ ¬ PathWithin graph hops a b := by
  rw [← reachableWithin_correct]
  cases reachableWithin graph a b hops <;> simp

theorem reachableWithin_stays_in_graph {graph : Graph} {a b : String} {hops : Nat}
    (valid : WellFormed graph) (start : a ∈ graph.resources)
    (found : reachableWithin graph a b hops = true) : b ∈ graph.resources := by
  have path := reachableWithin_correct.mp found
  clear found
  induction path with
  | here => exact start
  | step edge _ ih =>
    obtain ⟨link, hl, _, hb⟩ := edge
    exact ih (valid link hl _ hb)

theorem selected_link_iff {graph : Graph} {ids : List String} {link : Link} :
    link ∈ (selectLinks graph ids).links ↔ link ∈ graph.links ∧ link.id ∈ ids := by
  simp [selectLinks]

theorem selectLinks_idempotent (graph : Graph) (ids : List String) :
    selectLinks (selectLinks graph ids) ids = selectLinks graph ids := by
  cases graph
  simp [selectLinks, List.filter_filter]

theorem selectLinks_commute (graph : Graph) (first second : List String) :
    selectLinks (selectLinks graph first) second = selectLinks (selectLinks graph second) first := by
  cases graph
  simp [selectLinks, List.filter_filter, Bool.and_comm]

theorem selectReads_exact {requested allowed : List String} {resource : String} :
    resource ∈ selectReads requested allowed ↔ resource ∈ requested ∧ resource ∈ allowed := by
  simp [selectReads]

theorem selectReads_idempotent (requested allowed : List String) :
    selectReads (selectReads requested allowed) allowed = selectReads requested allowed := by
  simp [selectReads, List.filter_filter]

theorem selectReads_commute (requested first second : List String) :
    selectReads (selectReads requested first) second = selectReads (selectReads requested second) first := by
  simp [selectReads, List.filter_filter, Bool.and_comm]

/-- Model normalized locator keys. Like observeProgram, check the unique request
budget before intersecting permissions; excessive requests fail, not truncate. -/
def admitReads (requested allowed : List String) (budget : Nat) : Option (List String) :=
  let targets := requested.eraseDups
  if targets.length ≤ budget then some (selectReads targets allowed) else none

theorem admitted_read_exact {requested allowed output : List String} {budget : Nat}
    (admitted : admitReads requested allowed budget = some output) {resource : String} :
    resource ∈ output ↔ resource ∈ requested ∧ resource ∈ allowed := by
  dsimp only [admitReads] at admitted
  split at admitted
  · cases admitted
    simp [selectReads]
  · cases admitted

theorem admitted_reads_budget {requested allowed output : List String} {budget : Nat}
    (admitted : admitReads requested allowed budget = some output) : output.length ≤ budget := by
  dsimp only [admitReads] at admitted
  split at admitted
  · cases admitted
    exact Nat.le_trans (List.length_filter_le _ _) ‹_ ≤ budget›
  · cases admitted

theorem oversized_reads_rejected (requested allowed : List String) (budget : Nat)
    (oversized : budget < requested.eraseDups.length) : admitReads requested allowed budget = none := by
  simp [admitReads, Nat.not_le.mpr oversized]

end Usl
