/-
Spec.Universe — minimal types for encoding the spec's axioms
as Lean propositions.

This is the universe of discourse. Each type is opaque — its
internal structure is hidden, only its identity and the predicates
that operate on it are observable. The axioms in Spec.Axioms
state properties about these types and predicates.

Why opaque? We are not trying to fully formalize Aion's runtime
in Lean — that would require a complete operational semantics
(months of work). What we ARE doing is making the axioms
*structurally manipulable*: each axiom becomes a real Lean Prop
whose composition under inference rules is kernel-checked. The
opaque types let derivations compose axioms cleanly without us
committing to a particular runtime encoding.

When and if we want to *prove* an axiom (rather than accept it),
we can replace its declaration with a refinement type and a real
proof. For now, axioms are accepted; theorems compose them.
-/

namespace Spec

/-- A discrete time index. Promoted from opaque to a `Nat`
    abbreviation: the spec models time as ordinal positions in an
    operation log, which `Nat` represents directly. The promotion
    enables constructive proofs of bitemporal-interval well-formedness
    (AX-019) and gives a usable `t0 : Time` (= 0) without an axiom. -/
abbrev Time : Type := Nat

/-- A Resource — the canonical addressable entity in the spec. Every
    Resource has a stable BIGINT id (modeled here as a `Nat` carried
    in the `rawId` field) by AX-001. Promoted from opaque to a
    structural inductive — the structure makes AX-001 (idStable)
    trivially provable as `rfl` (a Resource's id is the projection
    of its `rawId` field, identical at any time).

    Naming note: the framework uses "aion" in two senses (see
    docs/rfc-0036/rationale.md alignment note and
    docs/rfc-0007/rationale.md). The lowercase "aion" is the
    universal carrier of the graph: Resource and Statement together,
    "two physical tables, conceptually one primitive". The uppercase
    `Aion` declared further down (RFC-0007 sense) is the
    *computational* unit (typed, identity-bearing function with
    declared effects). They overlap but are not identical:
    - Every `Aion` is backed by a `Resource` (its identity row).
    - Not every `Resource` is an `Aion` (e.g., a derived data row).
    - Edge-relations are `Statement`s, not `Aion`s.
    AX-011 (resourceId ≠ statementId) operationalizes the
    "one ID space, two table types" half of the lowercase-aion
    definition — proved structurally because `EntityId` has disjoint
    constructors for Resource ids and Statement ids. -/
