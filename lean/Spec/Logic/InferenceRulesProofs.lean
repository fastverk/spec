/-
Aion.Logic.InferenceRulesProofs — soundness proofs for the inference
rules declared in kg/turtle/inference-rules.ttl.

Every rule named in the TTL catalog must have a corresponding
`<rule_id>_sound` theorem here. The kg_lint check
`inference-rule-mechanized` enforces this match (warning severity);
this file ensures the proofs themselves type-check.

If a proof fails to elaborate, the build fails — which means the rule
is unsound under the model in Core.lean and must either be removed
from the catalog or re-stated until provable.
-/

import Spec.Logic.Core
-- ⛔ MUST stay. `lean_test` DOES NOT CHECK PROOFS on its own: a `sorry` is a
-- *warning* and `lean` exits 0, so a file proving anything `by sorry` passes a
-- `lean_test` cleanly. Measured on this repo, not inferred. This option turns
-- `declaration uses 'sorry'` into a hard error; //lean:audit_proofs_test asserts
-- every source still carries it, so it cannot be removed one file at a time.
set_option warningAsError true


namespace Spec.Logic
/-- typeInstantiation: from a universally-quantified property over a
class, plus an instance of the class, derive the property of the
instance. -/
theorem typeInstantiation_sound :
    ∀ (T : Sort u) (P : T → Prop) (a : T), (∀ x : T, P x) → P a := by
  intros _ _ a hAll; exact hAll a

/-- subclassInheritance: from a subclass relation `∀ y, C y → D y`
and an instance `C x`, derive `D x`. (OWL-DL native; here we model
classes as predicates.) -/
theorem subclassInheritance_sound :
    ∀ (C D : α → Prop) (x : α), (∀ y, C y → D y) → C x → D x := by
  intros _ _ x hSub hC; exact hSub x hC

/-- modusPonens: from `P → Q` and `P`, derive `Q`. -/
theorem modusPonens_sound :
    ∀ (P Q : Prop), (P → Q) → P → Q := by
  intros _ _ pq p; exact pq p

/-- definitionalSubstitution: a definition `T = D` licenses replacing
`T` with `D` in any propositional context φ. We model this as
substitutivity of equality (Lean's `Eq.subst`). -/
theorem definitionalSubstitution_sound :
    ∀ {α : Sort u} (φ : α → Prop) (T D : α), T = D → φ T → φ D := by
  intros _ φ T D hEq hT; exact hEq ▸ hT

/-- dependsOnImport: an RFC dependency edge licenses citing the
target's facts as premises in the source. We model this as: if
`B` (B's body of facts) implies `Y`, and `A` declares `B` as a
dependency (modeled by including `B`'s facts in `A`'s context),
then `A` may cite `Y`. The structural content reduces to modus
ponens once the import is granted. -/
theorem dependsOnImport_sound :
    ∀ (A B Y : Prop), (B → Y) → (A → B) → (A → Y) := by
  intros _ _ _ hBY hAB hA; exact hBY (hAB hA)

end Spec.Logic