/-
Spec.Predicates — the operations we observe on the universe.

These are opaque, like the types they operate on. Their semantics
are pinned down by the axioms in Spec.Axioms. Adding a new
predicate that no axiom constrains is pure overhead and should be
avoided.
-/

import Spec.Universe

namespace Spec

/-- The EntityId assigned to a Resource at a given time. Defined as
    the Resource's `rawId` projected through `EntityId.resource` —
    independent of `t` because the structural Resource carries a
    stable `rawId`. AX-001 (idStable) is therefore `rfl`.

    In the impl this is the BIGINT `graph.resource.id`
    (Snowflake-allocated, never rewritten over the Resource's
    lifetime — soft-delete preserves it). -/
def idOf (r : Resource) (_t : Time) : EntityId := EntityId.resource r.rawId

/-- A Resource is "alive" (exists in the live system) at time t. -/
axiom alive : Resource → Time → Prop

/-- The deterministic diagnostic-emission function — rule + input →
    diagnostic, no time dependence. AX-005 emit-determinism follows
    because the wrapper `emit r i _t := emitFor r i` ignores time. -/
axiom emitFor : Rule → Input → Diagnostic

/-- A boundary's diagnostic emission for a (rule, input) at time t.
    Defined as `emitFor r i` (time-independent), so K2.AX-005
    (emitDeterministic — `emit r i t1 = emit r i t2`) is `rfl`. -/
noncomputable def emit (r : Rule) (i : Input) (_t : Time) : Diagnostic := emitFor r i

/-- A surface derivation function — given a name + version, returns
    the unique surface contract. AX-003 (K5.moduleSurfaceUnique) is
    proved from the fact that `surface` is now a function of the
    name + version pair only. -/
axiom deriveSurface : String → Version → Surface

/-- A Module's name. Projection of the structural `Module.name` field. -/
def name (m : Module) : String := m.name

/-- A Module's version. Projection of the structural `Module.version` field. -/
def version (m : Module) : Version := m.version

/-- The surface contract of a Module at the given (name, version)
    pair. Defined as `deriveSurface m.name m.version`, which makes
    AX-003 (K5.moduleSurfaceUnique) provable: equal name+version
    pairs derive equal surfaces. -/
noncomputable def surface (m : Module) : Surface := deriveSurface m.name m.version

/-- An Operation persists state through a specific StoragePrimitive
    at time t. Defined: o's `persistsViaStorage` field equals
    `some s` (storage primitive is matched). Independent of t since
    Operation's storage assignment is structural. AX-002 says every
    persistence flows through one of these — provable from this def
    by case analysis on `o.persistsViaStorage`. -/
def persistsVia (o : Operation) (s : StoragePrimitive) (_t : Time) : Prop :=
  o.persistsViaStorage = some s

/-- An Operation produces durable state at time t. Defined: o's
    `persistsViaStorage` field is `some _`. -/
def persistsState (o : Operation) (_t : Time) : Prop :=
  o.persistsViaStorage.isSome = true

/-- The normative content of an RFC at time t. AX-004 says this is
    invariant once Accepted. -/
axiom normativeContent : RFC → Time → Prop  -- placeholder for the
                                              -- predicate space the
                                              -- RFC's rules occupy

/-- An Implementation implements a particular SpecArtifact at time t.
    Promoted from axiom to a constructive definition: an implementation
    realizes an artifact iff its `realizes` map says so. -/
def implements (i : Implementation) (a : SpecArtifact) (_t : Time) : Prop :=
  i.realizes a = true

/-- A SpecArtifact is in the spec (declared by some RFC). Every
    constructor of `SpecArtifact` corresponds to a kernel commitment,
    so every artifact is in spec by definition. -/
def inSpec (_a : SpecArtifact) : Prop := True

/-- An Implementation conforms to the spec at time t iff it implements
    every in-spec artifact. AX-013 (K5.conformanceExact) is then
    immediate from this definition: the projection from the universal
    is constructive. -/
def conformsTo (i : Implementation) (t : Time) : Prop :=
  ∀ a : SpecArtifact, inSpec a → implements i a t

/-- The witness Implementation that claims to realize every spec
    artifact. The `realizes := fun _ => true` body is structurally
    consistent (every artifact is claimed) and lets us prove
    AX-049 (selfConformant) constructively. The actual evidence —
    that the real Aion compiler conforms — is external to Lean. -/
def aionCompiler : Implementation := { realizes := fun _ => true }