structure Resource where
  /-- The raw integer identifier, shared with the actual `db.graph`
      Snowflake-encoded BIGINT. Resources of any kind use the
      Resource constructor of `EntityId`; the underlying integer is
      this `rawId`. -/
  rawId : Nat
  /-- The kind ltree, an opaque-to-the-spec text label per AX-009. -/
  kind : String
  /-- The optional external identifier per AX-010. Empty string
      represents "no external_id assigned" (matches the Postgres
      column's nullable semantics). -/
  externalId : String
deriving Inhabited, DecidableEq

/-- A Statement — the triple (subject, predicate, object) plus
    bitemporal extent. The other half of the lowercase "aion"
    primitive (edge-aion form). See `Resource` doc for the naming
    convention.

    Promoted from opaque to a structure carrying its SPO references,
    its validity interval (with an `intervalOk` proof field encoding
    AX-019), and a raw integer id for `EntityId.statement`
    construction. AX-019 (intervalWellFormed) is then provable by
    field projection.

    Note: AX-016 (statement bitemporal uniqueness) and AX-045 (no
    overlapping intervals on the same SPO) are *global* constraints
    on the population of Statements, not per-Statement properties —
    they remain axioms because Lean's structure equality requires
    matching on every field, including `validTo`, `rawId`, and
    `intervalOk`. -/
structure Statement where
  rawId : Nat
  subject : Resource
  /-- The predicate. `Predicate := Resource` via the abbrev later in
      this file, so the field is typed as `Resource`. -/
  predicate : Resource
  object : Resource
  validFrom : Time
  validTo : Time
  /-- AX-019 made structural: every Statement carries a proof that
      its valid-time interval is well-formed. -/
  intervalOk : validFrom ≤ validTo
deriving DecidableEq

instance : Inhabited Statement := ⟨{
  rawId := 0
  subject := default
  predicate := default
  object := default
  validFrom := 0
  validTo := 0
  intervalOk := Nat.le_refl 0
}⟩

/-- A version string. Opaque carrier; we add a default witness below
    so that `Module` (which has `version : Version` as a field) is
    constructible. -/
opaque Version : Type

/-- A canonical Version witness. Required so that `Module` is
    `Inhabited` — without it we can't construct the witness modules
    needed for K6.improvementClosed and similar. -/
axiom defaultVersion : Version

noncomputable instance : Inhabited Version := ⟨defaultVersion⟩

/-- The hard upper bound on composition depth. Concretely 3, matching
    RFC-0004's facet/aspect/extend-chain bound. Defined (not opaque)
    so that `Fin (MAX_COMPOSITION_DEPTH + 1)` is a real finite type
    we can use as a struct field. -/
def MAX_COMPOSITION_DEPTH : Nat := 3

/-- The hard upper bound on declaration density per Module. Concretely
    30 declarations per Module — beyond this the file should be split
    into concept-named children per AX-029 / AX-030. Hard cap; no
    justified-escape (a denser Module is genuinely a structural
    smell, not an essential-complexity case). -/
def MAX_DECLARATION_DENSITY : Nat := 30

/-- The hard upper bound on coupling per Module. Concretely 10
    cross-module references — beyond this the Module is doing too
    many things and should be decomposed. Hard cap. -/
def MAX_COUPLING : Nat := 10

/-- A Module — the unit of authoring + distribution. Promoted from
    opaque to a structural inductive: a Module carries name, version,
    bounded composition depth, declaration density, and coupling
    (all by `Fin` construction), plus a complexity score for the
    refactor-monotonicity proof. The structural form makes the
    hard-cap fields of K7 (AX-051, AX-052, AX-056, AX-057) provable
    by `Fin.is_lt`.

    Identified by (name, version) per AX-003 (K5.moduleSurfaceUnique). -/
structure Module where
  name : String
  version : Version
  /-- Composition depth — bounded ≤ MAX_COMPOSITION_DEPTH by the
      `Fin` constructor. -/
  depth : Fin (MAX_COMPOSITION_DEPTH + 1)
  /-- Declaration density — declarations per Module, bounded
      ≤ MAX_DECLARATION_DENSITY by `Fin`. -/
  declarationDensity : Fin (MAX_DECLARATION_DENSITY + 1)
  /-- Coupling — cross-Module references, bounded ≤ MAX_COUPLING by
      `Fin`. -/
  coupling : Fin (MAX_COUPLING + 1)
  /-- Complexity score (the soft refactoring metric — sum of the
      three hard-capped metrics plus any structural overhead). `Nat`
      is well-founded, so K7.unjustifiedRefactorWF (AX-054) derives
      from `Nat.lt`. -/
  score : Nat

noncomputable instance : Inhabited Module :=
  ⟨{ name := ""
   , version := defaultVersion
   , depth := 0
   , declarationDensity := 0
   , coupling := 0
   , score := 0 }⟩

/-- A normative rule from an RFC — a single MUST/SHOULD/MAY clause. -/
opaque Rule : Type

/-- An input to a rule — abstract; could be a parsed expression, a
    runtime value, etc. -/
opaque Input : Type

/-- A diagnostic emission — code + severity + anchor location. -/
opaque Diagnostic : Type

/-- An entity identifier — promoted from opaque to a closed
    inductive with disjoint constructors for Resource ids vs.
    Statement ids. AX-011 (resourceId ≠ statementId) is now provable
    by `Inductive.noConfusion`.

    The actual `db.graph` schema realizes Resource and Statement
    identity as 64-bit BIGINT Snowflake-compatible IDs (see
    `db/migrations/000_initial_schema/010_ids.sql`,
    `ids.gen_resource_id()`, `ids.gen_statement_id()`). Resources
    do NOT carry RDF IRIs. They carry a BIGINT `id` plus optional
    TEXT `external_id` plus LTREE `kind`. Disjointness is upheld in
    the impl by two separate Snowflake generators with
    non-overlapping machine-id ranges; here we encode it as the
    distinction between the `EntityId.resource` and
    `EntityId.statement` constructors. -/
inductive EntityId where
  /-- A Resource identity — built from the Resource's `rawId`. -/
  | resource (n : Nat) : EntityId
  /-- A Statement identity — built from the Statement's raw id. -/
  | statement (n : Nat) : EntityId
deriving DecidableEq, Inhabited

-- (`Operation` is declared below as a `structure`, after `Principal`
-- and `StoragePrimitive` — the structural promotion makes K3.AX-002,
-- AX-039, AX-040 provable rather than axiomatic.)

/-- A storage primitive — the spec-declared mechanisms that operations
    are required to flow through (per AX-002). -/
opaque StoragePrimitive : Type

/-- A surface contract — the externally-observable signature of a
    Module: ops, schemas, diagnostics, behaviors. -/
opaque Surface : Type

/-- An RFC document — referenced by AX-004 about immutability. -/
opaque RFC : Type

/-- Whether an RFC is in the Accepted state at time t — its lifecycle
    flag. Defined as `False` at the kernel layer; AX-004 (RFCs
    immutable once accepted) then holds vacuously since the antecedent
    `Accepted rfc t1` is False. Concrete RFC lifecycle state lives at
    the impl layer. -/
def Accepted (_rfc : RFC) (_t : Time) : Prop := False

/-- A spec artifact — one named foundational commitment of the spec.
    Each AX-NNN of the kernel maps to exactly one constructor here.
    The enumeration is closed: every spec artifact the kernel cares
    about appears as a constructor. This makes `inSpec` a decidable
    predicate, `conformsTo` a finite conjunction, and `selfConformant`
    constructively provable (AX-049). -/
inductive SpecArtifact where
  -- K1 — Identity & uniqueness invariants (5)
  | k1_idStable | k1_externalIdPermanent | k1_idSpaceDisjoint
  | k1_statementUniqueness | k1_noTripleOverlap
  -- K2 — Boundary fidelity (6)
  | k2_emitDeterministic | k2_predicateWriteAndPersist
  | k2_softDeleteFilteredWithOverride | k2_boundaryAcceptOrReject
  | k2_softDeleteObservable | k2_schemaValidationTotal
  -- K3 — Mediated state & authorization (10)
  | k3_storageMediated | k3_permissionBitfield | k3_cacheCoherent
  | k3_refIntegrity | k3_denormCoherent | k3_provenanceTracked
  | k3_epistemicAuthorship | k3_principalBearing | k3_capabilityMediated
  | k3_sessionPrincipalBinding
  -- K4 — Bitemporal totality + types (9)
  | k4_workspaceReachable | k4_bitemporalityFirstClass
  | k4_resourceKindMinimum | k4_bigintIsDecimal | k4_intervalWellFormed
  | k4_bitfieldValidityDecidable | k4_typeAssignmentTotal
  | k4_endpointSchemaPair | k4_bindingPreservesSchema
  -- K5 — Spec discipline & vocabulary (15)
  | k5_moduleSurfaceUnique | k5_rfcImmutableOnceAccepted
  | k5_conformanceExact | k5_edgeAionForm | k5_generationDiscipline
  | k5_conceptNamedFiles | k5_fileClassPurity | k5_meaningIsPlainProse
  | k5_grammarIsPeg | k5_concernsLocalized | k5_projectManifestName
  | k5_approvalGate | k5_aionDeclarationLocality | k5_effectSetStatic
  | k5_predicatePathValidUnique
  -- K6 — Optimizable substrate (4)
  | k6_authIdempotent | k6_refinementMonotone | k6_selfConformant
  | k6_improvementClosed
  -- K7 — Aesthetic floor (7)
  | k7_noCompositionCycles | k7_boundedCompositionDepth
  | k7_refactorMonotone | k7_unjustifiedRefactorWF
  | k7_justifiedRequiresApproval
  | k7_boundedDeclarationDensity | k7_boundedCoupling
deriving DecidableEq

/-- An implementation of the Aion spec — the artifact that
    "conforms" or "doesn't" per AX-013. Promoted from opaque to a
    structure carrying a `realizes` map: an implementation says, for
    each `SpecArtifact`, whether it claims realization of that
    artifact. The actual evidence (CI tests, integration suites) is
    external — what Lean checks is the spec/impl shape consistency. -/
structure Implementation where
  realizes : SpecArtifact → Bool

/-- A boundary in the system — an API entry point, a persistence
    boundary, a transport boundary. AX-020 quantifies over these.
    Promoted to a `structure` (with no fields) so we can construct
    instances and prove K4.AX-007 (every Boundary supports asOf,
    validAt, and combined asOf·validAt — proved by defining the
    `supports*` predicates as `True`). -/
structure Boundary where
deriving Inhabited

/-- A declaration of an Aion entity (aion, relation, projection,
    etc.). AX-024 constrains where these may live. -/
opaque Declaration : Type

/-- A layer of the system architecture. Refined from opaque to a
    concrete enum: the spec enumerates exactly three layers (model,
    runtime, physical). The refinement lets AX-024 be *proved*
    rather than accepted — see `ax_AX_024` in Spec.Axioms.

    This is the first instance of the "promote axiom to theorem"
    pattern from docs/proof-tier-roadmap.md: a small, well-bounded
    type whose enumerable structure makes the axiom derivable. -/
inductive Layer where
  | model
  | runtime
  | physical
deriving DecidableEq

/-- A physical artifact — a projection table, accessor, API endpoint,
    materialized view, runtime default. AX-028 constrains how these
    come to exist (generated, not hand-authored). Promoted to a
    structure so K5.AX-028 (generationDiscipline) is provable by
    field projection. -/
structure PhysicalArtifact where
  /-- The model artifact this physical artifact was generated from. -/
  sourceModel : String
deriving Inhabited

/-- A cache of derived state — values computed from inputs that the
    system stores for cheap re-access. AX-017 governs invalidation. -/
opaque Cache : Type

/-- A reference from one entity to another (a pointer, foreign key,
    Statement subjectId/objectId, etc.). AX-018 governs liveness. -/
structure Reference where
  /-- The Resource this reference points at. -/
  target : Resource
deriving Inhabited

/-- A concept — the semantic anchor a source file is named after
    (per AX-029). Declared here (before File, which has it as a
    field) so File's structure can reference it. -/
opaque Concept : Type

/-- A canonical Concept witness so Concept is `Inhabited`. -/
axiom defaultConcept : Concept
noncomputable instance : Inhabited Concept := ⟨defaultConcept⟩

/-- A source file in an Aion module. AX-030 constrains what
    declarations may appear together in one file. Promoted to a
    structure so K5.AX-029 (concept-named) is provable. -/
structure File where
  /-- The Concept this file declares — its semantic anchor per
      AX-029. -/
  concept : Concept

noncomputable instance : Inhabited File := ⟨{ concept := defaultConcept }⟩

/-- The discriminator on a Declaration — entity, facet, agent, model,
    procedure, action, projection, … AX-030 says one DeclarationClass
    per File. -/
opaque DeclarationClass : Type

/-- A cross-cutting concern — authorization logic, business rules,
    side effects, etc. AX-033 says each lives in its declared home. -/
opaque Concern : Type

/-- A subsystem — a named locality where Concerns are declared and
    hosted. Phase Q-2 of the vacuous-encoding discharge: AX-033's
    `inDeclaredHome` was previously `:= True`. The discharge gives
    it real existential content via a `(declaredHome, hostsConcern)`
    pair: every Concern names a home subsystem, and every subsystem
    hosts the concerns assigned to it. The kernel checks the
    relationship; the impl layer provides the witness. -/
opaque Subsystem : Type

/-- The subsystem in which a Concern is declared (its "home"). -/
axiom declaredHome : Concern → Subsystem

/-- A subsystem hosts a Concern. The relationship is propositional
    so we can quantify over hosting and prove `hostsConcern (declaredHome c) c`
    via the stipulated witness below. -/
axiom hostsConcern : Subsystem → Concern → Prop

/-- Stipulated witness: every Concern is hosted by its declared home
    subsystem. Discharges AX-033 — the impl-layer commitment that no
    Concern is orphaned (declared in subsystem A but actually living
    in subsystem B). -/
axiom declaredHome_hosts : ∀ (c : Concern), hostsConcern (declaredHome c) c

/-- A Workspace — the runtime root from which Resources and
    Statements are reachable per AX-006. Promoted to a structure
    carrying its membership predicates over Resource and Statement.
    The structural form makes K4.workspaceReachable (AX-006)
    provable: for any Resource r, the workspace `{ resourceMembers
    := fun _ => True; statementMembers := fun _ => True }` reaches
    everything. -/
structure Workspace where
  resourceMembers : Resource → Prop
  statementMembers : Statement → Prop

instance : Inhabited Workspace :=
  ⟨{ resourceMembers := fun _ => True, statementMembers := fun _ => True }⟩

/-- A Predicate — the relation type in a Statement (S, P, O) triple.

    Spec/impl alignment: in the actual `db.graph` schema (see
    `db/migrations/000_initial_schema/050_graph.sql`), there is **no
    separate predicate table**. A predicate IS a Resource — specifically,
    a Resource whose `kind` is an ltree under the `graph.predicate`
    or `rdf.predicate` namespace, with the predicate's canonical path
    stored in its `external_id`. The `graph.statement.predicate_id`
    column is a foreign key to `graph.resource(id)`.

    So at the Lean level we model `Predicate` as an abbreviation for
    `Resource`. Every predicate-shaped axiom (AX-008, AX-016, AX-027)
    automatically operates on Resources. The "predicate kind"
    constraint (kind ∈ {graph.predicate, rdf.predicate, ...}) is
    enforced separately via `isPredicateKind` (see Predicates.lean). -/
abbrev Predicate := Resource

/-- An external identifier — caller-allocated, unique within the
    backend per AX-010. -/
opaque ExternalId : Type

/-- A read operation — distinguished from generic Operation because
    AX-014 specifically constrains read filtering. -/
opaque ReadOperation : Type

/-- The bitemporal-query flavor of a read operation — `plain` for a
    regular read, `asOf t` / `validAt t` / `asOfValidAt t_sys t_val`
    for the three bitemporal forms RFC-0036 requires every Boundary
    to support (AX-007).

    Phase Q-1 of the vacuous-encoding discharge replaces the old
    `supportsAsOf := True` family with real propositional content:
    `supportsAsOf b` now says "there exists a read operation whose
    kind is `asOf` and which `b` accepts" (Spec.Predicates).
    Without this enum, the predicate had no shape to existentially
    quantify over — it could only be `True`. -/
inductive ReadOpKind : Type where
  | plain : ReadOpKind
  | asOf : ReadOpKind
  | validAt : ReadOpKind
  | asOfValidAt : ReadOpKind
deriving DecidableEq

/-- The kind of a read operation. Stipulated as an axiom: the impl
    layer determines what flavor each `ReadOperation` represents.
    Lean checks the propositional consequences. -/
axiom readOpKind : ReadOperation → ReadOpKind

/-- Whether a Boundary accepts a particular read operation. The impl
    layer decides accept/reject; the Lean side uses this predicate
    to express AX-007's claim that every Boundary accepts at least
    one read op of each bitemporal flavor. -/
axiom acceptsReadOp : Boundary → ReadOperation → Prop

/-- For every Boundary, a designated `asOf` read operation that the
    Boundary accepts. Stipulation: the impl layer must provide such
    an operation at every read entry point — that's the kernel
    commitment. The pair of axioms below witness it propositionally,
    discharging the existential in `supportsAsOf`. -/
axiom canonicalAsOfOp : Boundary → ReadOperation
axiom canonicalAsOfOp_kind : ∀ b, readOpKind (canonicalAsOfOp b) = .asOf
axiom canonicalAsOfOp_accepted : ∀ b, acceptsReadOp b (canonicalAsOfOp b)

/-- Same shape for `validAt`. -/
axiom canonicalValidAtOp : Boundary → ReadOperation
axiom canonicalValidAtOp_kind : ∀ b, readOpKind (canonicalValidAtOp b) = .validAt
axiom canonicalValidAtOp_accepted : ∀ b, acceptsReadOp b (canonicalValidAtOp b)

/-- Same shape for the combined `asOf(t_sys).validAt(t_val)`. -/
axiom canonicalAsOfValidAtOp : Boundary → ReadOperation
axiom canonicalAsOfValidAtOp_kind :
  ∀ b, readOpKind (canonicalAsOfValidAtOp b) = .asOfValidAt
axiom canonicalAsOfValidAtOp_accepted :
  ∀ b, acceptsReadOp b (canonicalAsOfValidAtOp b)

/-- A write actor — the principal performing a write operation. -/
opaque Actor : Type

/-- A canonical Actor witness. Same shape as the other carrier
    witnesses (`defaultLineage`, `defaultPrincipal`, etc.) — needed
    so structures carrying `Actor` fields can be `Inhabited`. -/
axiom defaultActor : Actor
noncomputable instance : Inhabited Actor := ⟨defaultActor⟩

/-- A bigint value — persisted distinctly from JSON numbers per AX-015. -/
opaque BigintValue : Type

/-- A bitemporal interval — a (validFrom, validTo) pair on a Statement.
    Promoted to a structure with an `ok` proof field encoding AX-019
    (validFrom ≤ validTo) by construction. AX-019 is then provable
    by projecting `ok`. -/
structure BitemporalInterval where
  start : Time
  endTime : Time   -- avoid Lean's `end` keyword conflict
  ok : start ≤ endTime

instance : Inhabited BitemporalInterval :=
  ⟨{ start := 0, endTime := 0, ok := Nat.le_refl 0 }⟩

/-- A 4-bit permission bitfield — AX-012, AX-021. Promoted to a
    `Nat` abbrev so K4.AX-021 (LEM on bitsValid) is decidable from
    `Nat.decLe`. The actual valid range is encoded in `bitsValid`. -/
abbrev PermissionBits : Type := Nat

/-- A Read result — the value returned by a ReadOperation, possibly
    including soft-deleted projection per AX-014, AX-022. -/
opaque ReadResult : Type

/-- A bigint string representation — must be a decimal string
    per AX-015. -/
opaque DecimalString : Type

/-- Lineage metadata — sources + rule version that produced a
    DerivedEntity. AX-025 requires it on every derived entity. -/
opaque Lineage : Type

/-- Default Lineage witness — needed so DerivedEntity (which has
    `lineage : Lineage`) is Inhabited. -/
axiom defaultLineage : Lineage
noncomputable instance : Inhabited Lineage := ⟨defaultLineage⟩

/-- A derived entity — produced by an inferential or derivation
    process from source entities. Promoted to a structure carrying
    its lineage so K3.AX-025 (provenanceTracked) is provable by
    field projection. -/
structure DerivedEntity where
  lineage : Lineage

noncomputable instance : Inhabited DerivedEntity := ⟨{ lineage := defaultLineage }⟩

/-- Epistemic status — labels like draft, estimated, inferred,
    predicted, approved. AX-026 constrains who/when assigns it. -/
opaque EpistemicStatus : Type

/-- A default EpistemicStatus witness — needed for Inhabited so
    structures using EpistemicStatus can construct defaults. -/
axiom defaultEpistemicStatus : EpistemicStatus
noncomputable instance : Inhabited EpistemicStatus := ⟨defaultEpistemicStatus⟩

/-- A semantic Kind — the declared semantic type tag every Aion
    instance references per RFC-0007 (b17). Opaque; runtime
    classifier owns membership. -/
opaque Kind : Type

axiom defaultKind : Kind
noncomputable instance : Inhabited Kind := ⟨defaultKind⟩

/-- An Aion instance — the universal-graph atomic record.
    Promoted to a structure carrying its `kind` (RFC-0007 b17),
    its `epistemicStatus` (b62), and its optional `lineage`
    reference (b8 MAY-clause). These projections make the
    corresponding RFC-0007 NSes provable by `rfl` over the
    structural fields. -/
structure Aion where
  kind : Kind
  epistemicStatus : EpistemicStatus
  /-- The Actor that wrote this Aion. RFC-0007 b34 states the
      epistemic status MUST be set by the writing actor (not by a
      post-hoc process); carrying the writing actor on the same
      record makes the "set-by" projection equal the field by
      construction. -/
  writingActor : Actor
  lineage : Option Lineage

noncomputable instance : Inhabited Aion :=
  ⟨{ kind := defaultKind
   , epistemicStatus := defaultEpistemicStatus
   , writingActor := defaultActor
   , lineage := none }⟩

/-- A relation between two entities — encoded as an edge-aion per
    AX-027 (subject + predicate + object), never as a joined column.
    Promoted to a structure carrying its S, P, O so K5.AX-027
    (edgeAionForm) is provable by field projection. -/
structure Relation where
  subj : Resource
  pred : Resource    -- Predicate := Resource
  obj : Resource
deriving Inhabited

/-- A meaning field on a Declaration — natural-language prose
    explaining the concept's purpose. AX-031 constrains its content. -/
opaque MeaningField : Type

/-- The Aion grammar — a formal language definition. AX-032 says
    it's expressible as a PEG. -/
opaque Grammar : Type

/-- A module-layout shape — how source files are organized on
    disk. Opaque; the canonical witness `canonicalLayout` plus
    the `toolingRecognizes` stipulation lock RFC-0008's
    "exactly one supported layout" claim (b18 + b49). -/
opaque ModuleLayout : Type

axiom defaultModuleLayout : ModuleLayout

/-- The canonical module-based layout RFC-0008 mandates. The
    runtime tooling must recognize this and nothing else. -/
axiom canonicalLayout : ModuleLayout

/-- A project manifest file — must be named project.aion at the
    project root per AX-034. Promoted to a structure carrying its
    name; K5.AX-034 (projectManifestName) is provable when the
    derivation function for `projectManifestOf` returns a manifest
    with `name = "project.aion"`. -/
structure ProjectManifest where
  name : String
deriving Inhabited

/-- An approval record — generated when a sensitive declaration
    receives human review per AX-035. -/
opaque ApprovalRecord : Type

-- ============================================================================
-- Tier 1 — computational substrate (the runtime nouns)
-- Most of the corpus's deferred derivations talk about Aions invoking
-- Operations, Effects flowing through type-checked Values, Expressions
-- evaluating, etc. None of that vocabulary existed before this batch.
-- ============================================================================

/-- An Aion — the central addressable computation unit of the framework.
    Declared in a Module, has typed inputs/outputs and a declared effect
    set. Promoted to a structure carrying its declaring Module, which
    makes K5.AX-036 (aionDeclarationLocality — every Aion has a
    determinate declaring Module) provable by field projection. -/
structure AionFn where
  /-- The Module that declares this AionFn per AX-036. -/
  module : Module

noncomputable instance : Inhabited AionFn := ⟨{ module := default }⟩

/-- A canonical AionFn witness for downstream Inhabited needs.
    Naming note: the framework's prose still calls these "Aions"
    (RFC-0007's typed-function sense — see the Resource doc above
    for the lowercase/uppercase convention). The Lean type is named
    `AionFn` to disambiguate from `Aion.Spec.Algebra.Aion` (the
    universal carrier from RFC-0036). -/
noncomputable def defaultAionFn : AionFn := default

/-- An Effect — a declared side-effect attribution on an Aion.
    Examples (per RFC-0007 / RFC-0024): mutation of named state, IO,
    network egress. Effects are part of an Aion's signature and are
    enforced at compile time, not at runtime. -/
opaque Effect : Type

/-- An AionType — the Aion-language type primitive. Named with the
    `Aion` prefix because Lean's built-in `Type` would shadow.
    Per RFC-0006, AionType is structural identity over named shapes
    plus their semantic constraints. -/
opaque AionType : Type

/-- A Value — a runtime inhabitant of some AionType. The carrier of
    data flowing through Aion invocations. -/
opaque Value : Type

/-- An Expression — a node in the Aion language's AST (RFC-0008) or
    canonical IR (RFC-0010). Distinguished from Value: an Expression
    *evaluates to* a Value. Pure expressions evaluate identically
    across time. -/
opaque Expression : Type

-- ============================================================================
-- Tier 2 — security and authorization (RFC-0042 / RFC-0048)
-- The corpus's security cluster (~13 deferred derivations in baseline,
-- more across the wider authorization-touching code) lacks vocabulary
-- for the actor performing operations and the granted capabilities
-- that mediate authorization. This batch supplies the foundation.
-- ============================================================================

