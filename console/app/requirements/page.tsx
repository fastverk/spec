import { requirements, terms } from "../../lib/corpus";
import { RequirementsClient } from "./RequirementsClient";

export default function Page() {
  return <RequirementsClient corpusReqs={requirements()} corpusTerms={terms()} />;
}
