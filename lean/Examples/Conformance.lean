import Usl

open Lean Usl

def graph : Graph := {
  resources := ["a", "b", "c", "d", "isolated"]
  links := [
    ⟨"ab", "implements", [⟨"implementation", "a"⟩, ⟨"specification", "b"⟩]⟩,
    ⟨"bcd", "supports", [⟨"subject", "b"⟩, ⟨"proof", "c"⟩, ⟨"evidence", "d"⟩]⟩,
    ⟨"ca", "references", [⟨"source", "c"⟩, ⟨"target", "a"⟩]⟩] }

def forward : RoleRoute := ⟨"implements", "implementation", "specification"⟩
def backward : RoleRoute := ⟨"implements", "specification", "implementation"⟩
def routePolicies : List (List RoleRoute) := [[], [forward], [backward], [forward, backward]]

def runAttempt (events : List AttemptEvent) : Option AttemptState :=
  events.foldl (fun current event => current.bind fun state => transitionAttempt state event) (some initialAttemptState)

def attemptPhase : Option AttemptState → String
  | some ⟨.planned⟩ => "PLANNED"
  | some ⟨.intentDurable⟩ => "INTENT_DURABLE"
  | some ⟨.authorized⟩ => "AUTHORIZED"
  | some ⟨.succeeded⟩ => "SUCCEEDED"
  | some ⟨.indeterminate⟩ => "INDETERMINATE"
  | some ⟨.rejected⟩ => "REJECTED"
  | none => "INVALID"

def bindingCases : List (String × List BindingRepresentation × Option String) := [
  ("explicit-local", [⟨"local", "before/item.txt"⟩, ⟨"github", "https://example.test/item"⟩], some "local"),
  ("explicit-snapshot", [⟨"local", "before/item.txt"⟩, ⟨"github", "https://example.test/item"⟩], some "github"),
  ("explicit-missing", [⟨"local", "before/item.txt"⟩, ⟨"github", "https://example.test/item"⟩], some "archive"),
  ("omitted-ambiguous", [⟨"local", "before/item.txt"⟩, ⟨"github", "https://example.test/item"⟩], none),
  ("omitted-single", [⟨"only", "before/item.txt"⟩], none)]

def attemptJson (events : List AttemptEvent) : Json := Json.mkObj [
  ("trace", toJson <| events.map fun event => match event with
    | .intentSaved => "INTENT_SAVED"
    | .authorizeStart pins => s!"AUTHORIZE_START:{pins}"
    | .rejectBeforeStart => "REJECT_BEFORE_START"
    | .finish started succeeded => s!"FINISH:{started}:{succeeded}"),
  ("phase", toJson (attemptPhase (runAttempt events)))]

def bindingJson : List Json := bindingCases.map fun (name, representations, selected) =>
  let binding : BindingResource := ⟨"node:portable", representations⟩
  Json.mkObj [
    ("name", toJson name), ("representations", toJson <| representations.map (·.id)), ("selected", toJson selected),
    ("found", toJson (selectRepresentation binding selected).isSome),
    ("resource", toJson (rebindAddress binding "local" "after/item.txt").resource),
    ("representationIds", toJson <| representationIds (rebindAddress binding "local" "after/item.txt")),
    ("relocatedFound", toJson (selectRepresentation (rebindAddress binding "local" "after/item.txt") (some "local")).isSome)]

def relocationBefore : BindingResource := ⟨"node:portable", [⟨"local", "before/item.txt"⟩]⟩
def relocationAfter : BindingResource := rebindAddress relocationBefore "local" "after/item.txt"

def bindingStateJson (binding : BindingResource) : Json := Json.mkObj [
  ("resource", toJson binding.resource),
  ("representationIds", toJson (representationIds binding)),
  ("addresses", toJson (binding.representations.map (·.address)))]

def relocationJson : Json := Json.mkObj [
  ("before", bindingStateJson relocationBefore),
  ("after", bindingStateJson relocationAfter)]

def phaseName : AttemptPhase → String
  | .planned => "PLANNED"
  | .intentDurable => "INTENT_DURABLE"
  | .authorized => "AUTHORIZED"
  | .succeeded => "SUCCEEDED"
  | .indeterminate => "INDETERMINATE"
  | .rejected => "REJECTED"

def eventName : AttemptEvent → String
  | .intentSaved => "INTENT_SAVED"
  | .authorizeStart pins => s!"AUTHORIZE_START:{pins}"
  | .rejectBeforeStart => "REJECT_BEFORE_START"
  | .finish started succeeded => s!"FINISH:{started}:{succeeded}"

def attemptPhases : List AttemptPhase := [.planned, .intentDurable, .authorized, .succeeded, .indeterminate, .rejected]
def attemptEvents : List AttemptEvent := [.intentSaved, .authorizeStart false, .authorizeStart true, .rejectBeforeStart,
  .finish false false, .finish false true, .finish true false, .finish true true]

