/- Consumer-owned naming conventions for the structural project-manifest model.
   This does not prove file existence, parsing, or implementation conformance. -/
import Spec.Predicates
set_option warningAsError true

namespace Spec

/-- A consumer selects a nonempty filename explicitly. A convention does not
    certify an actual on-disk project or override another consumer's policy. -/
structure ProjectManifestConvention where
  filename : String
  nonempty : filename ≠ ""

/-- The structural manifest model parameterized by its owning convention.
    The existing projectManifestOf/AX-034 interface retains its legacy name. -/
def projectManifestFor (convention : ProjectManifestConvention) (_module : Module) :
    ProjectManifest :=
  { name := convention.filename }

/-- Exact name preservation, with no global application-specific naming axiom. -/
theorem projectManifestFor_name (convention : ProjectManifestConvention) (module : Module) :
    manifestName (projectManifestFor convention module) = convention.filename := rfl

theorem projectManifestFor_name_nonempty
    (convention : ProjectManifestConvention) (module : Module) :
    manifestName (projectManifestFor convention module) ≠ "" := convention.nonempty

end Spec
