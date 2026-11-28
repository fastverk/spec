/- Exact mathematical bitfield comparison over the Nat carrier. Raw carrier
   examples outside admitted permission levels do not prove runtime admission. -/
import Spec.Axioms
set_option warningAsError true

namespace Spec.PermissionBitfieldCheck

def expected (current required : PermissionBits) : Bool :=
  decide (Nat.land current required = required)

theorem full_contract (current required : PermissionBits) :
    canonicalCheck current required = expected current required :=
  ax_AX_012_bitwise current required

theorem accepted_iff (current required : PermissionBits) :
    canonicalCheck current required = true ↔ Nat.land current required = required :=
  canonicalCheck_all_required_bits current required

theorem zero_required (current : PermissionBits) : canonicalCheck current 0 = true := by
  simp [canonicalCheck]

theorem same_bits (current : PermissionBits) : canonicalCheck current current = true := by
  simp [canonicalCheck]

def levels : List PermissionBits := [0,1,3,7,15]

-- The 25 declared level pairs and 256 raw four-bit carrier pairs are separate.
example : levels.length = 5 := rfl
example : levels.all (fun current => levels.all (fun required =>
    canonicalCheck current required == expected current required)) = true := by decide
example : (List.range 16).all (fun current => (List.range 16).all (fun required =>
    canonicalCheck current required == expected current required)) = true := by decide

example : canonicalCheck 0 0 = true := rfl
example : canonicalCheck 15 7 = true := rfl
example : canonicalCheck 7 15 = false := rfl
example : canonicalCheck 3 3 = true := rfl
example : canonicalCheck 7 3 = true := rfl
example : canonicalCheck 1 3 = false := rfl
example : canonicalCheck 4 3 = false := rfl
example : canonicalCheck 5 3 = false := rfl
example : canonicalCheck 0 16 = false := rfl
example : canonicalCheck 256 256 = true := rfl

-- Changing the function to numeric order, overlap, equality, reversed subset,
-- clipping, or a constant must not turn these forbidden results into proofs.
#check_failure (show canonicalCheck 4 3 = true from by decide)
#check_failure (show canonicalCheck 1 3 = true from by decide)
#check_failure (show canonicalCheck 7 3 = false from by decide)
#check_failure (show canonicalCheck 0 0 = false from by decide)
#check_failure (show canonicalCheck 0 16 = true from by decide)

theorem populated_domain : levels ≠ [] ∧ canonicalCheck 15 3 = true ∧
    canonicalCheck 1 3 = false := by decide

#print axioms full_contract
#print axioms accepted_iff
#print axioms populated_domain

end Spec.PermissionBitfieldCheck
