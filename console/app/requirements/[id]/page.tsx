import { requirements, terms } from "../../../lib/corpus";
import { RequirementClient } from "./RequirementClient";

// Every claim in the corpus gets a static page; a claim that exists only as a
// pending proposal is rendered on demand, because a requirement you just wrote
// must be reachable at its own address immediately.
export const dynamicParams = true;

export function generateStaticParams() {
  return requirements().map((r) => ({ id: String(r["requirement_id"] ?? "") }));
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RequirementClient id={id} corpusReqs={requirements()} corpusTerms={terms()} />;
}
