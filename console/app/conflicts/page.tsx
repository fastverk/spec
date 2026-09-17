import { projects, rowsOf } from "../../lib/corpus";
import { ConflictsClient } from "./ConflictsClient";

// Pure corpus — no op touches conflicts, so there is nothing to overlay. The
// project list comes from the corpus rather than from the conflict rows, so a
// project with no conflicts is still selectable and still says so.
export default function Page() {
  return (
    <ConflictsClient
      conflicts={rowsOf("conflicts")}
      witness={rowsOf("witness")}
      projects={projects()}
    />
  );
}
