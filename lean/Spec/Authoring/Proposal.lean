/-
  Spec.Authoring.Proposal — the proposal, and the pre-image of its name.

  RFC-002 §5:

      Proposal
        id          : Hash          -- content address over (parent, author, ops)
        parent      : Hash          -- the bitemporal read point the author saw
        author      : Principal
        surface     : au:Surface    -- audit only
        ops         : [Op]          -- ordered, individually reviewable
        intent      : IntentRecord
        verdict     : au:Verdict

  `id` is not a field here. A content address is a function of the other fields,
  and a structure that carries both invites a value where they disagree — which
  is exactly the failure `tools/proposals/replay.py` refuses at runtime ("a
  record that lies about its own name"). Here it simply has no representation.

  The hash itself is not modelled either. What is modelled is its PRE-IMAGE: the
  three fields it is taken over. Every claim anyone makes about the address —
  §9.1's equal-citizen gate above all — is a claim about which fields go in, and
  that is decidable here without believing anything about SHA-256.
-/
import Spec.Authoring.Op

set_option warningAsError true

namespace Spec.Authoring

structure Proposal where
  parent : String
  author : String
  /-- ⛔ ORDERED. §5 property 2: review is at op granularity, in sequence. A set
      would let two different reviews collapse into one name. -/
  ops : List Op
  provenance : Provenance
  deriving DecidableEq, Repr

/--
  What the content address is taken over.

  ⛔ THREE FIELDS. `Provenance` is absent, and that is §9.1: a scripted click and
  a scripted chat that author the same change must produce the same id.

  ⛔ `author` is PRESENT, and that is not a contradiction. Invariant ⑤ — nothing
  is attributed to nobody. Two people proposing the same words are making two
  proposals, each of which one of them is answerable for. The surface collapses;
  the person never does.
-/
structure PreImage where
  author : String
  ops : List Op
  parent : String
  deriving DecidableEq, Repr

def preImage (p : Proposal) : PreImage :=
  ⟨p.author, p.ops, p.parent⟩

/-- §9.1, on the name. Two proposals that differ only in how they were composed
    have the same pre-image, hence the same address under any hash at all. -/
theorem preImage_ignores_provenance
    (parent author : String) (ops : List Op) (u v : Provenance) :
    preImage ⟨parent, author, ops, u⟩ = preImage ⟨parent, author, ops, v⟩ :=
  rfl

/-- …and the converse half, which is what stops the theorem above from being
    satisfied by a constant: everything the pre-image DOES see, it sees. -/
theorem preImage_determines_its_three_fields (p q : Proposal)
    (h : preImage p = preImage q) :
    p.author = q.author ∧ p.ops = q.ops ∧ p.parent = q.parent := by
  unfold preImage at h
  injection h with hauthor hops hparent
  exact ⟨hauthor, hops, hparent⟩

end Spec.Authoring
