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
 *
 * ## `@readmodel/` — the seam a second tenant needs
 *
 * The eight imports below used to name `../../services/spec/readmodel/*.json`
 * directly, which is this repository's own corpus and the only one a console
 * could ever show. An external consumer's corpus **cannot be committed here**
 * (#52's data boundary), so a per-tenant deployment points `SPEC_READMODEL_DIR`
 * at its own payloads and `next.config.mjs` resolves `@readmodel/` there.
 *
 * ⚠ STILL STATIC IMPORTS, still resolved at build. The seam moves WHERE the
 * payloads come from and changes nothing about when: a page still cannot render
 * a `corpus_version` other than the one it shipped with. Reading them at runtime
 * from a directory would reintroduce the portal's bug with extra steps.
 *
 * ⚠ The alias lives in `next.config.mjs` and NOT in `tsconfig.json`'s `paths`.
 * Next installs `JsConfigPathsPlugin` into webpack's resolver, and it taps
 * `described-resolve`, which runs BEFORE `resolve.alias` — so a `paths` entry
 * silently wins and the override does nothing. Measured, not inferred: the first
 * attempt built cleanly against the wrong corpus and said nothing. `tsc` resolves
 * these through `types/readmodel.d.ts` instead.
 */
import claimsJson from "@readmodel/claims.json";
import conflictsJson from "@readmodel/conflicts.json";
import disciplinesJson from "@readmodel/disciplines.json";
import envelopesJson from "@readmodel/envelopes.json";
import frontierJson from "@readmodel/frontier.json";
import requirementsJson from "@readmodel/requirements.json";
import termsJson from "@readmodel/terms.json";
import witnessJson from "@readmodel/witness.json";

import { ROUTES, ingest, type Payloads, type RouteName } from "./readmodel";

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

const PAYLOADS: Payloads = {
  claims: claimsJson,
  conflicts: conflictsJson,
  disciplines: disciplinesJson,
  envelopes: envelopesJson,
  frontier: frontierJson,
  requirements: requirementsJson,
  terms: termsJson,
  witness: witnessJson,
};

/**
 * ⛔ At MODULE SCOPE, on purpose. Every refusal in `ingest` is a build failure:
 * a console that started and only then found its payloads span two corpora would
 * already have shown somebody a read point that is a lie, and let them author a
 * proposal against it.
 */
const MODEL = ingest(PAYLOADS);

export { ROUTES };
export type { RouteName };

/** The rows of one route, as a fresh copy the caller may overlay in place. */
export const rowsOf = (route: RouteName): Row[] => MODEL.rowsOf(route) as Row[];

export const requirements = () => rowsOf("requirements") as Requirement[];
export const terms = () => rowsOf("terms") as Term[];

/** The read point every proposal must name, frozen at build time. */
export const CORPUS_VERSION = MODEL.corpusVersion;

/** Every project named in the corpus, in a stable order. */
export const projects = (): string[] => MODEL.projects();
