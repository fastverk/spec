/-
  Spec.Authoring.Op — the op and the two things the door is allowed to know
  about it.

  RFC-002 §5's `Op` is a closed 17-constructor vocabulary, and it is NOT
  reproduced here. It already exists twice — `console/lib/proposal.ts::OPS` and
  `services/spec/src/proposal.rs::OPS` — with `conformance/` and
  `check_wiring.py` holding those two together. A third copy in Lean with nothing
  checking it against the other two would be a fourth place to forget, wearing
  the authority of a proof.

  What is modelled instead is exactly what `Door.admit` can SEE about an op:
  whether it is well-typed, and which capability it needs. That is the whole
  input to the decision, and keeping the model at that width is what lets the
  theorems in `Door.lean` say something true about the running system rather
  than about a Lean transcription of it.
-/
set_option warningAsError true

namespace Spec.Authoring

/-- RFC-002 §5: `declarePrecedence` is deliberately the expensive move. -/
inductive Capability where
  | Author
  | Kernel
  deriving DecidableEq, Repr

/-- An op as the door sees it. -/
structure Op where
  /-- The constructor's name, for readability. The door never branches on it. -/
  kind : String
  /-- What the principal must hold. -/
  capability : Capability
  /-- Decided against the closed vocabulary before the door runs. -/
  wellTyped : Bool
  deriving DecidableEq, Repr

/-- `au:Surface` — audit-only provenance (§5). -/
inductive Surface where
  | Meridian
  | Chat
  | Ingest
  | Agent
  deriving DecidableEq, Repr

/--
  Everything about a proposal that is a record of HOW it came to be rather than
  WHAT it says.

  ⛔ This type exists to be excluded. It is a parameter of `Proposal` and appears
  in the signature of nothing else in this namespace — not `preImage`, not
  `admit`, not `apply`. That absence is the model's whole claim.
-/
structure Provenance where
  surface : Surface
  /-- The prose the author typed, and the formalization attempts including the
      rejected ones (§5's `IntentRecord`). Kept forever; never consulted. -/
  intent : Option String
  deriving DecidableEq, Repr

end Spec.Authoring
