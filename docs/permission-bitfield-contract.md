# Exact permission comparison

The framework's `PermissionBits` carrier remains `Nat`. The public
`canonicalCheck` type remains unchanged, but the function is now defined as
`decide ((current &&& required) = required)`. Its previous uninterpreted axiom
and reflexive theorem could not establish the bitwise comparison required by
Gnomon's RFC-0036.

`ax_AX_012_bitwise` states the complete Boolean formula;
`canonicalCheck_all_required_bits` relates acceptance to the mathematical
bitwise equality. Both follow from the definition without a new domain axiom.
The existing `ax_AX_012` reflexivity theorem and legacy
`K3_Mediated.permissionBitfield` field retain their source-compatible types.
They remain determinism statements; comparison proofs use the stronger theorem.

The permission test proves the formula for arbitrary carrier values, checks
all 25 pairs of declared levels and all 256 pairs of raw four-bit values, and
retains populated acceptance and rejection examples. Raw examples such as
`current = 4, required = 3` distinguish numerical ordering from bitwise
comparison; they do not declare those values to be admitted runtime levels.
Range/level admission and its diagnostics remain separate obligations.
The test also rejects constants, equality-only, any-overlap, reversed subset
and clipping behavior.

This correction removes one trusted predicate axiom. The axiom ratchet drops
from 92 to 91; all unrelated assumptions remain. It does not prove backend
authorization, cache/write-lock discipline, permission-level admission, or
other Graph or installer behavior. Existing release, consumer, authenticated
Note and exact-head gates remain independent. No release or deployment is included.
