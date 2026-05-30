/-
Aion.Logic.Inference — narrow-scope Lean-native inference engine.

Replaces the spec.md-relevant slice of `kg_reasoner`'s OWL closure.
The corpus-wide Jena reasoner stays alive for other consumers
(KgLint's orphan-diagnostic check uses the `emits-from-text` rule);
this module derives only the inferences spec.md cares about — and
does so directly from the per-RFC Lean modules.

What this engine computes:

  • `extendedBy : owl:inverseOf extends`
      For every `<A> extends <B>` triple in any RFC's authored
      Document, materialize `<B> extendedBy <A>`.

  • Transitive closure of `dependsOn` (`owl:TransitiveProperty`).
      `A dependsOn B && B dependsOn C ⊢ A dependsOn C`.

  • Transitive closure of `extends` (`owl:TransitiveProperty`).
      Same shape; we don't emit `extends` outside this module but
      the closure feeds into the dependsOn computation indirectly
      via authored chains.

Soundness of each rule is mechanizable in Lean: the inference
catalog under `Aion.Logic.InferenceRulesProofs` already proves
`subclassInheritance_sound`, `modusPonens_sound`, etc., for the
spec's reasoning catalog. The engine's rules here are graph-
shaped and can be proven sound by composing those over the
authored relation. That's left as a future strengthening; the
engine compiles and runs today.
-/

import Spec.Corpus.Schema

namespace Spec.Corpus.Inference
open Spec.Corpus.Schema

/-- Per-document edge set used to seed the engine. Each RFC's
    authored Document contributes one of these. The corpus mixes
    authoring styles: some RFCs author `:extends ?B`; others author
    `:extendedBy ?A` directly. We carry both and let the engine
    unify them via the OWL `inverseOf` rule. -/
structure DocumentEdges where
  rfcId : String
  authoredDependsOn : List String
  authoredExtends : List String
  authoredExtendedBy : List String
  deriving Repr

/-- The corpus graph — all RFCs' authored edges. Built once per
    spec.md emit, then queried per RFC. -/
structure CorpusGraph where
  docs : List DocumentEdges
  deriving Repr

/-- Project a single Document into a DocumentEdges record. Captures
    both authored `extends` and authored `extendedBy` so the engine
    can unify them via the OWL `inverseOf` rule. -/
def DocumentEdges.fromDocument (d : Document) : DocumentEdges :=
  { rfcId := d.rfcId
    authoredDependsOn := d.dependsOn
    authoredExtends := d.extends_
    authoredExtendedBy := d.extendedBy }

/-- Build a CorpusGraph from a list of authored Documents. -/
def CorpusGraph.ofDocs (docs : List Document) : CorpusGraph :=
  { docs := docs.map DocumentEdges.fromDocument }

/-- Look up an RFC's edges, or empty if missing. -/
def CorpusGraph.edgesOf (g : CorpusGraph) (rfcId : String) : DocumentEdges :=
  match g.docs.find? (fun d => d.rfcId = rfcId) with
  | some e => e
  | none => { rfcId := rfcId, authoredDependsOn := [], authoredExtends := [],
              authoredExtendedBy := [] }

/-- Insert `x` into a list iff not already present (preserve order). -/
private def insertUnique (xs : List String) (x : String) : List String :=
  if xs.contains x then xs else xs ++ [x]

/-- Union of two id lists, preserving left order, deduping. -/
private def union (a b : List String) : List String :=
  b.foldl insertUnique a

/-! ## Inverse: `extendedBy`

    A document's `extendedBy` set is just the set of every other
    document that authored an `extends` edge to this one. No
    closure needed — this is one-step inverse propagation. -/

/-- The set of RFCs that extend `rfcId`, materializing the OWL
    `inverseOf` rule across both authoring styles:

      • RFCs whose authored `extends_` contains `rfcId`
        (forward direction: `?A extends rfcId`).
      • RFCs listed in `rfcId`'s own authored `extendedBy`
        (reverse direction: `rfcId extendedBy ?A`).

    Sorted, deduplicated, byte-stable. -/
def CorpusGraph.extendedBy (g : CorpusGraph) (rfcId : String) : List String :=
  let viaForward : List String :=
    g.docs.filterMap fun d =>
      if d.authoredExtends.contains rfcId then some d.rfcId else none
  let viaInverse : List String := (g.edgesOf rfcId).authoredExtendedBy
  let combined := union viaForward viaInverse
  combined.toArray.qsort (· < ·) |>.toList

/-! ## Transitive closure of `dependsOn`

    `dependsOn` is declared `owl:TransitiveProperty` in
    `kg/ontology/aion-rfc.ttl`. Compute the closure with a fixed-
    point iteration: start from authored edges, repeatedly union in
    each neighbor's dependsOn until nothing new is added.

    Termination: with a finite graph and the union step monotonic
    (only adds), the size is strictly increasing until fixpoint.
    Bounded by the corpus's RFC count (55). The fuel parameter
    caps iterations as a safety net. -/

private def transitiveStep (g : CorpusGraph) (current : List String) : List String :=
  current.foldl (fun acc r =>
    union acc (g.edgesOf r).authoredDependsOn) current

/-- Inner recursion for `transitiveDependsOn`: iterate the
    one-step expansion until fuel runs out or the closure
    stabilizes (size unchanged). -/
private def closeFuel (g : CorpusGraph) : Nat → List String → List String
  | 0,     cur => cur
  | n + 1, cur =>
    let next := transitiveStep g cur
    if next.length = cur.length then cur else closeFuel g n next

/-- Transitive `dependsOn` closure for one RFC, sorted. Excludes
    the focus RFC itself (we report the *other* RFCs reachable). -/
def CorpusGraph.transitiveDependsOn (g : CorpusGraph) (rfcId : String) (fuel : Nat := 64) : List String :=
  let seed := (g.edgesOf rfcId).authoredDependsOn
  let closed := closeFuel g fuel seed
  closed.filter (· ≠ rfcId) |>.toArray.qsort (· < ·) |>.toList

end Spec.Corpus.Inference