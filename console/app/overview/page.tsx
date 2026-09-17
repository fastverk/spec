import { requirements, terms } from "../../lib/corpus";
import { OverviewClient } from "./OverviewClient";

// The corpus is imported, so this page is a pure function of the build.
export default function Page() {
  return <OverviewClient corpusReqs={requirements()} corpusTerms={terms()} />;
}