def attemptMatrixJson : List Json := attemptPhases.flatMap fun phase => attemptEvents.map fun event =>
  Json.mkObj [("phase", toJson (phaseName phase)), ("event", toJson (eventName event)),
    ("result", toJson (attemptPhase (transitionAttempt ⟨phase⟩ event)))]

-- Checked boundary examples: hop exhaustion is not global non-reachability;
-- directed role traversal is not symmetric; reachability grants no read permission.
example : reachableWithin graph "a" "d" 1 = false ∧ reachableWithin graph "a" "d" 2 = true := by decide
example : routedStep graph [forward] "a" "b" = true ∧ routedStep graph [forward] "b" "a" = false := by decide
example : admitReads ["d"] [] 1 = some [] := by decide

def validationCases : List (String × Graph) := [
  ("valid", graph),
  ("empty_resources", ⟨[], []⟩),
  ("duplicate_resource", {graph with resources := graph.resources ++ ["a"]}),
  ("duplicate_link", {graph with links := graph.links ++ graph.links.take 1}),
  ("empty_participants", {graph with links := [⟨"bad", "implements", []⟩]}),
  ("duplicate_role", {graph with links := [⟨"bad", "implements", [⟨"same", "a"⟩, ⟨"same", "b"⟩]⟩]}),
  ("dangling_resource", {graph with links := [⟨"bad", "implements", [⟨"subject", "missing"⟩]⟩]}),
  ("selected", selectLinks graph ["bcd", "ca"]),
  ("unary", {graph with links := [⟨"one", "implements", [⟨"subject", "a"⟩]⟩]}),
  ("same_resource_distinct_roles", {graph with links := [⟨"one", "implements", [⟨"source", "a"⟩, ⟨"target", "a"⟩]⟩]}),
  ("no_links", {graph with links := []})]

def graphJson (g : Graph) : Json := Json.mkObj [
  ("schema", toJson "usl-resource-graph/v1"),
  ("resources", toJson <| g.resources.map fun id => Json.mkObj [
    ("id", toJson id), ("types", toJson ["urn:test:Resource"]), ("locator", toJson s!"file://fixture/{id}")]),
  ("meanings", toJson <| (g.links.map (·.meaning)).eraseDups.map fun id =>
    Json.mkObj [("id", toJson id), ("description", toJson id)]),
  ("links", toJson <| g.links.map fun link => Json.mkObj [
    ("id", toJson link.id), ("meaning", toJson link.meaning),
    ("participants", toJson <| link.participants.map fun p =>
      Json.mkObj [("role", toJson p.role), ("resource", toJson p.resource)])])]

#eval IO.println <| (Json.mkObj [
  ("paths", toJson <| graph.resources.flatMap fun start => graph.resources.flatMap fun target =>
    (List.range 4).map fun hops => Json.mkObj [
      ("start", toJson start), ("target", toJson target), ("hops", toJson hops),
      ("found", toJson (reachableWithin graph start target hops))]),
  ("reads", toJson (selectReads graph.resources ["a", "c"])),
  ("budgets", toJson <| (List.range 32).flatMap fun mask =>
    let allowed := graph.resources.zipIdx.filterMap fun (id, index) =>
      if (mask / 2 ^ index) % 2 == 1 then some id else none
    (List.range 6).map fun budget => Json.mkObj [
      ("allowed", toJson allowed), ("budget", toJson budget),
      ("output", toJson (admitReads graph.resources allowed budget))]),
  ("routes", toJson <| routePolicies.flatMap fun policy =>
    graph.resources.flatMap fun start => graph.resources.filterMap fun target =>
      if start == target then none else some <| Json.mkObj [
        ("start", toJson start), ("target", toJson target),
        ("policy", toJson <| policy.map fun route => Json.mkObj [
          ("meaning", toJson route.meaning), ("enter", toJson route.enter), ("exit", toJson route.exit)]),
        ("found", toJson (routedStep graph policy start target))]),
  ("validation", toJson <| validationCases.map fun (name, fixture) => Json.mkObj [
    ("name", toJson name), ("graph", graphJson fixture), ("valid", toJson (validateGraph fixture))]),
  ("attempts", toJson [
    attemptJson [], attemptJson [.intentSaved], attemptJson [.intentSaved, .authorizeStart true],
    attemptJson [.intentSaved, .rejectBeforeStart], attemptJson [.intentSaved, .authorizeStart true, .finish false true],
    attemptJson [.intentSaved, .authorizeStart true, .finish true true], attemptJson [.intentSaved, .authorizeStart true, .finish true false]]),
  ("attemptMatrix", toJson attemptMatrixJson),
  ("bindings", toJson bindingJson),
  ("relocation", relocationJson)]).compress
