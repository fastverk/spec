/- The canonical formal manifest is project.gnm. This is a structural filename
   contract, not evidence of filesystem existence or compiler conformance. -/
import Spec.Axioms
set_option warningAsError true

namespace Spec.ManifestNameCheck

theorem canonical_manifest_name (module : Module) :
    manifestName (projectManifestOf module) = "project.gnm" := ax_AX_034 module

example (module : Module) :
    manifestName (projectManifestOf module) = "project.gnm" := k5.projectManifestName module

-- The old filename cannot be recovered through the new AX-034 interface.
#check_failure (fun (module : Module) =>
  (show manifestName (projectManifestOf module) = "project.aion" from ax_AX_034 module))

#print axioms canonical_manifest_name
#print axioms ax_AX_034

end Spec.ManifestNameCheck