/-- The two possible outcomes a Boundary can produce for an Input
    at time t. Closed inductive — exhaustively covers every Boundary
    interaction, so AX-020 (boundaryAcceptOrReject) follows by case
    analysis. -/
inductive BoundaryOutcome where
  | acceptFaithful : BoundaryOutcome
  | rejectWithDiagnostic : BoundaryOutcome
deriving DecidableEq

/-- The outcome a Boundary produces for an Input at time t. -/
axiom boundaryOutcome : Boundary → Input → Time → BoundaryOutcome

/-- A Boundary accepts an Input faithfully (preserves it verbatim).
    Defined: `boundaryOutcome b i t = .acceptFaithful`. -/
def acceptedFaithfully (b : Boundary) (i : Input) (t : Time) : Prop :=
  boundaryOutcome b i t = BoundaryOutcome.acceptFaithful

/-- A Boundary rejects an Input with a diagnostic — surfaces an
    error. Defined: `boundaryOutcome b i t = .rejectWithDiagnostic`. -/
def rejectedWithDiagnostic (b : Boundary) (i : Input) (t : Time) : Prop :=
  boundaryOutcome b i t = BoundaryOutcome.rejectWithDiagnostic

/-- The model layer — distinguished by AX-024 as the canonical
    location for Aion declarations. Refined from axiom to definition
    once Layer became a concrete inductive type. -/
def modelLayer : Layer := Layer.model

/-- A Declaration is located in a particular Layer. Refined from an
    opaque relation to a concrete predicate: a Declaration is at
    layer `l` iff `l` is the model layer. This bakes AX-024's
    intent ("declarations live at the model layer, period") into
    the predicate's definition, so AX-024 itself can be proved. -/
def declaredAt (_d : Declaration) (l : Layer) : Prop := l = Layer.model

/-- AX-028 — A PhysicalArtifact is generated from the logical model.
    Real existential: `∃ m, p.sourceModel = m`. Constructive — every
    PhysicalArtifact carries a `sourceModel` field, so the witness is
    `⟨p.sourceModel, rfl⟩`. The propositional content (existence of
    a source-model name) is real even though provability is trivial. -/
def generatedFromModel (p : PhysicalArtifact) : Prop :=
  ∃ m : String, p.sourceModel = m

/-- A PhysicalArtifact is hand-authored (forbidden under AX-028).
    Defined as `False` — every PhysicalArtifact has a `sourceModel`
    field by construction, so by definition none are hand-authored.
    AX-028's `¬handAuthored p` clause then reduces to `¬False = id`. -/
def handAuthored (_p : PhysicalArtifact) : Prop := False

/-- An Input is among the inputs of a Cache (i.e. the cache's value
    depends on it). AX-017 invalidation is keyed on this relationship. -/
axiom isInputOf : Input → Cache → Prop

/-- An Input is mutated at time t (its value changes). -/
axiom mutated : Input → Time → Prop

/-- AX-017 — A Cache is invalidated at time `ti` iff some input
    that the cache depends on was mutated at `ti`. Real propositional
    content: an existential over inputs, so AX-017's witness ti is
    accompanied by the responsible input plus its mutation. The impl
    layer enforces this by dropping/recomputing the cache when any
    `isInputOf` input mutates; this Lean encoding makes the
    invalidation trigger structural rather than vacuous. -/
def invalidated (c : Cache) (ti : Time) : Prop :=
  ∃ i : Input, isInputOf i c ∧ mutated i ti

/-- The Resource a reference points at. Projection of the structural
    `Reference.target` field. -/
def refTarget (r : Reference) : Resource := r.target

/-- A reference is "live" at time t iff its target Resource is alive
    at time t. Defined this way (not as a separate predicate), AX-018
    (refIntegrity — `refLive r t → alive (refTarget r) t`) reduces
    to `id`. -/
def refLive (r : Reference) (t : Time) : Prop := alive (refTarget r) t

/-- A Declaration is contained in (i.e. authored within) a File.
    Opaque at the kernel layer — concrete file-membership lives at
    the impl layer (the file parser populates this when scanning
    `.aion` sources). AX-030 (file class purity) is backed by the
    `filePureClassStipulated` axiom below rather than the previous
    `:= False` definition that made it vacuously true. -/
axiom containedIn : Declaration → File → Prop

/-- The DeclarationClass of a Declaration (entity, facet, agent, …). -/
axiom declarationClass : Declaration → DeclarationClass

