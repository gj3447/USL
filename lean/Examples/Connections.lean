import Usl

namespace Demo

def canDash (grounded : Bool) : Bool := grounded

theorem dash_requires_ground (grounded : Bool) : canDash grounded = true → grounded = true := by
  intro h
  exact h

end Demo

#usl_export [Demo.canDash, Demo.dash_requires_ground,
  Usl.adjacent_symmetric, Usl.reachable_transitive, Usl.reachable_symmetric,
  Usl.selected_link_original, Usl.selection_preserves_wellformed,
  Usl.selected_read_allowed, Usl.deny_all, Usl.narrower_reads,
  Usl.reachableWithin_reflexive, Usl.reachableWithin_sound]
