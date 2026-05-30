/-
FrameworkCheck — entry point for rules_spec's spec-framework lean_test.

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
import Spec.Logic.Core
import Spec.Logic.InferenceRulesProofs
