import Usl.Core

namespace Usl

/-- Structural fragment of resource-graph validation. Lexical grammar, meaning
declarations, locators, metadata and JSON decoding remain outside this model. -/
def GraphValid (graph : Graph) : Prop :=
  graph.resources ≠ [] ∧ graph.resources.Nodup ∧ (graph.links.map (·.id)).Nodup ∧
  ∀ link ∈ graph.links, link.participants ≠ [] ∧
    (link.participants.map (·.role)).Nodup ∧
    ∀ resource ∈ members link, resource ∈ graph.resources

def validateGraph (graph : Graph) : Bool :=
  decide (graph.resources ≠ []) && decide graph.resources.Nodup && decide (graph.links.map (·.id)).Nodup &&
  graph.links.all (fun link => decide (link.participants ≠ []) &&
    decide (link.participants.map (·.role)).Nodup &&
    (members link).all graph.resources.contains)

theorem validateGraph_correct (graph : Graph) : validateGraph graph = true ↔ GraphValid graph := by
  simp only [validateGraph, GraphValid, Bool.and_eq_true, decide_eq_true_eq,
    List.all_eq_true, List.contains_iff_mem, and_assoc]

theorem validGraph_wellformed {graph : Graph} (valid : GraphValid graph) : WellFormed graph := by
  intro link hl
  exact (valid.2.2.2 link hl).2.2

theorem selection_preserves_validGraph {graph : Graph} (valid : GraphValid graph) (ids : List String) :
    GraphValid (selectLinks graph ids) := by
  refine ⟨valid.1, valid.2.1, ?_, ?_⟩
  · exact List.Nodup.sublist (List.Sublist.map _ List.filter_sublist) valid.2.2.1
  · intro link hl
    exact valid.2.2.2 link (selected_link_original hl)

theorem selection_preserves_validation {graph : Graph} (valid : validateGraph graph = true)
    (ids : List String) : validateGraph (selectLinks graph ids) = true :=
  (validateGraph_correct _).mpr (selection_preserves_validGraph ((validateGraph_correct _).mp valid) ids)

structure RoleRoute where
  meaning : String
  enter : String
  exit : String
  deriving DecidableEq, Repr

/-- Directional traversal retains the original meaning and named participants. -/
def RoutedAdjacent (graph : Graph) (routes : List RoleRoute) (a b : String) : Prop :=
  ∃ link ∈ graph.links, ∃ entry ∈ link.participants, ∃ destination ∈ link.participants,
    entry.resource = a ∧ destination.resource = b ∧ entry.role ≠ destination.role ∧
    ∃ route ∈ routes, route.meaning = link.meaning ∧
      route.enter = entry.role ∧ route.exit = destination.role

def routedStep (graph : Graph) (routes : List RoleRoute) (a b : String) : Bool :=
  graph.links.any fun link => link.participants.any fun entry =>
    link.participants.any fun destination =>
      entry.resource == a && destination.resource == b && entry.role != destination.role &&
      routes.any (fun route => route.meaning == link.meaning &&
        route.enter == entry.role && route.exit == destination.role)

theorem routedStep_correct (graph : Graph) (routes : List RoleRoute) (a b : String) :
    routedStep graph routes a b = true ↔ RoutedAdjacent graph routes a b := by
  simp [routedStep, RoutedAdjacent, Bool.and_eq_true, and_assoc]

theorem routedStep_original {graph : Graph} {routes : List RoleRoute} {a b : String}
    (found : routedStep graph routes a b = true) : Adjacent graph a b := by
  obtain ⟨link, hl, entry, he, destination, hd, ha, hb, _⟩ :=
    (routedStep_correct _ _ _ _).mp found
  exact ⟨link, hl, List.mem_map.mpr ⟨entry, he, ha⟩, List.mem_map.mpr ⟨destination, hd, hb⟩⟩

theorem no_routes_no_step (graph : Graph) (a b : String) : routedStep graph [] a b = false := by
  simp [routedStep]

end Usl
