import { requirements } from "../../lib/corpus";
import { DocumentClient } from "./DocumentClient";

export default function Page() {
  return <DocumentClient corpusReqs={requirements()} />;
}
