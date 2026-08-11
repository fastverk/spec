/**
 * The two services the portal reads, and the boundary between them.
 *
 * `spec` holds what was promised. A PROJECT holds the data those promises are
 * about and answers questions about it in its own environment — spec never
 * queries a product database, so the portal talks to both rather than letting
 * one proxy the other. Both are proxied in vite.config.ts.
 */

export type Requirement = {
  project: string;
  requirement_id: string;
  /** The sentence itself. */
  predicate: string;
  discipline: string;
  modality: string;
  rung: string;
  implementation: string;
  /** "—" when nothing has ever checked it; "0" when a check examined nothing. */
  population: string;
  outcome: string;
  blocked_on: string;
};

export type Discipline = {
  project: string;
  discipline: string;
  claim_count: number;
  dark: number;
  dark_pct: number;
  typed?: number;
  typed_pct?: number;
};

export type Conflict = {
  project: string;
  conflict: string;
  kind?: string;
  witness?: string;
  owner?: string;
  resolution?: string;
  parties?: string;
};

export type Spec = {
  repo: string;
  module: string;
  path: string;
  /** The Bazel target that verifies it; "" when the source has no verifier. */
  target: string;
  lang: string;
  kind: string;
  status: string;
  sorry_count: number;
};

export type Candidate = {
  locator: string;
  label: string;
  source: string;
  available: boolean;
  count: number | null;
  queryFingerprint: string;
  caveat: string;
  examples: Array<{ label: string; detail: string }>;
};

export type ProbeResult = {
  invariantId: string;
  term: string;
  implementation: string;
  candidates: Candidate[];
};

/**
 * A term a requirement depends on, read off the author's own markup by
 * tools/import/decompose.py. `open` means nothing has been bound to it yet.
 */
export type Term = {
  project: string;
  requirement_id: string;
  term_id: string;
  surface: string;
  /** "code-span" or "emphasis" — how the author marked it. */
  term_source: string;
  bound_to: string;
  open: boolean;
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

const rowsOf = <T,>(d: Record<string, unknown>): T[] => {
  const key = Object.keys(d).find((k) => k !== "unreachable_repos");
  return key ? ((d[key] as T[]) ?? []) : [];
};

export const requirements = () =>
  getJson<Record<string, unknown>>("/api/spec/requirements").then(rowsOf<Requirement>);
export const disciplines = () =>
  getJson<Record<string, unknown>>("/api/spec/disciplines").then(rowsOf<Discipline>);
export const conflicts = () =>
  getJson<Record<string, unknown>>("/api/spec/conflicts").then(rowsOf<Conflict>);
export const specs = () =>
  getJson<Record<string, unknown>>("/api/spec/specs").then(rowsOf<Spec>);
export const terms = () =>
  getJson<Record<string, unknown>>("/api/spec/terms").then(rowsOf<Term>);

/**
 * Ask a project what each reading of a term would match.
 *
 * The adapter is a separate service and may simply not be running — a
 * legitimate state to render, not an error to swallow. "No adapter" and "the
 * term matches nothing" are different facts, and the design turns on not
 * collapsing them.
 */
export async function probe(invariantId: string, term: string): Promise<ProbeResult> {
  const res = await fetch("/api/ground/probe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invariantId, term, maxExamples: 3 }),
  });
  // ⛔ 400 is NOT an outage. The adapter answered, and its answer was "no
  // reading has been proposed for this term" — the honest state for 57 of
  // Studio's 60 surfaces. Rendering that as a failed request would tell a
  // product owner the system is broken when it is merely being truthful about
  // work nobody has done yet.
  if (res.status === 400) throw new NoReadingProposed(term);
  if (!res.ok) throw new Error(`adapter → ${res.status}`);
  return (await res.json()) as ProbeResult;
}

export class NoReadingProposed extends Error {
  constructor(readonly term: string) {
    super(`no reading proposed for "${term}"`);
    this.name = "NoReadingProposed";
  }
}

/**
 * The four states a product owner sees. R0–R5 is how the machine decides what
 * counts as evidence and never appears here.
 *
 * ⛔ Nothing currently reaches ENFORCED, and that is a fact about the estate
 * rather than a gap in this mapping: no requirement has a check attached, so
 * every row lands in AGREED at best.
 */
export type State = "Draft" | "In question" | "Agreed" | "Enforced";

export function stateOf(r: Requirement): State {
  if (r.outcome && r.outcome !== "NOT-EVALUATED" && r.population !== "—") return "Enforced";
  if (r.blocked_on) return "In question";
  return "Agreed";
}