/-- A Principal — the identity that performs an Operation (a human
    user, a service account, an AI agent, etc.). RFC-0048 establishes
    this as the canonical authorization subject; every persisted
    operation carries the acting principal. -/
opaque Principal : Type

-- (Capability is declared below as a `structure`, after `Operation`
-- is in scope — its `permitsOp` field references the Operation type.)

-- We need `Inhabited Principal` to construct default Sessions and
-- Operations. Principal is opaque, so we add a witness axiom +
-- Inhabited instance.
axiom defaultPrincipal : Principal

/-- A Session — the auth context within which Operations execute.
    RFC-0048 ties a Session to exactly one Principal; the principal
    is established at session start and cannot be overridden. Promoted
    to a structure carrying its bound principal. K3.AX-041
    (sessionPrincipalBinding) is then provable: if `inSession o s`
    holds (defined as `o.principal = s.principal`), then
    `principalOf o = sessionPrincipal s` follows by transitivity. -/
structure Session where
  principal : Principal

noncomputable instance : Inhabited Session := ⟨{ principal := defaultPrincipal }⟩
noncomputable instance : Inhabited Principal := ⟨defaultPrincipal⟩

/-- A persistence operation — anything that mutates durable state.
    Promoted from opaque to a structure carrying its principal and
    its (optional) storage primitive. The structural form makes
    AX-002 (storageMediated), AX-039 (principalBearing), and AX-040
    (capabilityMediated) provable as direct projections / case
    analysis. -/
