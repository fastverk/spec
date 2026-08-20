/**
 * The read-model ingest contract — what a set of payloads must satisfy to be a
 * corpus this console can render.
 *
 * ## Why this is a module and not four lines inside `corpus.ts`
 *
 * `corpus.ts` imports eight payloads that ship in this repository. That is right
 * for the flagship deployment and it is the whole wall for anybody else: an
 * external consumer's corpus **cannot be committed here** (#52's data boundary),
 * so its payloads arrive from somewhere else and nothing had ever checked them.
 * The rules were real but they were welded to one set of files — `rowsOf` threw
 * on a missing array, `frozenReadPoint` threw on two corpora, and neither could
 * be pointed at anything to find out whether a consumer's payloads would pass.
 *
 * So the rules live here, over *any* payload set, and `corpus.ts` is one caller.
 * A consumer's payloads now fail with a named reason before their console
 * renders, rather than at the first page that touches the wrong route.
 *
 * ⛔ **Every failure here is a BUILD failure, never a runtime condition.** These
 * are thrown from module scope by the caller. A console that started, served a
 * page, and only then discovered its read model spans two corpora would already
 * have shown somebody a read point that is a lie — and, worse, would have let
 * them author a proposal against it. Failing to start is the correct behaviour
 * and the reason `corpus.ts` calls this at import time.
 */

/**
 * ⚠ Each payload's rows live under a field whose name is NOT always the route
 * name — `frontier` carries `stalls`, `witness` carries `parties`. The portal
 * guessed with "the first array that is not unreachable_repos", which depends on
 * JSON key insertion order and would have returned `corpus_version` had that
 * field been emitted first. `services/spec/src/readmodel.rs` has published an
 * explicit route→field table since the beginning; this is it, and
 * `tools/readmodel/check_wiring.py` compares the two.
 */
export const PAYLOAD_FIELDS = {
  claims: "claims",
  conflicts: "conflicts",
  disciplines: "disciplines",
  envelopes: "envelopes",
  frontier: "stalls",
  requirements: "requirements",
  terms: "terms",
  witness: "parties",
} as const satisfies Record<string, string>;

export type RouteName = keyof typeof PAYLOAD_FIELDS;
export const ROUTES = Object.keys(PAYLOAD_FIELDS) as RouteName[];

export type Row = Record<string, unknown>;

/** A payload set, keyed by route. What a consumer supplies. */
export type Payloads = Record<RouteName, unknown>;

export type ReadModel = {
  /** The rows of one route, as a fresh copy the caller may overlay in place. */
  rowsOf(route: RouteName): Row[];
  /** The read point every proposal must name, frozen at build. */
  corpusVersion: string;
  /** Every project named in the corpus, in a stable order. */
  projects(): string[];
};

const fail = (why: string): never => {
  throw new Error(
    // ⚠ Not "and gated in CI". Re-emitting needs rdflib, which neither the
    // console job nor the Bazel gate job installs, so the payloads' FRESHNESS is
    // checked by nothing — only their shape, by check_wiring.py. Claiming a gate
    // that does not exist is how the next person stops looking.
    `read model: ${why}. This is a BUILD defect — the payloads are emitted by ` +
      `tools/readmodel/emit_readmodel.py; see docs/consumer-onboarding.md if they ` +
      `came from a consumer's own build.`,
  );
};

/**
 * Check a payload set and hand back the accessors.
 *
 * The four refusals, and what each one is protecting:
 *
 *   a missing route          a page would render an empty table and read as
 *                            "this corpus has no conflicts", which is a
 *                            different fact from "nobody emitted conflicts"
 *   rows under the wrong key the route→field table and the payload disagree
 *   no corpus_version        every proposal must name the read point its author
 *                            saw; without one the console would have to invent
 *                            a `parent`, which defeats the check entirely
 *   two corpus_versions      the read point is a lie whichever one you pick
 */
export function ingest(payloads: Partial<Payloads>): ReadModel {
  const rowsByRoute = new Map<RouteName, Row[]>();
  const versions = new Set<string>();

  for (const route of ROUTES) {
    const payload = payloads[route];
    if (payload === undefined || payload === null || typeof payload !== "object") {
      fail(`no payload for \`${route}\``);
      continue;
    }
    const o = payload as Record<string, unknown>;
    const field = PAYLOAD_FIELDS[route];
    const rows = o[field];
    if (!Array.isArray(rows)) fail(`\`${route}\` has no \`${field}\` array`);
    rowsByRoute.set(route, rows as Row[]);

    // ⚠ Read from EVERY payload, not just the first. A set that agreed on seven
    // and disagreed on the eighth is exactly the case this exists to catch, and
    // checking one file would miss it.
    const version = o["corpus_version"];
    if (typeof version !== "string" || version === "") fail(`\`${route}\` carries no corpus_version`);
    else versions.add(version);
  }

  if (versions.size !== 1) {
    fail(`the payloads span ${versions.size} corpora: ${[...versions].sort().join(", ")}`);
  }
  const corpusVersion = [...versions][0] as string;

  return {
    rowsOf(route) {
      const rows = rowsByRoute.get(route);
      if (!rows) return fail(`no payload for \`${route}\``);
      return rows.map((r) => ({ ...r }));
    },
    corpusVersion,
    projects() {
      const seen = new Set<string>();
      for (const r of rowsByRoute.get("requirements") ?? []) {
        if (typeof r["project"] === "string") seen.add(r["project"]);
      }
      return [...seen].sort();
    },
  };
}
