/-
  Spec.Authoring.Door — `Door.admit`, and the two properties its signature is
  supposed to guarantee.

  RFC-002 §4.1:

      The load-bearing structural decision is that `Door.admit` takes
      {parents, ops} and NOT provenance. Provenance lives one level up, in the
      Proposal. So "a chat-authored change and a click-authored change are
      indistinguishable downstream" is enforced by the signature, not by review
      discipline: there is no `admit` overload that can see who wrote it.

  That paragraph was the design's central claim and had never been written down
  anywhere a compiler could read it. `admit` below takes `parent` and `ops`.
  There is no `Provenance` in its type, so `verdict_ignores_provenance` is not so
  much proved as unavoidable — which is the point of putting it in a signature
  rather than in a review checklist.

  ## What this model is, and is not

  It is the DECISION, at the width the decision actually has: well-typedness and
  capability, both decidable from the proposal alone. RFC-002 §7.1 lists what
  else admission involves — "that every named gate returns zero rows after
  application" — and that is a `GROUP BY … HAVING` over the post-admission graph.
  It is not here, it is not in the console, and it is not decidable from a
  proposal: it belongs to the build, on the promotion PR. A model that included
  it would be modelling something no implementation does.

  It is also not the op vocabulary (see `Op.lean`) and not the hash (see
  `Proposal.lean`). What is left is small on purpose. The claims it makes are the
  ones the running system actually rests on:

    * the verdict cannot depend on the surface or the intent;
    * neither can the resulting state;
    * a rejection changes nothing;
    * a capability shortfall QUEUES rather than rejecting — §5's partial
      admission, which is what keeps a mixed proposal from failing whole;
    * nothing out of capability is ever applied.
-/
import Spec.Authoring.Proposal

set_option warningAsError true

namespace Spec.Authoring

/-- `au:Verdict` (rdf/ontology/authoring.ttl). -/
inductive Verdict where
  | Admitted
  | Queued
  | Rejected
  deriving DecidableEq, Repr

/-- What the principal holds. `fun _ => false` is the fail-closed default the
    console uses when `SPEC_KERNEL_SUBS` is empty: an empty allow-list means
    nobody, so `declarePrecedence` queues for an operator. -/
abbrev Capabilities := Capability → Bool

/--
  The door.

  ⛔ The parameters ARE the theorem. `parent` and `ops` — no `Provenance`, and no
  way to add one without changing every callsite, which is the difference between
  a property and a convention. `parent` is unused by the decision and present
  anyway: it is part of what the proposal IS (§5 makes the read point part of the
  id), and a door that dropped it from its signature would be a door that could
  not later check it.
-/
def admit (holds : Capabilities) (_parent : String) (ops : List Op) : Verdict :=
  if ops.any (fun o => !o.wellTyped) then
    Verdict.Rejected
  else if ops.any (fun o => !holds o.capability) then
    Verdict.Queued
  else
    Verdict.Admitted

/-- The proposal's verdict: its ops, judged at its read point. Provenance is
    right there in `p` and cannot reach `admit`. -/
def verdictOf (holds : Capabilities) (p : Proposal) : Verdict :=
  admit holds p.parent p.ops

/-- §9.1 on the decision, as §4.1 promises: one proposal, two provenance
    records, one answer. -/
theorem verdict_ignores_provenance (holds : Capabilities)
    (parent author : String) (ops : List Op) (u v : Provenance) :
    verdictOf holds ⟨parent, author, ops, u⟩ = verdictOf holds ⟨parent, author, ops, v⟩ :=
  rfl

/-- ⛔ Not vacuous: the door DOES see the ops, so a change to them can change the
    answer. Without this, `fun _ _ _ => Admitted` would satisfy everything above. -/
theorem the_verdict_does_depend_on_the_ops :
    ∃ (holds : Capabilities) (parent : String) (a b : List Op),
      admit holds parent a ≠ admit holds parent b := by
  refine ⟨fun _ => true, "p", [], [⟨"assertNS", Capability.Author, false⟩], ?_⟩
  decide

