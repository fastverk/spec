/-
FrameworkCheck — entry point for spec's spec-framework lean_test.

Imports every framework module so a single `lean_test` compiles the whole
set (Axioms transitively pulls Kernel → Predicates → Universe; Schema and
the emitters are independent roots). Not exported for consumers — it only
exists to give the lean_test a root entry.
-/
import Spec.Axioms
import Spec.Corpus.Schema
import Spec.Corpus.Inference
import Spec.Emit.TtlEmit
import Spec.Emit.MdEmit
import Spec.Emit.TierVocab
import Spec.Authoring.Door
import Spec.Logic.Core
import Spec.Logic.InferenceRulesProofs
-- ⛔ MUST stay. `lean_test` DOES NOT CHECK PROOFS on its own: a `sorry` is a
-- *warning* and `lean` exits 0, so a file proving anything `by sorry` passes a
-- `lean_test` cleanly. Measured on this repo, not inferred. This option turns
-- `declaration uses 'sorry'` into a hard error; //lean:audit_proofs_test asserts
-- every source still carries it, so it cannot be removed one file at a time.
set_option warningAsError true

