import Std

namespace Usl

/-- A role-labelled hyperedge. Domain types and addresses remain owner data. -/
structure Participant where
  role : String
  resource : String
  deriving DecidableEq, Repr

structure Link where
  id : String
  meaning : String
  participants : List Participant
  deriving DecidableEq, Repr

structure Graph where
  resources : List String
  links : List Link
  deriving Repr

def members (link : Link) : List String := link.participants.map (·.resource)

def WellFormed (graph : Graph) : Prop :=
  ∀ link ∈ graph.links, ∀ resource ∈ members link, resource ∈ graph.resources

def Adjacent (graph : Graph) (a b : String) : Prop :=
  ∃ link ∈ graph.links, a ∈ members link ∧ b ∈ members link

/-- Traversal is symmetric even when the declared meaning is directional. -/
theorem adjacent_symmetric {graph : Graph} {a b : String}
    (h : Adjacent graph a b) : Adjacent graph b a := by
  obtain ⟨link, hl, ha, hb⟩ := h
  exact ⟨link, hl, hb, ha⟩

inductive Reachable (graph : Graph) : String → String → Prop where
  | refl (a) : Reachable graph a a
  | step : Adjacent graph a b → Reachable graph b c → Reachable graph a c

theorem reachable_transitive {graph : Graph} {a b c : String}
    (hab : Reachable graph a b) (hbc : Reachable graph b c) : Reachable graph a c := by
  induction hab with
  | refl => exact hbc
  | step edge _ ih => exact .step edge (ih hbc)

theorem reachable_symmetric {graph : Graph} {a b : String}
    (h : Reachable graph a b) : Reachable graph b a := by
  induction h with
  | refl => exact .refl _
  | step edge _ ih => exact reachable_transitive ih (.step (adjacent_symmetric edge) (.refl _))

def selectLinks (graph : Graph) (ids : List String) : Graph :=
  { graph with links := graph.links.filter (fun link => link.id ∈ ids) }

/-- Selection retains original hyperedges, including every participant and role. -/
theorem selected_link_original {graph : Graph} {ids : List String} {link : Link}
    (h : link ∈ (selectLinks graph ids).links) : link ∈ graph.links := by
  exact (List.mem_filter.mp h).1

theorem selection_preserves_wellformed {graph : Graph} {ids : List String}
    (h : WellFormed graph) : WellFormed (selectLinks graph ids) := by
  intro link hl resource hr
  exact h link (selected_link_original hl) resource hr

/-- Intersection with independently supplied read scope; the graph cannot widen it. -/
def selectReads (requested allowed : List String) : List String :=
  requested.filter (fun resource => resource ∈ allowed)

theorem selected_read_allowed {requested allowed : List String} {resource : String}
    (h : resource ∈ selectReads requested allowed) : resource ∈ allowed := by
  simpa [selectReads] using (List.mem_filter.mp h).2

theorem deny_all (requested : List String) : selectReads requested [] = [] := by
  simp [selectReads]

theorem narrower_reads {requested allowed narrow : List String}
    (h : ∀ resource ∈ narrow, resource ∈ allowed) {resource : String}
    (hr : resource ∈ selectReads requested narrow) : resource ∈ selectReads requested allowed := by
  apply List.mem_filter.mpr
  exact ⟨(List.mem_filter.mp hr).1, by simpa using h resource (selected_read_allowed hr)⟩

/-- Executable bounded traversal, used in differential tests against the TS runtime. -/
def reachableWithin (graph : Graph) (start target : String) : Nat → Bool
  | 0 => start == target
  | n + 1 => start == target || graph.links.any (fun link =>
      (members link).contains start &&
      (members link).any (fun next => reachableWithin graph next target n))

theorem reachableWithin_reflexive (graph : Graph) (resource : String) (hops : Nat) :
    reachableWithin graph resource resource hops = true := by
  cases hops <;> simp [reachableWithin]

/-- Every positive result of the executable bounded search has a path witness. -/
theorem reachableWithin_sound {graph : Graph} {start target : String} {hops : Nat}
    (h : reachableWithin graph start target hops = true) : Reachable graph start target := by
  induction hops generalizing start with
  | zero =>
    simp only [reachableWithin, beq_iff_eq] at h
    subst start
    exact .refl _
  | succ n ih =>
    simp only [reachableWithin, Bool.or_eq_true, beq_iff_eq, List.any_eq_true,
      Bool.and_eq_true, List.contains_iff_mem] at h
    rcases h with h | ⟨link, hl, ha, next, hn, hr⟩
    · subst start; exact .refl _
    · exact .step ⟨link, hl, ha, hn⟩ (ih hr)

end Usl