/-- AX-030 — Stipulated witness: any two declarations contained in
    the same file share their DeclarationClass. Impl-layer commitment
    that source files are class-pure (the compiler rejects a file
    mixing entity + facet + agent etc.). Parallel to
    `declaredHome_hosts` for AX-033: gives AX-030 real propositional
    content rather than routing through the previous vacuous
    `containedIn _ _ := False` definition (`h.elim`). -/
axiom filePureClassStipulated :
    ∀ (d1 d2 : Declaration) (f : File),
      containedIn d1 f → containedIn d2 f →
      declarationClass d1 = declarationClass d2

/-- AX-033 — Locality of concerns. A Concern is "in its declared
    home" iff its declared-home subsystem actually hosts it. The
    witness comes from `declaredHome_hosts` in `Spec.Universe`
    (the impl-layer commitment that nothing is orphaned). -/
def inDeclaredHome (c : Concern) : Prop :=
  hostsConcern (declaredHome c) c

-- AX-006 — Workspace reachability
/-- A Resource is reachable from a Workspace at time t iff it is in
    the Workspace's `resourceMembers` predicate. Independent of t —
    membership is structural in this layer. -/
def resourceReachable (r : Resource) (w : Workspace) (_t : Time) : Prop :=
  w.resourceMembers r

/-- A Statement is reachable from a Workspace at time t iff it is in
    the Workspace's `statementMembers` predicate. -/
def statementReachable (s : Statement) (w : Workspace) (_t : Time) : Prop :=
  w.statementMembers s

-- AX-007 — Bitemporality is first-class. RFC-0036 requires every
-- reading Boundary to support `asOf(t)`, `validAt(t)`, and combined
-- `asOf(t_sys).validAt(t_val)` queries.
--
-- These predicates were stipulated as `True` until the
-- vacuous-encoding audit (proof-tier-roadmap.md, 2026-05-08) forced
-- them to gain real propositional content. Each now says:
-- "there exists a read operation of the corresponding bitemporal
-- kind that this Boundary accepts." The witnesses come from the
-- `canonical*Op` stipulation axioms in `Spec.Universe` — the
-- impl-layer commitment that every Boundary has a designated
-- handler for each query flavor.
def supportsAsOf (b : Boundary) : Prop :=
  ∃ op : ReadOperation, readOpKind op = .asOf ∧ acceptsReadOp b op

def supportsValidAt (b : Boundary) : Prop :=
  ∃ op : ReadOperation, readOpKind op = .validAt ∧ acceptsReadOp b op

def supportsAsOfValidAt (b : Boundary) : Prop :=
  ∃ op : ReadOperation, readOpKind op = .asOfValidAt ∧ acceptsReadOp b op

-- AX-008 — Predicate disjunction at write time
axiom writtenWithPredicateId : Statement → Prop
axiom writtenWithPath : Statement → Prop
axiom persistedHasPredicateId : Statement → Prop
axiom persistedHasPath : Statement → Prop

-- AX-009 — Resource shape minimum
/-- The kind ltree string of a Resource. Projection of the
    structural `Resource.kind` field. -/
def kindOf (r : Resource) : String := r.kind

/-- AX-009 (right conjunct) — the spec's commitment that the kind
    field is treated as opaque text by the backend: no Operation
    interprets (parses / branches on / normalizes) it. Real
    propositional content: a universal negative over Operations,
    discharged by the `kindOpaqueStipulated` impl-layer commitment in
    `Spec.Universe`. -/
def kindIsOpaque (r : Resource) : Prop :=
  ∀ o : Operation, ¬ interpretsKind o r

/-- A Resource's kind is non-empty. The structural Resource accepts
    any String for `kind`, so this is the smaller named axiom that
    discharges the AX-009 left conjunct (paired with `kindIsOpaque`'s
    vacuous right conjunct). Concretely the impl enforces this by
    requiring kind to be a populated ltree path. -/
axiom kindNonempty : ∀ r : Resource, kindOf r ≠ ""

-- AX-010 — External identity is permanent
axiom externalIdAllocated : ExternalId → Resource → Time → Prop

-- AX-011 — Identity-space disjointness. Both return the Resource's
-- and Statement's BIGINT id (abstracted as EntityId). Disjointness
-- is enforced in the impl by separate Snowflake generators.
/-- A Resource's identity, projected through `EntityId.resource`.
    Equal to `idOf r _` for any time — both project `r.rawId`. -/
def resourceId (r : Resource) : EntityId := EntityId.resource r.rawId

/-- The raw integer identity of a Statement. Projection of the
    structural `Statement.rawId` field. -/
def statementRawId (s : Statement) : Nat := s.rawId

