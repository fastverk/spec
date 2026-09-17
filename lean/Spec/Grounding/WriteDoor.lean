/-
  Spec.Grounding.WriteDoor — a machine-checked grounding for the ratio corpus's
  write-door / conservation claims.

  This is the proof object the corpus's `:provenBy` points at. The whole point of
  the crank's score is that a claim counts as "proven" ONLY because something like
  this compiles, sorry-free — not because an agent wrote a convincing string. A
  fabricated `:provenBy` with no matching sorry-free `theorem` fails the grounding
  gate (//corpus:grounding_verified), so it can never raise the score.

  Model: a transaction's net effect on the conserved quantity is an integer (the
  sum of its postings). The kernel write-door (`admit`) accepts a transaction iff
  it conserves (net = 0). Pure Lean 4 core — compiling = the proofs check.
-/
-- ⛔ MUST stay. `lean_test` DOES NOT CHECK PROOFS on its own: a `sorry` is a
-- *warning* and `lean` exits 0, so a file proving anything `by sorry` passes a
-- `lean_test` cleanly. Measured on this repo, not inferred. This option turns
-- `declaration uses 'sorry'` into a hard error; //lean:audit_proofs_test asserts
-- every source still carries it, so it cannot be removed one file at a time.
set_option warningAsError true


namespace Spec.Grounding.WriteDoor

/-- Conservation: a transaction's net is zero. -/
abbrev conserves (n : Int) : Prop := n = 0

/-- The kernel write-door: admit a transaction iff it conserves. -/
def admit (n : Int) : Option Int := if n = 0 then some n else none

/-- RFC-0900 core-12 — the write-door admits ONLY conserving transactions:
    whatever it returns conserves. -/
theorem admit_conserves {t a : Int} (h : admit t = some a) : conserves a := by
  unfold admit at h
  by_cases ht : t = 0
  · rw [if_pos ht] at h
    injection h with h'
    show a = 0
    omega
  · rw [if_neg ht] at h
    simp at h

/-- RFC-0903 trading-1 — a rebalance is a batch of trades; conservation is closed
    under composition (0 + 0 = 0), so a batch of conserving trades conserves and
    is admitted by the same write-door. This is what grounds the trading claim. -/
theorem trades_compose_conserving {a b : Int}
    (ha : conserves a) (hb : conserves b) : conserves (a + b) := by
  have ha' : a = 0 := ha
  have hb' : b = 0 := hb
  show a + b = 0
  omega

end Spec.Grounding.WriteDoor
