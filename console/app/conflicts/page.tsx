import { rowsOf } from "../../lib/corpus";
import { ConflictsClient } from "./ConflictsClient";

// Pure corpus — no op touches conflicts, so there is nothing to overlay.
export default function Page() {
  return <ConflictsClient conflicts={rowsOf("conflicts")} witness={rowsOf("witness")} />;
}
