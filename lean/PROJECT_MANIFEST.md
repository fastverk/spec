# Canonical project manifest name

The formal project manifest is `project.gnm`. The program owner explicitly
selected this contract and removed the requirement to preserve legacy `.aion`
filename compatibility. `ProjectManifest`, `projectManifestOf`, the K5 field,
and AX-034 now describe the same name used by Gnomon's authored RFCs.

This changes AX-034's conclusion. Consumers requiring the old filename must
stay on their historical input; the new API supplies no compatibility overload
or alternative naming policy. The theorem is a structural consequence of the
constructed manifest's name, with no new axiom. It does not prove file existence,
root placement, parsing, compiler behavior, or backend conformance.

`manifest_name_test` and `spec_framework_test` check the canonical conclusion,
the K5 projection, rejection of the old conclusion, and axiom dependencies.
Existing admission and proof-ratchet controls remain required. Gnomon owns
its affected consumer signatures, semantic reviews, and immutable pin adoption;
existing mismatches and unproved requirements cannot become proved by renaming.
