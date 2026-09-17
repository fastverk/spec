/**
 * The TypeScript half of the conformance suite.
 *
 * ⛔ These cases are NOT written here. They are read from `conformance/*.json`,
 * which `services/spec/src/{evaluation,overlay}.rs` also executes. Adding a case
 * to this file instead of to the fixtures defeats the entire arrangement — see
 * `conformance/README.md`.
 *
 * ⚠ This half runs unconditionally on every PR. The Rust half runs only when CI
 * can mint a token for the private plugin crates, which it frequently cannot. So
 * a green run here is NOT evidence that both implementations agree; it is
 * evidence that this one still satisfies the shared cases.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { JUDGMENTS, MACHINE_PREFIX, OUTCOMES, POSITIVE, checkEvaluation } from "../lib/evaluation";
import { Pending, type Row } from "../lib/overlay";

// ⚠ THE ONE PLACE that reaches outside console/ for the fixtures. On extraction
// into its own repo this becomes an import from the published package; nothing
// else in the console has to change.
const at = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../conformance/${name}`, import.meta.url)), "utf8"));

type EvalCase = {
  name: string;
  author: string;
  body: unknown;
  expect: "accepted" | "refused";
  message_contains?: string;
  normalized?: { population?: number };
};

type OverlayCase = {
  name: string;
  apply: "terms" | "requirements" | "proposals";
  log: Array<{ ops?: unknown[]; malformed?: string; verdict?: string }>;
  corpus: { terms?: Row[]; requirements?: Row[] };
  expect: {
    records?: number;
    row_count?: number;
    rows: Array<{ where: Row; fields?: Row; absent?: string[] }>;
  };
};

describe("conformance/evaluation_cases.json", () => {
  const doc = at("evaluation_cases.json");
  const cases: EvalCase[] = doc.cases;

  it("declares the same vocabulary the implementation does", () => {
    expect(doc.outcomes).toEqual([...OUTCOMES]);
    expect(doc.positive_outcomes).toEqual([...POSITIVE]);
    expect(doc.judgments).toEqual([...JUDGMENTS]);
    expect(doc.machine_author_prefix).toBe(MACHINE_PREFIX);
  });

  it("carries cases in both directions", () => {
    // A check only ever shown to accept is an assertion.
    expect(cases.some((c) => c.expect === "refused")).toBe(true);
    expect(cases.some((c) => c.expect === "accepted")).toBe(true);
    expect(cases.length).toBeGreaterThanOrEqual(10);

    // And for a machine principal, both directions too: a rule only ever shown
    // to refuse a machine is a lockout, and one only shown to accept is no
    // boundary at all.
    const machine = cases.filter((c) => c.author.startsWith(MACHINE_PREFIX));
    expect(machine.some((c) => c.expect === "refused")).toBe(true);
    expect(machine.some((c) => c.expect === "accepted")).toBe(true);
  });

  for (const c of cases) {
    it(c.name, () => {
      const got = checkEvaluation(c.body, c.author);
      if (c.expect === "accepted") {
        if (!got.ok) throw new Error(`expected accepted, refused with: ${got.message}`);
        if (c.normalized?.population !== undefined) {
          expect(got.evaluation.population).toBe(c.normalized.population);
        }
      } else {
        if (got.ok) throw new Error("expected refused, was accepted");
        if (c.message_contains) expect(got.message).toContain(c.message_contains);
      }
    });
  }
});

describe("conformance/overlay_cases.json", () => {
  const doc = at("overlay_cases.json");
  const cases: OverlayCase[] = doc.cases;

  // Mirrors the Rust test helper: `canonical` is the proposal body as a STRING.
  //
  // `verdict` is omitted unless a case names one — which is what a record written
  // before the door computed one looks like, and most of the fixtures are that.
  const logLine = (ops: unknown, verdict?: string) =>
    JSON.stringify({
      parent: "p0",
      author: "u-1",
      author_email: "a@b.c",
      surface: "Meridian",
      canonical: JSON.stringify({ parent: "p0", surface: "Meridian", ops }),
      ...(verdict === undefined ? {} : { verdict }),
    });

  it("has at least the cases the Rust suite has", () => {
    expect(cases.length).toBeGreaterThanOrEqual(8);
  });

  for (const c of cases) {
    it(c.name, () => {
      const lines = c.log.map((e) =>
        e.malformed !== undefined ? e.malformed : logLine(e.ops, e.verdict),
      );
      const p = Pending.fromLines(lines);

      if (c.expect.records !== undefined) expect(p.records).toBe(c.expect.records);

      const corpus = (k: "terms" | "requirements"): Row[] =>
        (c.corpus[k] ?? []).map((r) => ({ ...r }));

      let rows: Row[];
      if (c.apply === "terms") {
        rows = corpus("terms");
        p.applyTerms(rows);
      } else if (c.apply === "requirements") {
        rows = corpus("requirements");
        p.applyRequirements(rows);
      } else {
        rows = p.toRows(corpus("terms"), corpus("requirements"));
      }

      if (c.expect.row_count !== undefined) expect(rows.length).toBe(c.expect.row_count);

      for (const want of c.expect.rows) {
        const row = rows.find((r) =>
          Object.entries(want.where).every(([k, v]) => r[k] === v),
        );
        if (!row) {
          throw new Error(
            `no row matching ${JSON.stringify(want.where)} in ${JSON.stringify(rows)}`,
          );
        }
        for (const [k, v] of Object.entries(want.fields ?? {})) {
          expect(row[k], `field \`${k}\` in ${JSON.stringify(row)}`).toBe(v);
        }
        // Absence, not `=== false`: the overlay inserts no key at all when a
        // proposal matches the corpus, and THAT is the assertion — pending means
        // differs from the corpus, never "is in the log".
        for (const k of want.absent ?? []) {
          expect(row[k], `\`${k}\` must be absent in ${JSON.stringify(row)}`).toBeUndefined();
        }
      }
    });
  }
});
