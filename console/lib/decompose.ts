/**
 * Which words in a requirement become named holes.
 *
 * ⛔ THIS IS A PORT, AND THE ORIGINAL IS `tools/import/decompose.py`. It exists
 * because the two run at different times against the same sentence: the Python
 * decomposer runs as a batch job long after the requirement was written, so an
 * author who marked nothing gets no terms, no warning, and no way to find out
 * except by reading a generated TTL. 22 of Studio's 23 undecomposed requirements
 * are in exactly that position.
 *
 * The console shows the author what their sentence WILL decompose to while they
 * are still writing it. That is only worth doing if it is the same rule — a
 * preview that disagreed with the decomposer would be worse than no preview,
 * because it would be believed. So the cases live in
 * `conformance/decomposition_cases.json`, in a language neither implementation is
 * written in, and BOTH execute them on an ordinary PR: `check_conformance.py`
 * imports `extract` and runs it directly, `test/decompose.test.ts` runs this.
 *
 * That is a stronger position than the vacuous refusal is in. There, only the
 * TypeScript half executes the fixtures on a normal PR (RFC-003 §3.1). Here both
 * do, because a stdlib Python function needs no toolchain and no credential.
 */

/**
 * An emphasis span longer than this is a sentence fragment the author bolded for
 * stress, not a term.
 *
 * ⚠ Must equal `MAX_TERM_WORDS` in `tools/import/decompose.py`, and
 * `check_conformance.py` asserts both against the fixture's `max_term_words`
 * rather than against each other — two constants agreeing with a third is
 * checkable; two constants agreeing with each other is a coincidence nobody
 * re-checks.
 */
export const MAX_TERM_WORDS = 4;

/** Where the author's mark was. The queue renders this, so it is not internal. */
export type TermSource = "code-span" | "emphasis";

export type MarkedTerm = {
  surface: string;
  source: TermSource;
};

/**
 * One marked span, WHERE it is in the text.
 *
 * The requirement detail page renders the author's sentence with each marked
 * span coloured by whether its term has been grounded, so it needs positions the
 * rule itself has no use for. Those positions come from the SAME scan the rule
 * runs — see `scan` — rather than from a second pass with the same regexes
 * written out again, which is how two things that must agree stop agreeing.
 */
export type MarkedSpan = {
  start: number;
  /** Exclusive, and covers the marks themselves, so slices tile the string. */
  end: number;
  surface: string;
  source: TermSource;
  /**
   * Whether THIS occurrence is the one that produced the term. A surface marked
   * twice is one hole, so the second occurrence is still highlighted — it is the
   * same word — but it did not create anything.
   */
  isTerm: boolean;
  /** Emphasis longer than `MAX_TERM_WORDS`: shown struck through, not hidden. */
  dropped: boolean;
};

type RawMark = { start: number; end: number; text: string; source: TermSource };

/**
 * Every marked span in document order, before any rule is applied.
 *
 * ⚠ THE ONLY PLACE THE MARKUP SYNTAX IS WRITTEN DOWN. `extract` and `spans` are
 * both derived from this, so the terms the corpus gets and the spans the page
 * highlights cannot come apart — there is one scan and two views of it.
 */