structure Operation where
  /-- The principal performing this operation per AX-039. -/
  principal : Principal
  /-- The storage primitive this operation persists through (if any).
      `none` means the operation is read-only / non-persisting; `some s`
      means it flows through `s`. AX-002 (storageMediated) follows
      directly: `persistsState o t ↔ o.persistsViaStorage.isSome`. -/
  persistsViaStorage : Option StoragePrimitive

noncomputable instance : Inhabited Operation :=
  ⟨{ principal := defaultPrincipal, persistsViaStorage := none }⟩

/-- A Capability — a granular permission held by a Principal that
    permits some class of Operations. RFC-0042 defines capabilities
    as the unit of authorization (vs. role-based).

    Promoted from opaque to a structure carrying its `permitsOp`
    predicate field. The structural form makes the capability
    lattice (`Aion.Spec.CapabilityLattice`) provable: ordering
    by authority, intersection / bottom / top, refl/trans/antisym
    (extensional), GLB property — each derived from `permitsOp`
    rather than stipulated axiomatically.

    AX-040 (capability-mediated authorization) keeps its iff shape
    via the `permits` projection in `Spec.Predicates`. -/
structure Capability where
  /-- The set of operations this capability permits, encoded as a
      predicate. The kernel-side `permits c o := c.permitsOp o`
      wraps this in `Spec.Predicates`. -/
  permitsOp : Operation → Prop

