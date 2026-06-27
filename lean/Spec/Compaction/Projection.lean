/-
Spec.Compaction.Projection — the deterministic corrector core (RFC-001b §5).

A reverse-diffusion corrector `P` must be a *safe* projection: it may lower the
energy but never raise it, it must preserve meaning, and it must be a genuine
fixed-point map. We prove the three corrector invariants for `dedupE`, the
redundancy-collapse pass (R↓), modeled over the graph's asserted-edge list:

  • meaning-preserving    `mem_dedupE`       : x ∈ dedupE l ↔ x ∈ l
  • energy-non-increasing `dedupE_length_le` : (dedupE l).length ≤ l.length
  • idempotent            `dedupE_idem`      : dedupE (dedupE l) = dedupE l

With the redundancy cost R(l) := l.length, `dedupE_length_le` is exactly
E(P G) ≤ E(G) for the R term, `mem_dedupE` is semantic equivalence, and
`dedupE_idem` makes P a projection (a crystal fixed point). The transitive-
reduction pass (L↓) runs over the live graph in //corpus via SPARQL; its
closure-preservation rests on `:dependsOn` being `owl:TransitiveProperty`.

Pure Lean 4 core — no Mathlib, no `sorry`.
-/

namespace Spec.Compaction

variable {α : Type} [DecidableEq α]

/-- Redundancy collapse: keep one representative of each edge (drop an element
    when an equal one already survives in the deduped tail). -/
def dedupE : List α → List α
  | [] => []
  | a :: as =>
      let r := dedupE as
      if a ∈ r then r else a :: r

/-- (1) Meaning-preserving: `dedupE` changes no edge's set membership. -/
theorem mem_dedupE (x : α) : ∀ l : List α, x ∈ dedupE l ↔ x ∈ l := by
  intro l
  induction l with
  | nil => simp [dedupE]
  | cons a as ih =>
    simp only [dedupE]
    split
    · rename_i h
      rw [ih, List.mem_cons]
      constructor
      · intro hx; exact Or.inr hx
      · rintro (rfl | hx)
        · exact ih.mp h
        · exact hx
    · rename_i _h
      rw [List.mem_cons, List.mem_cons, ih]

/-- (2) Energy-non-increasing: `dedupE` never grows the edge list (R↓). -/
theorem dedupE_length_le : ∀ l : List α, (dedupE l).length ≤ l.length := by
  intro l
  induction l with
  | nil => simp [dedupE]
  | cons a as ih =>
    simp only [dedupE]
    split
    · rename_i _h
      exact Nat.le_trans ih (Nat.le_succ _)
    · rename_i _h
      simp only [List.length_cons]
      exact Nat.succ_le_succ ih

/-- (3) Idempotent: `dedupE` is a genuine projection (a fixed point). -/
theorem dedupE_idem : ∀ l : List α, dedupE (dedupE l) = dedupE l := by
  intro l
  induction l with
  | nil => rfl
  | cons a as ih =>
    simp only [dedupE]
    split
    · rename_i _h
      exact ih
    · rename_i h
      simp only [dedupE]
      rw [ih, if_neg h]

/-- Redundancy cost of an edge list (the R term of the spec energy). -/
def redCost (l : List α) : Nat := l.length

/-- Corrector invariant, stated in energy terms: the redundancy-collapse pass
    never raises the energy. This is `E(P G) ≤ E(G)` for the R contribution. -/
theorem redCost_dedupE_le (l : List α) : redCost (dedupE l) ≤ redCost l :=
  dedupE_length_le l

end Spec.Compaction
