/- The new convention is additive: independent names coexist, and the old
   public AX-034 conclusion is unchanged. These are model-level controls. -/
import Spec.Axioms
import Spec.ProjectManifest
set_option warningAsError true

namespace Spec.ProjectManifestCheck

private def first : ProjectManifestConvention := ⟨"project.example", by decide⟩
private def second : ProjectManifestConvention := ⟨"project.other", by decide⟩

example (module : Module) :
    manifestName (projectManifestFor first module) = "project.example" :=
  projectManifestFor_name first module

example (module : Module) :
    manifestName (projectManifestFor second module) = "project.other" :=
  projectManifestFor_name second module

theorem independent_conventions (module : Module) :
    manifestName (projectManifestFor first module) ≠
      manifestName (projectManifestFor second module) := by
  change "project.example" ≠ "project.other"
  decide

example (module : Module) : manifestName (projectManifestOf module) = "project.aion" :=
  ax_AX_034 module

#check_failure (show ProjectManifestConvention from ⟨"", by decide⟩)
#check_failure (fun (module : Module) =>
  (show manifestName (projectManifestFor first module) = "project.other" from
    projectManifestFor_name first module))

#print axioms projectManifestFor_name
#print axioms projectManifestFor_name_nonempty
#print axioms independent_conventions

end Spec.ProjectManifestCheck