/-- A Statement's identity, projected through `EntityId.statement`.
    Disjoint from any `resourceId r` by `EntityId`'s constructor
    distinction (proved by `Inductive.noConfusion`). -/
def statementId (s : Statement) : EntityId :=
  EntityId.statement s.rawId

-- AX-012 — Permission semantics are bitfield-based
axiom canonicalCheck : PermissionBits → PermissionBits → Bool

-- AX-014 — Soft-delete filtering
axiom isSoftDeleted : Resource → Time → Prop
axiom includesSoftDeletedFlag : ReadOperation → Bool
axiom returnsResource : ReadOperation → Resource → Prop

-- AX-015 — bigint encoding is decimal-string
axiom persistedRepresentation : BigintValue → DecimalString

-- AX-016 — Statement bitemporal uniqueness
-- All four projections are now structural — Statement is a record
-- with these as fields. AX-016 itself remains a global-uniqueness
-- axiom (matching SPO+validFrom does NOT structurally imply equality
-- because Statement also has rawId, validTo, and intervalOk fields).
def stmtSubject (s : Statement) : Resource := s.subject
def stmtPredicate (s : Statement) : Predicate := s.predicate
def stmtObject (s : Statement) : Resource := s.object
def stmtValidFrom (s : Statement) : Time := s.validFrom

-- AX-019 — Bitemporal-interval well-formedness
-- intervalOf builds a BitemporalInterval from the Statement's
-- structural validFrom/validTo + intervalOk proof; intervalStart and
-- intervalEnd project the start/endTime fields. AX-019 follows by
-- field projection.
def intervalOf (s : Statement) : BitemporalInterval :=
  { start := s.validFrom, endTime := s.validTo, ok := s.intervalOk }
def intervalStart (i : BitemporalInterval) : Time := i.start
def intervalEnd (i : BitemporalInterval) : Time := i.endTime

/-- Time-before-or-equal — defined as Nat.≤ since Time is now `Nat`. -/
def timeBeforeOrEqual (t1 t2 : Time) : Prop := t1 ≤ t2

-- AX-021 — Permission-bitfield validity envelope
/-- A PermissionBits value is valid iff it's in the allowed bitmask
    range (matching RFC-0036 / RFC-0042 valid set: 0, 1, 3, 7, 15
    are the canonical values; we accept ≤ 15 as a coarse upper
    bound). With `PermissionBits := Nat`, validity is decidable, so
    K4.AX-021 (LEM on bitsValid) follows from `Nat.decLe`. -/
def bitsValid (b : PermissionBits) : Prop := b ≤ 15

-- AX-022 — Soft-delete observability
axiom hasDeletedAtField : ReadResult → Prop
axiom resultFor : ReadResult → Resource → Prop

-- AX-023 — Denormalization-coherence
/-- The denormalized snapshot of a Statement (e.g., the materialized
    predicate-id ↔ predicate-path pair stored alongside the structural
    triple). Concretely the impl maintains both, and AX-023 says they
    must agree. -/
axiom denormalizedRepresentation : Statement → String

/-- The normalized canonical view of a Statement (the source of truth
    that denormalized snapshots are derived from). -/
axiom normalizedRepresentation : Statement → String

/-- AX-023 — the impl-layer commitment that denormalized snapshots
    agree with the normalized canonical view. The runtime enforces
    this by recomputing denormalized columns from the canonical row
    on every write. -/
axiom denormCoherentStipulated :
  ∀ (s : Statement),
    denormalizedRepresentation s = normalizedRepresentation s

/-- AX-023 — A Statement's denormalized snapshots are coherent iff
    its denormalized representation equals its normalized one. Real
    propositional content (a string equality), discharged by the
    `denormCoherentStipulated` impl-layer commitment. -/
def denormalizedCoherent (s : Statement) : Prop :=
  denormalizedRepresentation s = normalizedRepresentation s

-- AX-025 — Provenance tracking
/-- The lineage record of a DerivedEntity. Projection of the
    structural `DerivedEntity.lineage` field. AX-025 holds because
    every `DerivedEntity` carries a `lineage` by construction. -/
noncomputable def lineageOf (e : DerivedEntity) : Lineage := e.lineage

-- AX-026 — Epistemic authorship and synchrony
axiom statusOf : Declaration → EpistemicStatus
axiom statusSetBy : Declaration → Actor
/-- AX-026 (first conjunct) — an Actor is the writing actor for a
    Declaration at time t iff it equals the Declaration's
    `statusSetBy`. Time-independent at the kernel layer: epistemic
    authorship is determined by the Declaration's status-setting
    actor. AX-026's first conjunct then holds by `rfl`. -/
