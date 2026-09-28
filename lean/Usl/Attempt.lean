import Std

namespace Usl

/-- A pure contract for one durable host attempt, independent of OS process semantics. -/
inductive AttemptPhase where
  | planned | intentDurable | authorized | succeeded | indeterminate | rejected
  deriving DecidableEq, Repr

structure AttemptState where
  phase : AttemptPhase
  deriving DecidableEq, Repr

inductive AttemptEvent where
  | intentSaved
  | authorizeStart (pinsMatch : Bool)
  | rejectBeforeStart
  | finish (started succeeded : Bool)
  deriving DecidableEq, Repr

def initialAttemptState : AttemptState := ⟨.planned⟩

/-- `some authorized` permits dispatch; it does not claim that a process started. -/
def transitionAttempt (state : AttemptState) : AttemptEvent → Option AttemptState
  | .intentSaved => if state.phase == .planned then some ⟨.intentDurable⟩ else none
  | .authorizeStart pinsMatch =>
    if state.phase == .intentDurable && pinsMatch then some ⟨.authorized⟩ else none
  | .rejectBeforeStart => if state.phase == .intentDurable then some ⟨.rejected⟩ else none
  | .finish started succeeded =>
    if state.phase != .authorized then none
    else if !started then some ⟨.rejected⟩
    else if succeeded then some ⟨.succeeded⟩ else some ⟨.indeterminate⟩

theorem initial_attempt_planned : initialAttemptState.phase = .planned := rfl

theorem intent_first_authorize_rejected :
    transitionAttempt initialAttemptState (.authorizeStart true) = none := by decide

theorem intent_saved_becomes_durable :
    transitionAttempt initialAttemptState .intentSaved = some ⟨.intentDurable⟩ := by decide

theorem pin_mismatch_authorize_rejected :
    transitionAttempt ⟨.intentDurable⟩ (.authorizeStart false) = none := by decide

/-- Dispatch authorization is possible precisely after durable intent and a
matching pin.  This is a pure host contract, not a claim about a process. -/
theorem authorize_requires_durable_intent_and_matching_pins (phase : AttemptPhase) (pinsMatch : Bool) :
    transitionAttempt ⟨phase⟩ (.authorizeStart pinsMatch) = some ⟨.authorized⟩ ↔
      phase = .intentDurable ∧ pinsMatch = true := by
  cases phase <;> cases pinsMatch <;> decide

theorem authorize_once :
    transitionAttempt ⟨.authorized⟩ (.authorizeStart true) = none := by decide

theorem finish_requires_authorized :
    transitionAttempt ⟨.intentDurable⟩ (.finish true true) = none := by decide

theorem finish_without_start_rejected :
    transitionAttempt ⟨.authorized⟩ (.finish false true) = some ⟨.rejected⟩ := by decide

theorem finish_started_outcomes :
    transitionAttempt ⟨.authorized⟩ (.finish true true) = some ⟨.succeeded⟩ ∧
    transitionAttempt ⟨.authorized⟩ (.finish true false) = some ⟨.indeterminate⟩ := by decide

/-- A finished attempt has no successful follow-up transition, so the pure
contract never authorizes an automatic retry from its terminal receipt state. -/
theorem finished_attempt_cannot_retry (succeeded : Bool) (event : AttemptEvent) :
    transitionAttempt (if succeeded then ⟨.succeeded⟩ else ⟨.indeterminate⟩) event = none := by
  cases succeeded <;> cases event <;> simp [transitionAttempt]

theorem terminal_immutable (phase : AttemptPhase) (terminal : phase = .succeeded ∨ phase = .indeterminate ∨ phase = .rejected)
    (event : AttemptEvent) : transitionAttempt ⟨phase⟩ event = none := by
  rcases terminal with h | h | h <;> subst phase <;> cases event <;> simp [transitionAttempt]

end Usl