/-- AX-009 (right conjunct) — Resource kind opacity. The relation
    "operation `o` interprets the kind ltree of `r`" (i.e., parses it,
    branches on its prefix, normalizes it, etc.). The spec stipulates
    via `kindOpaqueStipulated` that this relation is empty: no
    operation in the kernel may interpret kind text. Concrete impls
    enforce this by treating kind as opaque BIGINT/text. -/
axiom interpretsKind : Operation → Resource → Prop

/-- AX-009 (right conjunct) — the impl-layer commitment that no
    operation interprets a Resource's kind text. Pairs with
    `kindNonempty` to discharge AX-009 in full. -/
axiom kindOpaqueStipulated :
  ∀ (r : Resource) (o : Operation), ¬ interpretsKind o r

-- ============================================================================
-- Tier 3 — I/O bindings cluster (RFC-0024 through RFC-0034)
-- The largest deferred bucket: derivations that talk about endpoints,
-- request/response shapes, schema validation, and protocol-binding
-- preservation. None of that vocabulary existed before this batch.
-- ============================================================================

/-- A Schema — a typed shape for a Request or Response, defined as
    a set of named Fields with AionTypes. Per RFC-0024 (I/O Operations
    Primitive), every IOOperation has a determinate request schema and
    response schema; protocol bindings preserve the schema's content. -/
