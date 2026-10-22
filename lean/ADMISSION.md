# Local validity and shared population admission

This formal API repair addresses two constructible counterexamples in earlier
source pins. It does not establish full-framework consistency or backend
correctness.

## Boundaries

`RawResource` and `RawStatement` are constructible input records. Their defaults
may be invalid. `Resource` adds a nonempty-kind certificate; `Resource.ofRaw`
requires that proof. `Statement` carries valid Resource values and the existing
ordinal-time `validFrom ≤ validTo` proof. `RawStatement.LocalValidity` and
`Statement.ofRaw` expose that local boundary without selecting new nullable
bounds, time encodings, or create policies.

Local validity is insufficient for cross-row uniqueness. An
`AdmittedStatementPopulation` supplies membership and an explicit AX-016
uniqueness certificate for pairs in that same population. An arbitrary
`Workspace`, including its all-member default, supplies neither certificate.
`ax_AX_016` requires the population and both membership witnesses. It projects
the supplied uniqueness certificate; no global axiom admits every raw value or
collection.

`StatementOverlapCertificate population` supplies AX-045 for the existing
uninterpreted `overlap` relation. `ax_AX_045` requires this certificate and both
membership witnesses. No concrete overlap, interval-bound, upsert, rejection,
diagnostic, allocation, or concurrency policy follows from these signatures.

The formerly unrestricted `kindNonempty` axiom is now a theorem projecting a
valid Resource's certificate. The old default-Resource contradiction therefore
cannot supply `rfl` for an empty kind, and raw empty-kind construction does not
produce a valid Resource. The formerly unrestricted statement-uniqueness
premise is no longer exported. Constructing two locally valid conflicting rows
remains possible; jointly admitting them requires an impossible certificate.

## Checks and consumers

`Spec.AdmissionCheck` is included by `FrameworkCheck` and the `admission_test`
target. It constructs a nonempty singleton, proves invalid raw kind rejection
and conflicting joint-admission rejection, and reports the dependencies of
those controls and AX-016/AX-045. Those proofs introduce no new axioms.
The trusted axiom baseline decreases from 93 to 92 because nonempty kind is
structural. The framework's remaining commitments are still assumptions.

Downstream callers must provide evidence; there is no compatibility overload
that restores the inconsistent unguarded theorem. Gnomon's Foundation
uniqueness theorem and its narrow Lifecycle uniqueness use require population
membership. Its Graph nonoverlap theorem additionally requires the overlap
certificate. Those signature updates do not prove metadata preservation or
runtime `M36011` rejection.

This is a local source release candidate. Publication, downstream immutable
pin adoption, generated-review rebinding, and runtime preservation evidence
are coordinated separately. The earlier inconsistent pin remains registered
as blocked in Gnomon.
