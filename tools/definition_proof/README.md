# Verified definition proofs

This opt-in framework surface adds no domain axioms or blanket grounding rule.
A consumer owns the full claim, independently authored expected proposition,
nonempty-domain formula, semantic review, and RDF identity/policy. Both formulas
and the entire source closure are hashed into `DefinitionProofRequest`; a typed
review binds its deterministic protobuf digest. The generic driver compiles the
actual sources under the pinned Lean version and Git revision with `--trust=0`,
checks both exact types, and permits only `propext`, `Classical.choice`, and
`Quot.sound` dependencies. A certificate records actual compiler bytes, commands,
terminal outputs, source/review hashes, and the checked root count.

`definition_proof` in `definition_proof.bzl` makes this checking a build dependency
using the consumer's registered Lean toolchain. `srcs` must exactly match the
reviewed logical paths. Portable callers can invoke `verify.py` with `--root`,
`--request`, `--review`, `--lean`, and `--output`; they also need protobuf and protoc.
Generated Bazel callers use the same proto schema without runtime code generation.

A stored certificate, theorem string, RDF flag, source hash, or successful test
cannot replace this execution. Consumers must rerun the verifier before accepting
a root, validate claim ownership against current source/emission, reject unowned
root assertions throughout their corpus, and connect generated RDF directly to
this action. Semantic review is explicit policy input, not something Lean infers.
The checked scope is the reviewed formal model, never production refinement.

`verifier_test` checks malformed/stale inputs, trust shortcuts, source shadowing,
and dependency reports. `kernel_controls_test` executes the real pinned compiler
on a populated baseline and five counterfeit/type/compiler substitutions.


The closed source grammar permits ordinary one-line imports only. Modified
imports cannot escape closure checking. Executable elaboration/macro rules,
handler registration, compile-time file inclusion, and custom attributes are
rejected before compilation. The current attribute subset is `@[simp]`; the
deriving subset is DecidableEq, Repr, BEq and Inhabited. This is intentionally a
restricted model-proof surface, with source-bound semantic review still required.
The controls include modified imports, elaboration rules and handler attributes
through the full request verifier, plus fourteen lexical-policy counterfeits.
