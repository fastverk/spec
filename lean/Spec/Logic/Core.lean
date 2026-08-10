/-
Aion.Logic.Core — minimal universe of discourse for the inference-rule
soundness proofs. Kept stdlib-only on purpose so the proof tier doesn't
pull mathlib (which would add minutes to cold CI builds).

The proofs in InferenceRulesProofs.lean depend only on the symbols
declared here.
-/
-- ⛔ MUST stay. `lean_test` DOES NOT CHECK PROOFS on its own: a `sorry` is a
-- *warning* and `lean` exits 0, so a file proving anything `by sorry` passes a
-- `lean_test` cleanly. Measured on this repo, not inferred. This option turns
-- `declaration uses 'sorry'` into a hard error; //lean:audit_proofs_test asserts
-- every source still carries it, so it cannot be removed one file at a time.
set_option warningAsError true


namespace Spec.Logic
/-- The four normative modalities Aion uses (RFC-2119-style). -/
inductive Modality where
  | must
  | mustNot
  | should
  | may
  deriving Repr, DecidableEq

/-- A normative statement parameterised over the modality and the
predicate it asserts. The proofs operate at the level of propositional
shape, not the literal Aion KG triples. -/
structure Statement (P : Prop) where
  modality : Modality
  proof    : P

end Spec.Logic