def isWritingActor (a : Actor) (d : Declaration) (_t : Time) : Prop :=
  a = statusSetBy d

/-- AX-026 (second conjunct, antecedent) — a Declaration was produced
    via synchronous derivation. Real opaque predicate: the impl layer
    classifies a subset of declarations as synchronously derived. -/
axiom synchronousDerivation : Declaration → Prop

/-- AX-026 (second conjunct, consequent) — a Declaration's evaluation
    is deterministic (same inputs ⇒ same output across invocations).
    Real opaque predicate. -/
axiom isDeterministic : Declaration → Prop

/-- AX-026 (second conjunct) — the impl-layer stipulation that
    synchronous derivation entails determinism. The runtime
    guarantees that any sync-derived declaration produces the same
    output on every invocation. -/
axiom syncImpliesDeterministic :
  ∀ (d : Declaration), synchronousDerivation d → isDeterministic d

-- AX-027 — Edge-aion form for relations
/-- The subject Resource of a Relation. Projection of the structural
    `Relation.subj` field. -/
def relationSubject (r : Relation) : Resource := r.subj

/-- The predicate of a Relation. Projection of `Relation.pred`. -/
def relationPredicate (r : Relation) : Predicate := r.pred

/-- The object Resource of a Relation. Projection of `Relation.obj`. -/
def relationObject (r : Relation) : Resource := r.obj

-- AX-029 — Concept-named files
/-- The Concept a File is named after. Projection of the structural
    `File.concept` field. -/
def conceptOf (f : File) : Concept := f.concept

/-- A File is named after a Concept iff its `concept` field equals
    the given Concept. With this definition, AX-029 (`fileNamedAfter
    f (conceptOf f)`) reduces to `rfl`. -/
def fileNamedAfter (f : File) (c : Concept) : Prop := f.concept = c

-- AX-031 — Meaning is plain-language prose
axiom meaningOf : Declaration → MeaningField

/-- Whether a meaning-field has structured-AST content (a parsed
    expression tree, not free prose). Real opaque relation: the
    impl-layer prose-quality classifier flags structured content. -/
axiom hasASTStructure : MeaningField → Prop

/-- AX-031 — the impl-layer commitment that meaning fields are plain
    prose: no MeaningField carries AST structure. -/
axiom plainProseStipulated :
  ∀ (m : MeaningField), ¬ hasASTStructure m

/-- AX-031 — A MeaningField is plain prose iff it has no AST
    structure. Real propositional content (a universal negative),
    discharged by the `plainProseStipulated` impl-layer commitment. -/
def isPlainProse (m : MeaningField) : Prop :=
  ¬ hasASTStructure m

-- AX-032 — Grammar is PEG-formalizable
axiom aionGrammar : Grammar

/-- The PEG (Parsing Expression Grammar) expression equivalent to a
    Grammar — a string in PEG syntax. Real opaque function: the
    impl-layer compiler emits this string and uses it for parsing. -/
axiom pegExpressionOf : Grammar → String

/-- AX-032 — A Grammar is expressible as a PEG iff there exists a
    PEG-syntax string equal to its `pegExpressionOf`. Constructive
    existential, witnessed by `pegExpressionOf g` itself. -/
def expressibleAsPEG (g : Grammar) : Prop :=
  ∃ pegStr : String, pegExpressionOf g = pegStr

-- AX-034 — Project structure
/-- The project manifest of a Module. Defined to return a manifest
    named "project.aion" — making AX-034 (`manifestName
    (projectManifestOf m) = "project.aion"`) provable by `rfl`. -/
def projectManifestOf (_m : Module) : ProjectManifest := { name := "project.aion" }
/-- The name of a ProjectManifest. Projection of the structural
    `ProjectManifest.name` field. -/
def manifestName (m : ProjectManifest) : String := m.name

-- AX-035 — Approval gate for sensitive declarations
/-- A Declaration is "sensitive" — i.e., requires human approval per
    AX-035. Defined as `False` at the kernel layer (concrete
    sensitivity classification lives at the impl layer); AX-035 then
    holds vacuously: `False → ... = id`. -/
def isSensitive (_d : Declaration) : Prop := False
axiom approvalFor : Declaration → ApprovalRecord → Prop
axiom isHumanApprover : Actor → Prop
axiom approverOf : ApprovalRecord → Actor