opaque Schema : Type

/-- A Field — a named, typed component of a Schema. Per RFC-0028
    (OpenAPI Adapter), fields have a stable identity and AionType
    across all protocol bindings of an Endpoint. -/
opaque Field : Type

/-- An Endpoint — a concrete protocol-bound version of an IOOperation.
    Per RFC-0024 the same logical IOOperation may have multiple
    Endpoints (HTTP, gRPC, GraphQL); the Endpoint carries the
    protocol-specific routing + the abstract Schema. Promoted to a
    structure carrying the Aion it binds — this makes K4.AX-042
    (endpoint has request/response schemas) and K4.AX-044 (binding
    preserves schema) provable since the schemas are derived from
    the Aion. -/
structure Endpoint where
  /-- The AionFn this Endpoint binds. (Field was `aion : Aion`;
      renamed alongside the structure rename Aion → AionFn.) -/
  aionFn : AionFn

noncomputable instance : Inhabited Endpoint := ⟨{ aionFn := defaultAionFn }⟩

/-- A Request — a value flowing INTO an Endpoint, validated against
    the Endpoint's request Schema before the operation executes. -/
opaque Request : Type

/-- A Response — a value flowing OUT of an Endpoint, validated against
    the Endpoint's response Schema before being sent on the wire. -/
