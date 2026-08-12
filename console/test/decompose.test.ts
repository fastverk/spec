/**
 * The decomposition rule, executed against the shared cases.
 *
 * The same file is executed against `tools/import/decompose.py`'s `extract` by
 * `conformance/check_conformance.py`, so a divergence between the console's
 * preview and the corpus decomposer fails on an ordinary PR from either side.
 */
import { describe, expect, it } from "vitest";

import cases from "../../conformance/decomposition_cases.json";
import { MAX_TERM_WORDS, advise, droppedEmphasis, extract, spans } from "../lib/decompose";

type Case = {
  name: string;
  why: string;
  predicate: string;
  terms: { surface: string; source: string }[];
};

const CASES = cases.cases as Case[];

describe("the fixture itself", () => {
  it("declares the constant both implementations must agree with", () => {
    // ⛔ Compared against the FIXTURE, not against the Python file. Two constants
    // agreeing with a third is checkable from either side; two constants agreeing
    // with each other is a coincidence nobody re-checks.
    expect(MAX_TERM_WORDS).toBe(cases.max_term_words);
  });

  it("carries both directions and names every source", () => {
    // A suite where every case expects terms could not catch a decomposer that
    // marks everything, and the no-markup case is the one that matters most.
    expect(CASES.some((c) => c.terms.length === 0)).toBe(true);
    expect(CASES.some((c) => c.terms.length > 0)).toBe(true);
    const used = new Set(CASES.flatMap((c) => c.terms.map((t) => t.source)));
    expect([...used].sort()).toEqual([...(cases.sources as string[])].sort());
  });

  it("gives every case a reason a human can read", () => {
    for (const c of CASES) expect(c.why, `${c.name} has no \`why\``).toBeTruthy();
  });
});

describe("extract", () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(extract(c.predicate)).toEqual(c.terms);
    });
  }
});

describe("spans", () => {
  // ⛔ THE INVARIANT THE HIGHLIGHTING RESTS ON. The requirement page colours each
  // marked word by the state of the term it belongs to, so a span the rule did
  // not turn into a term — or a term with no span — would be a word painted with
  // someone else's status. Both come from one scan for exactly this reason, and
  // this asserts it over every case in the fixture rather than trusting it.
  for (const c of CASES) {
    it(`agrees with extract on: ${c.name}`, () => {
      const fromSpans = spans(c.predicate)
        .filter((s) => s.isTerm)
        .map((s) => ({ surface: s.surface, source: s.source }));
      // Same set — order differs by design: extract() is rule order (every code
      // span, then every emphasis), spans() is document order.
      expect([...fromSpans].sort((a, b) => a.surface.localeCompare(b.surface))).toEqual(
        [...c.terms].sort((a, b) => a.surface.localeCompare(b.surface)),
      );
    });
  }

  it("tiles the string: slices between spans reconstruct the original", () => {
    // The renderer walks these offsets and slices the text between them. An
    // off-by-one would silently drop or duplicate the author's words.
    const p = "A `sponsor:edit` holder is never an **org admin** here.";
    let at = 0;
    let rebuilt = "";
    for (const s of spans(p)) {
      rebuilt += p.slice(at, s.start) + p.slice(s.start, s.end);
      at = s.end;
    }
    rebuilt += p.slice(at);
    expect(rebuilt).toBe(p);
  });

  it("marks a repeated surface as the same term, not a second one", () => {
    const got = spans("`public` is not the same as **public** stress.");
    expect(got).toHaveLength(2);
    expect(got[0]?.isTerm).toBe(true);
    expect(got[1]?.isTerm).toBe(false);
    // The second occurrence resolves to the FIRST one's spelling, so it picks up
    // that term's grounding state rather than rendering as an unknown word.
    expect(got[1]?.surface).toBe("public");
  });

  it("keeps an over-long bolded span visible, flagged as dropped", () => {
    // Hiding it would leave the author wondering why their bold did nothing.
    const got = spans("This **must never happen under any circumstances** ever.");
    expect(got).toHaveLength(1);
    expect(got[0]?.dropped).toBe(true);
    expect(got[0]?.isTerm).toBe(false);
  });
});

describe("advise", () => {
  it("says nothing is marked, without calling it an error", () => {
    // A requirement with no marked vocabulary is legitimate to write. It just
    // cannot be decomposed, and the author should learn that now rather than
    // from a generated TTL.
    const a = advise("Teams are flat (no nesting).");
    expect(a.kind).toBe("none");
    expect(a.message).toContain("no terms");
  });

  it("names the bolded spans the rule will drop", () => {
    const p = "This **must never happen under any circumstances** and `x` holds.";
    expect(droppedEmphasis(p)).toEqual(["must never happen under any circumstances"]);
    const a = advise(p);
    expect(a.kind).toBe("dropped");
    expect(a.kind === "dropped" && a.dropped).toEqual([
      "must never happen under any circumstances",
    ]);
  });

  it("reports a clean decomposition as terms somebody still has to ground", () => {
    const a = advise("`sponsor:edit` never implies `deploy:*`.");
    expect(a.kind).toBe("ok");
    // ⛔ Not "2 terms found ✓". Extraction names a hole; it does not fill one,
    // and a preview that read as completion would be the vacuous shape one level
    // up — a requirement that looks checkable because words were highlighted.
    expect(a.message).toContain("point at real records");
  });
});
