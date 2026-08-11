/**
 * The read model, imported rather than fetched.
 *
 * ⛔ THE ONE PLACE the console reaches outside itself. On extraction into its own
 * repo these eight imports become one import from the published package and
 * nothing else changes.
 *
 * The corpus is GENERATED and gated in CI (invariant ⑥). Importing it means a
 * page cannot render a `corpus_version` other than the one it shipped with — the
 * payloads and the read point are one immutable artifact, redeployed together.
 *
 * The portal computed the read point at RUNTIME instead: a module-global
 * `readPoint` (portal/src/api.ts:129) reassigned by whichever GET landed last.
 * Three failures follow from that and none is visible. Before the first
 * successful GET it is `""`, so the first write of a session submits `parent: ""`
 * and is refused for a form the author filled in correctly. Two payloads from
 * different corpora would silently disagree. And a failed GET leaves the previous
 * value in place, so a write can name a read point the author is no longer
 * looking at.
 */
import claimsJson from "../../services/spec/readmodel/claims.json";
import conflictsJson from "../../services/spec/readmodel/conflicts.json";
import disciplinesJson from "../../services/spec/readmodel/disciplines.json";
import envelopesJson from "../../services/spec/readmodel/envelopes.json";
import frontierJson from "../../services/spec/readmodel/frontier.json";
import requirementsJson from "../../services/spec/readmodel/requirements.json";
import termsJson from "../../services/spec/readmodel/terms.json";
import witnessJson from "../../services/spec/readmodel/witness.json";

import type { Row } from "./overlay";

export type Requirement = Row & {
  requirement_id: string;
  predicate: string;
  discipline: string;
  modality: string;
  rung: string;
  implementation: string;
  /** A STRING. `"—"` is the never-evaluated sentinel and is NOT `"0"`. */
  population: string;
  outcome: string;
  blocked_on: string;
  project: string;
};

export type Term = Row & {
  requirement_id: string;
  term_id: string;
  surface: string;
  term_source: string;
  bound_to: string;
  open: boolean;
  retired: boolean;
  project: string;
};

/**
 * ⚠ Each payload's rows live under a field whose name is NOT always the route
 * name — `frontier` carries `stalls`, `witness` carries `parties`. The portal
 * guessed with `rowsOf`, "the first array that is not unreachable_repos", which
 * depends on JSON key insertion order and would have returned `corpus_version`
 * had that field been emitted first. The server has published an explicit
 * route→field table since the beginning (readmodel.rs:49-58); this is it.
 */
const PAYLOADS = {
  claims: [claimsJson, "claims"],
  conflicts: [conflictsJson, "conflicts"],
  disciplines: [disciplinesJson, "disciplines"],
  envelopes: [envelopesJson, "envelopes"],
  frontier: [frontierJson, "stalls"],
  requirements: [requirementsJson, "requirements"],
  terms: [termsJson, "terms"],
  witness: [witnessJson, "parties"],
} as const satisfies Record<string, readonly [unknown, string]>;

export type RouteName = keyof typeof PAYLOADS;
export const ROUTES = Object.keys(PAYLOADS) as RouteName[];

/** The rows of one route, as a fresh copy the caller may overlay in place. */
export function rowsOf(route: RouteName): Row[] {
  const [payload, field] = PAYLOADS[route];
  const rows = (payload as Record<string, unknown>)[field];
  if (!Array.isArray(rows)) {
    // The route→field table and the payload disagree, which is a build defect,
    // not a runtime condition.
    throw new Error(`readmodel: ${route}.json has no \`${field}\` array`);
  }
  return (rows as Row[]).map((r) => ({ ...r }));
}

export const requirements = () => rowsOf("requirements") as Requirement[];
export const terms = () => rowsOf("terms") as Term[];

/**
 * The read point every proposal must name, frozen at build time.
 *
 * Payloads from two corpora in one bundle means the read point is a lie whichever
 * one you pick, so that fails the BUILD rather than a request.
 */
function frozenReadPoint(): string {
  const seen = [
    ...new Set(
      Object.values(PAYLOADS).map(
        ([p]) => (p as { corpus_version?: string }).corpus_version ?? "",
      ),
    ),
  ];
  if (seen.length !== 1) {
    throw new Error(`read model spans ${seen.length} corpora: ${seen.join(", ")}`);
  }
  const only = seen[0];
  if (!only) throw new Error("read model carries no corpus_version");
  return only;
}

export const CORPUS_VERSION = frozenReadPoint();

/** Every project named in the corpus, in a stable order. */
export function projects(): string[] {
  const seen = new Set<string>();
  for (const r of rowsOf("requirements")) {
    if (typeof r["project"] === "string") seen.add(r["project"]);
  }
  return [...seen].sort();
}
