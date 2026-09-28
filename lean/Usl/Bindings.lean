import Std

namespace Usl

/-- Pure portable binding model. `id` is stable while `address` is an
environmental representation such as a relative workspace path or locator.
Realpaths, containment, Git and network resolution are outside this model. -/
structure BindingRepresentation where
  id : String
  address : String
  deriving DecidableEq, Repr

structure BindingResource where
  resource : String
  representations : List BindingRepresentation
  deriving DecidableEq, Repr

def representationIds (binding : BindingResource) : List String := binding.representations.map (·.id)
def BindingWellFormed (binding : BindingResource) : Prop := (representationIds binding).Nodup

def matchingRepresentations (binding : BindingResource) (id : String) : List BindingRepresentation :=
  binding.representations.filter fun representation => representation.id = id

/-- An omitted representation is admitted only for one available choice;
an explicit id is admitted only when it identifies exactly one representation. -/
def selectRepresentation (binding : BindingResource) : Option String → Option BindingRepresentation
  | none => match binding.representations with | [representation] => some representation | _ => none
  | some id => match matchingRepresentations binding id with | [representation] => some representation | _ => none

/-- A relocation changes only the environmental address, never either stable id. -/
def rebindAddress (binding : BindingResource) (id newAddress : String) : BindingResource :=
  { binding with representations := binding.representations.map fun representation =>
      if representation.id = id then { representation with address := newAddress } else representation }

theorem explicit_selection_requires_exactly_one (binding : BindingResource) (id : String) (representation : BindingRepresentation) :
    selectRepresentation binding (some id) = some representation ↔ matchingRepresentations binding id = [representation] := by
  simp only [selectRepresentation]
  split <;> simp_all

theorem omitted_selection_requires_exactly_one (binding : BindingResource) (representation : BindingRepresentation) :
    selectRepresentation binding none = some representation ↔ binding.representations = [representation] := by
  simp only [selectRepresentation]
  split <;> simp_all

theorem rebind_preserves_resource_id (binding : BindingResource) (id newAddress : String) :
    (rebindAddress binding id newAddress).resource = binding.resource := rfl

theorem rebind_preserves_representation_ids (binding : BindingResource) (id newAddress : String) :
    representationIds (rebindAddress binding id newAddress) = representationIds binding := by
  simp only [representationIds, rebindAddress, List.map_map]
  apply List.map_congr_left
  intro representation _
  simp only [Function.comp_apply]
  split <;> rfl

theorem rebind_preserves_wellformedness (binding : BindingResource) (id newAddress : String)
    (wellFormed : BindingWellFormed binding) : BindingWellFormed (rebindAddress binding id newAddress) := by
  simpa [BindingWellFormed, rebind_preserves_representation_ids] using wellFormed

theorem rebind_selected_locator_replaced (binding : BindingResource) (id oldAddress newAddress : String)
    (present : ⟨id, oldAddress⟩ ∈ binding.representations) :
    ⟨id, newAddress⟩ ∈ (rebindAddress binding id newAddress).representations := by
  apply List.mem_map.mpr
  exact ⟨⟨id, oldAddress⟩, present, by simp⟩

end Usl
