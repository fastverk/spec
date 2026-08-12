/**
 * Whether a requirement's words point at anything yet.
 *
 * ⛔ GROUNDED IS NOT CHECKED, AND THIS FILE IS WHERE THAT IS EASIEST TO LOSE.
 * A requirement whose every term is bound has said what its words refer to. It
 * has not run, has not examined a record, and has not passed. `stateOf` in
 * `evaluated.ts` is the other half — it gates `Enforced` on a real verdict over
 * a non-empty population, independently — and the two must never be collapsed
 * into one "green" that means both. AUTH-24 is the reason: it is one binding
 * away from fully grounded and would examine ZERO records.
 *
 * ⚠ Derived from the TERMS, not from `blocked_on`. The corpus's `blocked_on` is
 * a literal written once by `tools/import/decompose.py` and read back verbatim
 * by the read model, so binding a term today does not change it — the string
 * still says `unbound-terms` after the last term is bound. RFC-004 §5 schedules
 * making the corpus derive it too, with a drift gate holding the two answers
 * together. Until then this is the live answer and `blocked_on` is the stale one,
 * which is stated on the page rather than quietly preferred.
 */
import type { Row } from "./overlay";

export type GroundingState = "not-decomposed" | "ungrounded" | "grounded";

export type TermStanding = {
  surface: string;
  /** The reading it points at, or "" when nothing points anywhere yet. */
  boundTo: string;
  /** A proposal has changed this and nobody has promoted it. */
  pending: boolean;
  pendingBy: string;
  /** Cleared as "not a term" — decomposition is machine work that can be wrong. */
  retracted: boolean;
  retired: boolean;
  /** How many OTHER claims wait on this same surface. Binding is shared work. */
  alsoBlocks: number;
};

export type Grounding = {
  state: GroundingState;
  terms: TermStanding[];
  /** Terms that count toward grounding: neither retracted nor retired. */
  live: TermStanding[];
  bound: number;
  open: TermStanding[];
  label: string;
  hint: string;
};

const str = (r: Row, k: string) => (typeof r[k] === "string" ? r[k] : "");

/**
 * @param id     the requirement
 * @param terms  every term row in scope — the whole payload, not this claim's,
 *               because `alsoBlocks` is the number that makes grounding worth
 *               doing: `sponsor:edit` is one binding that unblocks eleven claims.
 */
export function groundingOf(id: string, terms: Row[]): Grounding {
  const waiting = new Map<string, Set<string>>();
  for (const t of terms) {
    const s = str(t, "surface");
    if (!s) continue;
    const set = waiting.get(s.toLowerCase()) ?? new Set<string>();
    set.add(str(t, "requirement_id"));
    waiting.set(s.toLowerCase(), set);
  }

  const mine = terms.filter((t) => str(t, "requirement_id").toLowerCase() === id.toLowerCase());
  const seen = new Set<string>();
  const standings: TermStanding[] = [];
  for (const t of mine) {
    const surface = str(t, "surface");
    if (!surface || seen.has(surface.toLowerCase())) continue;
    seen.add(surface.toLowerCase());
    standings.push({
      surface,
      boundTo: str(t, "bound_to"),
      pending: Boolean(t["pending"]),
      pendingBy: str(t, "pending_by"),
      retracted: Boolean(t["retracted"]),
      retired: Boolean(t["retired"]),
      alsoBlocks: Math.max(0, (waiting.get(surface.toLowerCase())?.size ?? 1) - 1),
    });
  }

  // A term cleared as "not a term" is a judgement about the DECOMPOSER, not about
  // the business, so it leaves the queue and does not hold the claim back.
  const live = standings.filter((t) => !t.retracted && !t.retired);
  const open = live.filter((t) => !t.boundTo);
  const bound = live.length - open.length;

  if (live.length === 0) {
    return {
      state: "not-decomposed",
      terms: standings,
      live,
      bound,
      open,
      label: "Not broken into terms",
      hint:
        standings.length > 0
          ? "Every term it named has been cleared as not-a-term, so nothing here points at anything."
          : "Nothing has read this for the words that carry weight. Until it does there is no hole to fill, and nothing to check.",
    };
  }

  if (open.length > 0) {
    return {
      state: "ungrounded",
      terms: standings,
      live,
      bound,
      open,
      label: `${open.length} of ${live.length} ${live.length === 1 ? "term" : "terms"} not pinned down`,
      hint:
        "A word in this requirement does not yet point at any real records, so no check can be run " +
        "against it — there is nothing yet for a check to examine.",
    };
  }

  return {
    state: "grounded",
    terms: standings,
    live,
    bound,
    open,
    label: "Every term is pinned down",
    // ⛔ The sentence that keeps this honest. Grounded is the START of being
    // checkable, and a page that stopped at "grounded ✓" would read as done.
    hint:
      "Every word points at a real population. That is not the same as checked: nothing has run " +
      "yet, and the population could still turn out to be empty — which is the one result that " +
      "must never read as a pass.",
  };
}
