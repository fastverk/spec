/-
Spec.Corpus.Schema — shared structures for the per-RFC modules.

Phase 2 of the dep-graph inversion: instead of authoring TTL directly,
each RFC's content lives in a Lean module under `Aion.Rfc.RfcNNNN`
that uses these structures. The committed kg/turtle/RFC-NNNN.ttl
becomes a build artifact, regenerated from the Lean modules.

Three enum types capture the spec's controlled vocabularies:
  • Modality — RFC-2119 modal verbs (MUST, MUST_NOT, MAY, …).
  • Severity — diagnostic severity classes.
  • SectionKind — the spec's section taxonomy.

The remaining structures mirror the RDF entity types found in the
corpus (introspected via //kg/java/lean:introspect_entities). Field
optionality matches the corpus surface; `Option` for predicates that
some instances lack, plain `String` / enum for predicates always present.
-/

namespace Spec.Corpus.Schema

/-- RFC-2119 modality. The corpus encodes these as IRIs in the
    `:foo` namespace; we project them into a Lean inductive so
    pattern-matching on modality is exhaustive. -/
inductive Modality where
  | MUST : Modality
  | MUST_NOT : Modality
  | MAY : Modality
  | SHOULD : Modality
  | SHOULD_NOT : Modality
  | RECOMMENDED : Modality
  | REQUIRED : Modality
  deriving DecidableEq, Repr

/-- The spec's diagnostic severity classes (from `:Severity`). -/
inductive Severity where
  | Info : Severity
  | Warning : Severity
  | Error : Severity
  | Defect : Severity
  | Fatal : Severity
  deriving DecidableEq, Repr

/-- The taxonomy of section kinds (from `:SectionKind`). -/
inductive SectionKind where
  | Normative : SectionKind
  | Purpose : SectionKind
  | Informational : SectionKind
  | DiagnosticTable : SectionKind
  | CompatibilitySection : SectionKind
  | LinkedReferences : SectionKind
  | Definitions : SectionKind
  | Invariants : SectionKind
  | GrammarSection : SectionKind
  | Examples : SectionKind
  deriving DecidableEq, Repr

/-- Proof-discharge tier for a NormativeStatement, per the
    self-application principle in `narrative/aion-roadmap.md`:

    • **Structural** — definitionally true from the model's
      construction. Example: "Wires can't carry null" — `WireValue`
      has no `null` constructor, so the claim is structurally
      inevitable. The Lean theorem exists but the proof is trivial
      (e.g. `rfl`, `intro h; exact h`).

    • **Derivational** — proven by a non-trivial Lean theorem chain
      from prior axioms, definitions, or earlier theorems. Example:
      "Refinement composition is a refinement" — composes two
      arbitrary refinement-projections via independent applications
      and chains the membership proofs.

    • **Implemented** — the spec claim is realized by code that
      runs in production, with the runtime behavior cross-checked
      against the spec. Example (future, not yet attainable): a
      `kg_ingest_paper` Bazel rule whose emitted TTL matches an
      expected schema validated against the Lean spec.

    Default is `Structural` — the most conservative tier — so
    existing records compile without modification and the sweep to
    upgrade NSes to Derivational can happen incrementally. -/
inductive Tier where
  | Structural : Tier
  | Derivational : Tier
  | Implemented : Tier
  deriving DecidableEq, Repr

/-- One RFC document's metadata. Only carries fields that aren't
    derivable from the other catalogs in the same module:

      • Intrinsic metadata: rfcId, title, status, owner, diagnosticRange.
      • Cross-RFC references: closes, refines, dependsOn, extends_,
        extendedBy, invokesDecision, references.

    The `:hasMotivation`, `:hasAntiPattern`, `:hasSection`,
    `:hasTradeoff`, `:hasExample`, `:hasAlternative`,
    `:introducesDiagnostic`, `:containsGrammar`, `:declares`, and
    `:definesTerm` predicates are derived at TTL-emit time from
    the corresponding catalogs (`motivations`, `antiPatterns`,
    `sections`, …) — they were 1:1 with those catalogs and
    pure redundancy in the per-RFC source. -/
structure Document where
  /-- "RFC-0006". -/
  rfcId : String
  /-- Human-readable title. -/
  title : String
  /-- Status — "Draft", "Accepted", "Superseded", etc. -/
  status : String
  /-- Range of diagnostic codes this RFC owns ("M06000-M06999"). -/
  diagnosticRange : Option String := none
  /-- Owner / steward (multi-valued; sometimes a list of names). -/
  owner : List String := []
  /-- IRI of an RFC this one closes. -/
  closes : Option String := none
  /-- IRI of an RFC this one refines. -/
  refines : Option String := none
  /-- Local IRIs of RFCs this one depends on (e.g., "RFC-0001"). -/
  dependsOn : List String := []
  /-- Local IRIs of RFCs this one extends (i.e., `extends ?B`). -/
  extends_ : List String := []
  /-- Local IRIs of RFCs that extend this one. -/
  extendedBy : List String := []
  /-- Local IRIs of named decisions this RFC invokes. -/
  invokesDecision : List String := []
  /-- Local IRIs of cross-RFC references. -/
  references : List String := []
  deriving Repr

/-- An RFC-introduced diagnostic. The full IRI is constructed at
    TTL-emit time as `rfc:<code>`; we don't store both an `iri` and
    a `code` because they were always identical. -/
structure Diagnostic where
  code : String
  description : String
  severity : Severity
  phase : Option String := none
  deriving Repr

/-- A normative statement — the propositional commitments of the
    spec. Some NSes are kernel axioms (`isAxiom = true` plus an
    `axiomJustification`); others are derived (have `derivedViaId`
    pointing to a `Derivation`). -/
structure NormativeStatement where
  /-- Stable rfc-namespaced IRI local part, OR a blank-node id like "b13". -/
  id : String
  modality : Modality
  predicate : String
  isAxiom : Bool := false
  axiomJustification : Option String := none
  derivedViaId : Option String := none
  proposedBy : Option String := none
  provenBy : Option String := none
  rationale : Option String := none
  /-- Discharge tier (see `Tier` above). Default `Structural` so
      existing records compile unchanged; upgrade to `Derivational`
      or `Implemented` as proofs / emits land. -/
  tier : Tier := .Structural
  deriving Repr

/-- A `:Derivation` — premise(s) + rule producing a (Normative)
    Statement. `appliesRule` is the IRI local part of an
    `InferenceRule` (e.g., `"modusPonens"`); premises and conclusion
    are NS / Axiom IDs. -/
structure Derivation where
  /-- Blank-node label assigned during extraction. -/
  id : String
  /-- Local part of the rule IRI. -/
  appliesRule : String
  /-- Premise IDs (NS local parts, blank-node labels, or axiom IDs). -/
  premiseIds : List String
  proposedBy : String
  reasoning : String
  deriving Repr

/-- A defined term in the RFC's glossary. -/
structure Term where
  id : String
  name : String
  definition : String
  deriving Repr

/-- A section header. `containsRule` is the IDs of NSes that fall
    under this section (mostly blank-node refs). -/
structure Section where
  id : String
  sectionKind : SectionKind
  sectionNumber : String
  title : String
  containsRule : List String := []
  deriving Repr

/-- A narrative block — used by Motivations, AntiPatterns,
    Tradeoffs, Examples, and Alternatives, all of which share
    the same predicate surface. -/
structure NarrativeBlock where
  id : String
  evidence : String
  fromSection : String
  narrativeText : String
  deriving Repr

/-- A grammar fragment (EBNF / PEG / etc.) embedded in an RFC. -/
structure Grammar where
  id : String
  grammarLanguage : String
  source : String
  deriving Repr

/-- A named declaration kind that the RFC introduces (used for
    `entity`, `facet`, `view`, etc.). The corpus has both
    `:NamedDeclaration` and `:DeclarationKind` with identical
    shapes; we represent them as the same structure plus a flag. -/
structure DeclarationKind where
  id : String
  /-- "named-declaration" or "declaration-kind" — distinguishes the two
      uses in the corpus. -/
  kind : String
  declarationClass : String
  declarationKindName : String
  name : String
  deriving Repr

/-- A domain-projection Invariant. Lives in `kg/turtle-domain/RFC-NNNN.ttl`
    (separate namespace from the per-RFC TTL); rendered in spec.md's
    Invariants section. -/
structure Invariant where
  /-- Local part of the invariant IRI, e.g. "claim-wraps-ai-fields". -/
  id : String
  summary : String
  /-- "compile-time", "runtime", "compile-time + runtime", etc. -/
  enforcedBy : Option String := none
  deriving Repr

end Spec.Corpus.Schema