/-- §5: "Partial admission is normal." A capability shortfall QUEUES. Rejecting
    instead would make a proposal mixing author and kernel ops fail whole, and
    the author would have to guess which half was the problem. -/
theorem a_capability_shortfall_queues_rather_than_rejecting
    (holds : Capabilities) (parent : String) (ops : List Op)
    (typed : ops.any (fun o => !o.wellTyped) = false)
    (short : ops.any (fun o => !holds o.capability) = true) :
    admit holds parent ops = Verdict.Queued := by
  simp [admit, typed, short]

/-- Rejection is exactly ill-typedness — capability never causes one. -/
theorem rejected_iff_some_op_is_ill_typed
    (holds : Capabilities) (parent : String) (ops : List Op) :
    admit holds parent ops = Verdict.Rejected ↔ ops.any (fun o => !o.wellTyped) = true := by
  unfold admit
  split
  · simp_all
  · split <;> simp_all

/-- The graph, abstractly: the ops that have been applied, in order. -/
abbrev State := List Op

/-- Applying a proposal's ops holds back the ones out of capability. This is the
    other half of §5's partial admission: the admitted part lands, the queued
    part waits for an operator. -/
def applyOps (holds : Capabilities) (st : State) (ops : List Op) : State :=
  st ++ ops.filter (fun o => holds o.capability)

def apply (holds : Capabilities) (st : State) (p : Proposal) : State :=
  match verdictOf holds p with
  | Verdict.Rejected => st
  | Verdict.Queued => applyOps holds st p.ops
  | Verdict.Admitted => applyOps holds st p.ops

/-- RFC-002 §7.1, "that graph state is untouched on rejection" — one of the
    things the RFC lists under what the door CAN prove, now proved. -/
theorem rejection_leaves_the_state_untouched
    (holds : Capabilities) (st : State) (p : Proposal)
    (h : verdictOf holds p = Verdict.Rejected) : apply holds st p = st := by
  unfold apply
  rw [h]

/-- §9.1 all the way down: not merely the verdict but the resulting STATE cannot
    depend on which surface composed the proposal. -/
theorem application_ignores_provenance (holds : Capabilities) (st : State)
    (parent author : String) (ops : List Op) (u v : Provenance) :
    apply holds st ⟨parent, author, ops, u⟩ = apply holds st ⟨parent, author, ops, v⟩ :=
  rfl

/-- Nothing out of capability is ever applied — including on the Queued path,
    where the proposal IS appended. The queued ops are recorded, not enacted. -/
theorem nothing_out_of_capability_is_applied
    (holds : Capabilities) (st : State) (p : Proposal) (o : Op)
    (h : o ∈ apply holds st p) : o ∈ st ∨ holds o.capability = true := by
  have key : ∀ s : State, o ∈ applyOps holds s p.ops → o ∈ s ∨ holds o.capability = true := by
    intro s hs
    unfold applyOps at hs
    rcases List.mem_append.mp hs with h' | h'
    · exact Or.inl h'
    · exact Or.inr (List.mem_filter.mp h').2
  unfold apply at h
  split at h
  · exact Or.inl h
  · exact key st h
  · exact key st h

/-- Totality: every proposal gets exactly one of the three. There is no fourth
    answer and no "pending" — a door that could decline to decide would move the
    decision somewhere nobody records it. -/
theorem the_verdict_is_one_of_three (holds : Capabilities) (p : Proposal) :
    verdictOf holds p = Verdict.Admitted ∨
    verdictOf holds p = Verdict.Queued ∨
    verdictOf holds p = Verdict.Rejected := by
  cases h : verdictOf holds p
  · exact Or.inl rfl
  · exact Or.inr (Or.inl rfl)
  · exact Or.inr (Or.inr rfl)

end Spec.Authoring
