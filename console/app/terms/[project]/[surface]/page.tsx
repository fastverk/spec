import { requirements, terms } from "../../../../lib/corpus";
import { termEntities } from "../../../../lib/entity";
import { TermClient } from "./TermClient";

export const dynamicParams = true;

export function generateStaticParams() {
  return termEntities(terms()).map((e) => ({ project: e.project, surface: e.surface }));
}

export default async function Page({ params }: { params: Promise<{ project: string; surface: string }> }) {
  const { project, surface } = await params;
  return (
    <TermClient
      project={decodeURIComponent(project)}
      surface={decodeURIComponent(surface)}
      corpusTerms={terms()}
      corpusReqs={requirements()}
    />
  );
}