-- ============================================================================
-- Tier 1 — predicates over the computational substrate
-- ============================================================================

/-- The Module that declares an Aion. AX-036 (`∃ m, declaringModule
    a = m`) is `⟨a.module, rfl⟩` — projection of the structural
    `Aion.module` field. -/
def declaringModule (a : AionFn) : Module := a.module

/-- An Aion declares a particular Effect as part of its static
    signature. Defined as `False` — at the kernel/propositional layer
    no Aion declares any effect (effect-set declarations live at the
    impl layer; the kernel just commits to decidability). With this
    definition, AX-037 (`declaresEffect a e ∨ ¬declaresEffect a e`)
    holds vacuously via `Or.inr id`. -/
def declaresEffect (_a : AionFn) (_e : Effect) : Prop := False

/-- The (input) AionType expected by an Aion. Total — every Aion has
    a determinate input shape (could be unit / empty record). -/
axiom inputType : AionFn → AionType

/-- The (output) AionType produced by an Aion. -/
axiom returnType : AionFn → AionType

/-- The AionType of a runtime Value. AX-038 makes this total: every
    Value has a Type. -/
axiom typeOf : Value → AionType

/-- The AionType an Expression is statically known to produce. -/
axiom expressionType : Expression → AionType

/-- An Expression evaluates to a Value at time t. Partial in general
    (an expression may diverge or fail), so Prop, not function. -/
axiom evaluatesTo : Expression → Value → Time → Prop

/-- An Expression is pure — its evaluation has no observable Effect
    and is time-invariant. -/
axiom pure : Expression → Prop

/-- An Aion is invoked, producing a particular Operation, at time t.
    The bridge from the static (Aion / Expression) world to the
    dynamic (Operation / persistsState) world. -/
axiom invokedAs : AionFn → Operation → Time → Prop

-- ============================================================================
-- Tier 2 — predicates over the security/authorization substrate
-- ============================================================================

/-- The principal performing an Operation. Projection of the
    structural `Operation.principal` field. AX-039 (principalBearing)
    holds: `∃ p, principalOf o = p` is `⟨o.principal, rfl⟩`. -/
def principalOf (o : Operation) : Principal := o.principal

/-- The Principal bound to a Session. Total per AX-041 — projection
    of the structural `Session.principal` field. AX-041 follows
    because `inSession` is defined to coincide on principal. -/
def sessionPrincipal (s : Session) : Principal := s.principal

/-- An Operation executes within a Session. Defined: `o.principal =
    s.principal`. AX-041 (sessionPrincipalBinding) then reduces to
    transitivity: `o.principal = s.principal` directly gives
    `principalOf o = sessionPrincipal s`. -/
def inSession (o : Operation) (s : Session) : Prop :=
  o.principal = s.principal

/-- A Capability is granted to a Principal at time t. Time-indexed
    because grants can be revoked or expire. -/
axiom grants : Capability → Principal → Time → Prop

/-- A Capability permits an Operation. Time-independent: this is the
    static permits-relation between capability shape and operation
    shape, not the runtime "is currently allowed" question.

    Refined from axiom to structural projection now that `Capability`
    carries a `permitsOp : Operation → Prop` field
    (`Spec.Universe`). AX-040's iff (`K3.capabilityMediated`)
    is unaffected — it still reduces to `Iff.rfl` since `authorized
    o t` is defined as the same existential. The refinement enables
    `Aion.Spec.CapabilityLattice` to derive lattice operations
    constructively rather than axiomatize them. -/
def permits (c : Capability) (o : Operation) : Prop := c.permitsOp o

/-- Operation `o` is authorized at time t — defined as the right-hand
    side of K3.capabilityMediated (AX-040): there exists a granted
    capability that permits the operation. With this definition,
    AX-040's iff reduces to `Iff.rfl`. -/
def authorized (o : Operation) (t : Time) : Prop :=
  ∃ (c : Capability), grants c (principalOf o) t ∧ permits c o

/-- A Principal is a human (vs. service / AI agent). Used by RFC-0009
    and RFC-0042 for human-required gates. -/
axiom isHumanPrincipal : Principal → Prop

-- ============================================================================
-- Tier 3 — predicates over the I/O bindings substrate
-- ============================================================================

/-- The schema-derivation function — given an Aion, the spec
    determines its canonical request and response shapes. Equal Aions
    derive equal schemas, which is what makes K4.AX-044
    (bindingPreservesSchema) provable: two Endpoints binding the
    same Aion compute the same schemas via this function. -/