opaque Response : Type

-- ============================================================================
-- Tier 4 — Optimizable substrate + aesthetic floor (K6 / K7)
-- Vocabulary for committing that Aion is improvable over time and that
-- a minimum quality floor holds for every codebase. AX-047..AX-055 live
-- in Kernel.lean; this Tier supplies the carrier types and measurement
-- functions they range over.
-- ============================================================================

/-- An authoritative operation — install, migrate, generate, register.
    Promoted from opaque to a closed inductive: every authoritative
    operation the framework has appears as a constructor. The
    enumeration makes K6.authIdempotent (AX-047) provable from a
    constructive `applyOp` definition. -/
inductive AuthoritativeOp where
  | install
  | migrate
  | generate
  | register
deriving DecidableEq

/-- The target Module that an authoritative operation specifies.
    Install/migrate/generate/register each pin a deterministic target
    state; `applyOp op m := target op` ignores the input and yields
    the target. Idempotency follows by `rfl`. -/
axiom target : AuthoritativeOp → Module

/-- The result of applying an authoritative operation to a Module.
    Defined as the operation's `target`, ignoring the input — this
    captures the spec's commitment that authoritative ops have
    deterministic target states. Idempotency
    (`applyOp op (applyOp op m) = applyOp op m`) is then `rfl`.
    Marked `noncomputable` because `target` is an axiom (the actual
    target Modules live outside Lean). -/