function scan(predicate: string): RawMark[] {
  const marks: RawMark[] = [];
  for (const m of predicate.matchAll(/`([^`]+)`/g)) {
    marks.push({ start: m.index, end: m.index + m[0].length, text: (m[1] ?? "").trim(), source: "code-span" });
  }
  for (const m of predicate.matchAll(/\*\*([^*]+)\*\*/g)) {
    marks.push({ start: m.index, end: m.index + m[0].length, text: (m[1] ?? "").trim(), source: "emphasis" });
  }
  return marks;
}

const tooLong = (m: RawMark) => m.source === "emphasis" && m.text.split(/\s+/).length > MAX_TERM_WORDS;

/**
 * Every term the author marked, code spans first and emphasis after.
 *
 * Nothing is inferred. A decomposer that guessed noun phrases would produce a
 * list nobody can audit, in a system whose whole argument is that you should not
 * have to take its word for anything — so if the author marked nothing, this
 * returns nothing, and the caller's job is to say so rather than to guess.
 */
export function extract(predicate: string): MarkedTerm[] {
  const marks = scan(predicate);
  const out: MarkedTerm[] = [];
  // Case-insensitive, because `Public` and `public` are one hole. The surface
  // KEPT is the one the author wrote first — normalizing it would silently
  // rewrite their vocabulary, and the vocabulary is the thing being authored.
  const seen = new Set<string>();

  // ⚠ Both passes run to completion in order: every code span, then every
  // emphasis. Interleaving them by position would change which source label a
  // surface marked both ways receives.
  for (const source of ["code-span", "emphasis"] as const) {
    for (const m of marks) {
      if (m.source !== source || !m.text || seen.has(m.text.toLowerCase())) continue;
      // ⛔ The length test is on EMPHASIS only. A backtick is unambiguous; bold is
      // also used for stress, and a decomposer that took every bolded clause fills
      // the queue with noise people learn to ignore.
      if (tooLong(m)) continue;
      seen.add(m.text.toLowerCase());
      out.push({ surface: m.text, source });
    }
  }

  return out;
}

/**
 * Every marked span in DOCUMENT order, each resolved to the term it belongs to.
 *
 * `surface` is the canonical one — the first occurrence's spelling — so a span
 * reading `Public` resolves to the term `public` was recorded under and picks up
 * that term's grounding state. Rendering it under its own spelling would show
 * two differently-coloured copies of one hole.
 */
export function spans(predicate: string): MarkedSpan[] {
  const canonical = new Map<string, MarkedTerm>();
  for (const t of extract(predicate)) canonical.set(t.surface.toLowerCase(), t);

  const claimed = new Set<string>();
  return scan(predicate)
    .filter((m) => m.text !== "")
    .sort((a, b) => a.start - b.start)
    .map((m) => {
      const key = m.text.toLowerCase();
      const term = canonical.get(key);
      const first = Boolean(term) && !claimed.has(key);
      if (first) claimed.add(key);
      return {
        start: m.start,
        end: m.end,
        surface: term?.surface ?? m.text,
        source: m.source,
        isTerm: first,
        dropped: tooLong(m),
      };
    });
}

/**
 * What the author needs told, given what they have written so far.
 *
 * ⛔ `none` is the important one and it is NOT an error. A requirement with no
 * marked vocabulary is a legitimate thing to write — it simply cannot be
 * decomposed, cannot reach R2, and will sit in the corpus with
 * `blocked_on: "not-decomposed"` until someone comes back to it. Saying that
 * while the sentence is still in the box costs nothing; saying it in a batch job
 * costs the 23 requirements currently in that state.
 */
export type MarkupAdvice =
  | { kind: "none"; message: string }
  | { kind: "dropped"; message: string; dropped: string[] }
  | { kind: "ok"; message: string };

/** Emphasis spans the rule will silently drop, so the preview can say so. */
export function droppedEmphasis(predicate: string): string[] {
  const dropped: string[] = [];
  for (const m of predicate.matchAll(/\*\*([^*]+)\*\*/g)) {
    const s = (m[1] ?? "").trim();
    if (s && s.split(/\s+/).length > MAX_TERM_WORDS) dropped.push(s);
  }
  return dropped;
}

export function advise(predicate: string): MarkupAdvice {
  const terms = extract(predicate);
  const dropped = droppedEmphasis(predicate);

  if (terms.length === 0) {
    return {
      kind: "none",
      message:
        "Nothing here is marked, so this decomposes to no terms. It can still be " +
        "written down — it just cannot be checked by anything until someone marks " +
        "the words that carry weight.",
    };
  }
  if (dropped.length > 0) {
    return {
      kind: "dropped",
      message:
        `${dropped.length} bolded ${dropped.length === 1 ? "span is" : "spans are"} longer than ` +
        `${MAX_TERM_WORDS} words, so ${dropped.length === 1 ? "it is" : "they are"} read as stress ` +
        `rather than vocabulary and dropped.`,
      dropped,
    };
  }
  return {
    kind: "ok",
    message:
      `${terms.length} ${terms.length === 1 ? "term" : "terms"} — each one becomes a hole somebody ` +
      `has to point at real records before this can be checked.`,
  };
}
