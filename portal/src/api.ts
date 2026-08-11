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
  /** Proposed but not yet promoted into the corpus. */
  pending?: boolean;
  pending_by?: string;
  retracted?: boolean;
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
  pending?: boolean;
  pending_by?: string;
  retracted?: boolean;
  retracted_reason?: string;
  aligns_to?: string;
  /** Cleared as not-a-term, and adopted into the corpus. */
  retired?: boolean;
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  const body = (await res.json()) as T & { corpus_version?: string };
  if (body && typeof body.corpus_version === "string" && body.corpus_version) {
    readPoint = body.corpus_version;
  }
  return body;
}

// ⚠ Pick the first ARRAY that is not `unreachable_repos`. Keying on "the first
// field that is not unreachable_repos" broke the moment payloads gained
// `corpus_version` — a string — and would have returned it as the row list.
const rowsOf = <T,>(d: Record<string, unknown>): T[] => {
  const key = Object.keys(d).find((k) => k !== "unreachable_repos" && Array.isArray(d[k]));
  return key ? ((d[key] as T[]) ?? []) : [];
};

/**
 * The corpus state the payloads were emitted from — the read point every
 * proposal must name. Captured on each fetch so a write always says which
 * corpus its author was looking at.
 */
let readPoint = "";
export const corpusVersion = () => readPoint;

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

/**
 * Submit ONE authoring op.
 *
 * ## Why a proposal rather than a save
 *
 * Nothing here edits the corpus. Every act is appended to spec's append-only log
 * with its author, checked against the closed op vocabulary, and shown as
 * PENDING until someone promotes it into the TTL the gates run over. So a person
 * can always answer "who said this, and when" — and a wrong answer is
 * withdrawable rather than baked in.
 *
 * ⛔ `parent` is the read point the author saw. spec requires it and there is no
 * default: a proposal made against a corpus you were not looking at is a
 * different proposal.
 */
export type OpKind =
  | "bindTerm" | "alignTerm" | "retractTerm"
  | "assertNS" | "amendNS" | "retractNS";

export type OpResult = {
  queued: boolean;
  log_offset: number;
  ops: Array<{ index: number; op: string; verdict: string; reason: string }>;
};

export async function submitOp(
  op: OpKind,
  fields: Record<string, string>,
  parent: string,
): Promise<OpResult> {
  const res = await fetch("/api/spec/proposal/op", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, parent, surface: "Meridian", ...fields }),
  });
  const body = (await res.json()) as OpResult & { message?: string; error?: string };
  if (!res.ok) {
    throw new Error(body.message || body.error || `write → ${res.status}`);
  }
  return body;
}

export type Proposal = {
  kind: string;
  project: string;
  subject: string;
  detail: string;
  author: string;
  /** Already in the corpus the gates run over, as opposed to still waiting. */
  adopted: boolean;
};

export const proposals = () =>
  getJson<{ proposals?: Proposal[]; records?: number; write_enabled?: boolean }>(
    "/api/spec/proposals",
  );

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
