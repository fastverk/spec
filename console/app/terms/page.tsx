import { terms } from "../../lib/corpus";
import { TermsClient } from "./TermsClient";

export default function Page() {
  return <TermsClient corpusTerms={terms()} />;
}
