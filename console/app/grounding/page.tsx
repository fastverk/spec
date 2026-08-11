import { requirements, terms } from "../../lib/corpus";
import { GroundingClient } from "./GroundingClient";

export default function Page() {
  return <GroundingClient corpusTerms={terms()} corpusReqs={requirements()} />;
}