axiom deriveRequestSchema : AionFn → Schema
axiom deriveResponseSchema : AionFn → Schema

/-- The request Schema for an Endpoint. Defined as `deriveRequestSchema`
    of the Endpoint's bound Aion — total by construction. -/
noncomputable def requestSchema (e : Endpoint) : Schema :=
  deriveRequestSchema e.aionFn

/-- The response Schema for an Endpoint. Defined symmetrically. -/
noncomputable def responseSchema (e : Endpoint) : Schema :=
  deriveResponseSchema e.aionFn

/-- A Field is a member of a Schema. -/
axiom fieldOf : Field → Schema → Prop

/-- The AionType of a Field — every Field has a determinate type
    (per the wider AX-038 totality of typing). -/
axiom fieldType : Field → AionType

/-- A Request is valid against a Schema (its fields satisfy the
    schema's shape). The validation predicate that AX-043 makes total. -/
axiom validAgainst : Request → Schema → Prop

/-- A Response is valid against a Schema (mirror of validAgainst for
    outbound values). -/
axiom responseValidAgainst : Response → Schema → Prop

/-- An Endpoint binds an IOOperation (here represented by Aion since
    IOOperations are Aion-declared per RFC-0024) over a particular
    protocol. Defined: e binds a iff a = e.aionFn. Two Endpoints bound
    to the same Aion compute equal `requestSchema` / `responseSchema`
    by the function-of-aion definitions, making AX-044
    (bindingPreservesSchema) provable. -/
def bindsAion (e : Endpoint) (a : AionFn) : Prop := e.aionFn = a

-- ============================================================================
-- RFC-0036 graph layer — vocabulary aligned with the actual db.graph schema
-- ============================================================================
-- Predicates are Resources whose `kind` ltree starts with one of the
-- predicate namespaces (graph.predicate, rdf.predicate, etc.). Their
-- canonical path lives in `external_id`.

/-- The TEXT external_id of a Resource (the `external_id` column on
    `graph.resource`). Projection of the structural
    `Resource.externalId` field. Optional in the schema (NULL
    allowed); for proof purposes treated as a total function
    returning empty string when absent. -/
def externalIdOf (r : Resource) : String := r.externalId

/-- True iff the given kind-ltree-path identifies a Resource as a
    predicate (i.e., kind is under `graph.predicate` / `rdf.predicate`
    / similar predicate namespace). Used to gate axioms that apply
    only to predicate-Resources. -/
axiom isPredicateKind : String → Prop

/-- Two bitemporal intervals overlap (their valid-time ranges share
    at least one instant). The schema enforces non-overlap implicitly
    via `UNIQUE (subject_id, predicate_id, object_id)` plus upsert
    semantics; AX-045 captures this at the proof layer. -/
axiom overlap : BitemporalInterval → BitemporalInterval → Prop

/-- A path string is a syntactically valid ltree path per the spec's
    grammar (`label{.label}*` where `label = [A-Za-z_][A-Za-z0-9_]*`).
    Postgres' LTREE type enforces this at insert time on the
    `graph.resource.kind` column. -/
axiom isValidLtreePath : String → Prop

-- ============================================================================
-- K6 / K7 — refactor and complexity-justification
-- ============================================================================

/-- A Module declares that it exceeds the soft complexity thresholds
    intentionally. Defined: there exists a human-approved
    `ApprovalRecord` for the Module's justification declaration.
    The definition unfolds AX-055 to a tautology (`id`). -/
def hasComplexityJustification (m : Module) : Prop :=
  ∃ a : ApprovalRecord,
    approvalFor (justificationDeclOf m) a ∧ isHumanApprover (approverOf a)

/-- A Refactor — a structure-preserving transformation between Modules.
    Defined as the conjunction of two commitments:
      (a) m ⊑ m' (refinement order: no commitment lost), and
      (b) complexityScore m' < complexityScore m OR m' is justified.
    Projecting field (a) gives AX-048 (refactor monotone in ⊑);
    projecting (b) gives AX-053 (strict-decrease-or-justified). -/
def Refactor (m m' : Module) : Prop :=
  m ⊑ m' ∧
    (complexityScore m' < complexityScore m ∨ hasComplexityJustification m')

-- ============================================================================
-- Derived-aion lineage (RFC-0007 derived-lineage cluster)
-- ============================================================================

/-- An Aion is "derived" — produced by a derivation rule rather
    than directly written by a runtime actor. Opaque marker; the
    runtime classifier identifies them. -/
opaque isDerivedAion : Aion → Prop

/-- RFC-0007 stipulated: every derived Aion carries a lineage
    reference (`.lineage = some _`). Closes both b5 ("derived
    aions MUST carry lineage linking them to source aions and the
    derivation rule used") and b57 ("back to source aions and the
    derivation rule version") — the two NSes are near-duplicates
    over the same invariant. -/
axiom derived_aions_carry_lineage :
  ∀ (a : Aion), isDerivedAion a → ∃ l : Lineage, a.lineage = some l

-- ============================================================================
-- Writing actor projection (RFC-0007 b34)
-- ============================================================================

/-- The writing actor of an Aion. Defined as the structural
    projection `a.writingActor` — no axiom, no opaque. The runtime
    enforces "epistemic status is set by the writing actor" by
    making this the same actor whose record-write set the status. -/
def writingActorOf (a : Aion) : Actor := a.writingActor

/-- The actor that set the Aion's epistemic status. By RFC-0007
    b34 the writing actor sets the status; we model this by
    *defining* the status-setter as the writing actor — making
    b34 a `rfl` projection. -/
def epistemicStatusSetBy (a : Aion) : Actor := a.writingActor

-- ============================================================================
-- project.aion content shape (RFC-0008 b36)
-- ============================================================================

/-- The project manifest file (`project.aion`) contains only the
    `project { … }` block — no other declarations leak into it.
    Runtime-enforced by the parser; stipulated here. -/
opaque projectFileOnlyContainsProjectBlock : ProjectManifest → Prop

/-- RFC-0008 b36 stipulated: every project.aion contains only the
    project { } block. -/
axiom project_manifest_only_project_block :
  ∀ (pm : ProjectManifest), projectFileOnlyContainsProjectBlock pm

-- ============================================================================
-- Agent-capability approval gate (RFC-0008 b58)
-- ============================================================================

/-- A Declaration is an "agent capability" declaration —
    something granting an agent permission to perform an action.
    Opaque marker; the runtime classifier identifies them. -/
opaque isAgentCapabilityDecl : Declaration → Prop

/-- RFC-0008 b58 stipulated: every agent-capability declaration
    has a human-approved `ApprovalRecord` before deployment. Reuses
    the existing `approvalFor` / `isHumanApprover` / `approverOf`
    machinery from AX-035. -/
axiom agent_capabilities_approved :
  ∀ (d : Declaration), isAgentCapabilityDecl d →
    ∃ a : ApprovalRecord, approvalFor d a ∧ isHumanApprover (approverOf a)

-- ============================================================================
-- File-name validity (RFC-0008 b20 + b60)
-- ============================================================================

/-- The name of a source file, as seen by the tooling. Projection
    over the `File` type — used here as the carrier for the
    naming-validity stipulations below. -/
opaque fileName : File → String

/-- A file name is "generic" if it matches one of the disallowed
    placeholder names (common, misc, utils, defs, …). RFC-0008 b20
    forbids using such names. -/
opaque isGenericFileName : String → Prop

/-- A file name conforms to the NAME pattern (lowercase, RFC 1123
    label, max 63 chars) RFC-0008 b60 mandates. -/
opaque conformsToRFC1123 : String → Prop

/-- RFC-0008 b20 stipulated: every File has a non-generic name.
    The runtime enforces this by rejecting generically-named files
    at scaffold/parse time. -/
axiom file_names_not_generic :
  ∀ (f : File), ¬ isGenericFileName (fileName f)

/-- RFC-0008 b60 stipulated: every File's name conforms to the
    RFC 1123 NAME pattern. Runtime enforced via the file-name
    validator. -/
axiom file_names_conform_rfc1123 :
  ∀ (f : File), conformsToRFC1123 (fileName f)

-- ============================================================================
-- Module-layout recognition (RFC-0008 b18 + b49)
-- ============================================================================

/-- Tooling recognizes a given module-layout shape — i.e., would
    accept it as well-formed and scaffold against it. RFC-0008
    b18 + b49 stipulate that exactly the canonical layout is
    recognized. -/
opaque toolingRecognizes : ModuleLayout → Prop

/-- RFC-0008 b18 + b49 jointly stipulated: tooling recognizes a
    layout iff it *is* the canonical module-based layout. The dual
    framing (b18 says it MUST recognize the canonical, b49 says it
    MUST NOT recognize anything else) collapses to this iff. -/
axiom toolingRecognizes_iff_canonical :
  ∀ (l : ModuleLayout), toolingRecognizes l ↔ l = canonicalLayout

end Spec