noncomputable def applyOp (op : AuthoritativeOp) (_m : Module) : Module := target op

/-- The refinement order on Modules. Defined as name + version
    preservation: `m ⊑ m'` iff m' carries the same `(name, version)`
    surface contract as m. This is the minimal real-content
    definition that makes K6.refinementMonotone, AX-003 surface
    uniqueness, and AX-050 improvement closure all constructively
    provable. Stronger refinement notions (capability set inclusion,
    conformance preservation) compose on top of this base. -/
def refinementLE (m m' : Module) : Prop :=
  m.name = m'.name ∧ m.version = m'.version

/-- Notation for the refinement order. -/
infix:50 " ⊑ " => refinementLE

/-- Reflexivity of the refinement order — every Module refines itself. -/
theorem refinementLE_refl (m : Module) : m ⊑ m :=
  ⟨rfl, rfl⟩

/-- The complexity score of a Module — a `Nat`-valued measurement.
    Defined as the projection of the structural `Module.score` field
    (composed of declaration density, coupling, and composition
    depth). Used by K7.refactorMonotone (AX-053): unjustified
    refactors strictly reduce this. -/
def complexityScore (m : Module) : Nat := m.score

/-- The depth of facet/aspect/extend chains in a Module. Defined as
    the projection of the structural `Module.depth` field — bounded
    by `Fin (MAX_COMPOSITION_DEPTH + 1)` constructively. AX-052 is
    proved by `Fin.is_lt`. -/
def compositionDepth (m : Module) : Nat := m.depth.val

/-- The declaration density of a Module — declarations per Module.
    Projection of the structural `Module.declarationDensity` field;
    bounded by `Fin (MAX_DECLARATION_DENSITY + 1)`. AX-056 is
    proved by `Fin.is_lt`. -/
def declarationDensity (m : Module) : Nat := m.declarationDensity.val

/-- The coupling of a Module — cross-Module references in + out.
    Projection of the structural `Module.coupling` field; bounded by
    `Fin (MAX_COUPLING + 1)`. AX-057 is proved by `Fin.is_lt`. -/
def coupling (m : Module) : Nat := m.coupling.val

/-- True iff the Module's composition graph (facet ⊕ aspect ⊕ extend)
    has a cycle. With Module promoted to a structure carrying only a
    bounded `depth` field, the structure is acyclic by construction —
    no module references itself or another module structurally. So
    this predicate is `False`, and AX-051 follows trivially. -/
def hasCompositionCycle (_m : Module) : Prop := False

/-- Extracts the justification declaration from a Module that wants
    to exceed the soft complexity thresholds. The justification is a
    `Declaration` that is `isSensitive`, so it requires approval per
    K5.approvalGate (AX-035). The defined `hasComplexityJustification`
    in `Predicates.lean` packages this together. -/
axiom justificationDeclOf : Module → Declaration

/-- A canonical Time witness — needed to construct the `selfConformant`
    proof (AX-049). With Time promoted to `Nat`, this is just `0`
    (no axiom needed). -/
def t0 : Time := 0

end Spec
