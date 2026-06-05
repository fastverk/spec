import Lake
open Lake DSL

-- Dep-free Lake workspace for spec's Lean spec-framework modules
-- (Aion.Spec.{Universe,Predicates,Kernel,Axioms}, Aion.Corpus.Schema,
-- Aion.Emit.{TtlEmit,MdEmit}). They import only Lean 4 core, so there are
-- no `require`s. rules_lean's lake.workspace accepts a dep-free workspace
-- (it emits just the toolchain). Only purpose of this file: pin the
-- toolchain version (see lean-toolchain) so the modules compile identically
-- here and as srcs in a consumer's lean_test.
package «rules-spec-lean» where
