/- Source-backed controls for local validity and shared population admission.
   These do not model backend mutation, interval overlap, or wire identities. -/
import Spec.Axioms
set_option warningAsError true

namespace Spec.AdmissionCheck

theorem raw_empty_kind_has_no_validity :
    ¬ ((default : RawResource).kind ≠ "") := by
  intro certificate
  exact certificate rfl

private def first : Statement := {
  rawId := 0
  subject := default
  predicate := default
  object := default
  validFrom := 0
  validTo := 1
  intervalOk := Nat.zero_le 1
}

private def second : Statement := { first with rawId := 1 }

theorem locally_valid_pair_has_distinct_ids : first ≠ second := by
  intro equality
  have impossible : (0 : Nat) = 1 := congrArg Statement.rawId equality
  exact Nat.noConfusion impossible

theorem conflicting_pair_cannot_share_admission
    (population : AdmittedStatementPopulation)
    (firstMember : population.members first)
    (secondMember : population.members second) : False := by
  have equality := ax_AX_016 population first second firstMember secondMember
    rfl rfl rfl rfl
  exact locally_valid_pair_has_distinct_ids equality

theorem inhabited_nonempty_population :
    ∃ population : AdmittedStatementPopulation,
      population.members first :=
  ⟨AdmittedStatementPopulation.singleton first, rfl⟩

theorem singleton_has_overlap_certificate :
    StatementOverlapCertificate (AdmittedStatementPopulation.singleton first) :=
  singletonOverlapCertificate first

theorem valid_kind_is_nonempty (resource : Resource) : kindOf resource ≠ "" :=
  kindNonempty resource

-- Lean's built-in control fails compilation on unexpected success. These are
-- the old unguarded interfaces, not proofs that the full model is consistent.
#check_failure (show False from kindNonempty (default : Resource) rfl)
#check_failure (show first = second from ax_AX_016 first second rfl rfl rfl rfl)
#check_failure (show Resource from
  { rawId := 0, kind := "", externalId := "", kindValid := by rfl })
#check_failure (fun (population : AdmittedStatementPopulation)
    (firstMember : population.members first) =>
  (show first = second from
    ax_AX_016 population first second firstMember rfl rfl rfl rfl))
#check_failure (fun (population : AdmittedStatementPopulation)
    (firstMember : population.members first)
    (secondMember : population.members second) =>
  (show ¬ overlap (intervalOf first) (intervalOf second) from
    ax_AX_045 population first second firstMember secondMember
      locally_valid_pair_has_distinct_ids rfl rfl rfl))

#print axioms raw_empty_kind_has_no_validity
#print axioms locally_valid_pair_has_distinct_ids
#print axioms conflicting_pair_cannot_share_admission
#print axioms inhabited_nonempty_population
#print axioms singleton_has_overlap_certificate
#print axioms valid_kind_is_nonempty
#print axioms ax_AX_016
#print axioms ax_AX_045

end Spec.AdmissionCheck
