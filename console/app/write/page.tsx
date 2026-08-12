import { requirements } from "../../lib/corpus";
import { WriteClient } from "./WriteClient";

// The corpus is needed for three things: the disciplines a new claim may be
// filed under, the ids already taken, and the project list. All three are
// facts about the build, so they are imported rather than fetched.
export default function Page() {
  return <WriteClient corpusReqs={requirements()} />;
}
