/**
 * Measurements, replayed onto the requirements payload.
 *
 * Port of `Evaluated` (services/spec/src/evaluation.rs:145-237). Kept separate
 * from `overlay.ts` for the same reason the two logs are separate tables: a
 * judgement and a measurement are different kinds of fact.
 */
import type { Row } from "./overlay";

export class Evaluated {
  /**
   * Keyed `(claim, implementation)`. Later wins — re-running a check is how drift
   * is detected, and the current answer is the recent one.
   *
   * ⚠ NUL-separated, spelled as an escape. A space would collide, and the record
   * carries its own `claim` anyway so nothing ever parses this key back apart.
   */
  byClaim = new Map<string, Row>();
  records = 0;

  static fromRecords(records: Row[]): Evaluated {
    const out = new Evaluated();
    for (const rec of records) {
      const claim = typeof rec["claim"] === "string" ? rec["claim"] : "";
      const imp = typeof rec["implementation"] === "string" ? rec["implementation"] : "";
      if (claim === "") continue;
      out.records += 1;
      out.byClaim.set(`${claim}\u0000${imp}`, rec);
    }
    return out;
  }

  isEmpty(): boolean {
    return this.byClaim.size === 0;
  }

  /**
   * Overlay onto the `requirements` payload.
   *
   * ⚠ Only the pending BADGE is gated on adoption. A corpus that already carries
   * an adopted evaluation wins, for the same reason pending bindings defer to
   * adopted ones: the log keeps every record forever, and letting it overwrite
   * the corpus would make the two disagree with the log always winning.
   */
  apply(rows: Row[]): void {
    for (const o of rows) {
      const id = typeof o["requirement_id"] === "string" ? o["requirement_id"] : "";
      // ⚠ Match on the record's own `claim`, never by taking the key apart. The
      // Rust overlay picks `candidates.first()` out of a HashMap, which is
      // NONDETERMINISTIC when one claim has evaluations from two
      // implementations. Insertion order here is log order, so this takes the
      // LATEST — the same rule the map itself uses.
      let ev: Row | undefined;
      for (const v of this.byClaim.values()) {
        if (v["claim"] === id) ev = v;
      }
      if (!ev) continue;

      // `"—"` is the never-evaluated sentinel; anything else means the corpus
      // already carries a measurement, so this one is adopted.
      const adopted = (typeof o["population"] === "string" ? o["population"] : "—") !== "—";
      const pop = ev["population"];
      o["population"] = typeof pop === "number" ? String(pop) : "—";
      o["outcome"] = ev["outcome"] ?? "NOT-EVALUATED";
      o["implementation"] = ev["implementation"] ?? "";
      if (!adopted) {
        o["evaluation_pending"] = true;
        o["evaluated_by"] = ev["author"] ?? "";
      }
    }
  }

  toRows(): Row[] {
    return [...this.byClaim.values()].sort((a, b) => {
      const x = String(a["claim"] ?? "");
      const y = String(b["claim"] ?? "");
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }
}

/**
 * The four-state model.
 *
 * ⛔ A measurement is not enforcement, and a VACUOUS one is the opposite of it.
 * An earlier read of this said "an outcome exists and a population exists ⇒
 * Enforced", which badged AUTH-24 **Enforced** off an evaluation that examined
 * ZERO records — the exact flattering failure the population number exists to
 * expose, displayed as the strongest state in the product.
 *
 * Only a real verdict over a non-empty population can be Enforced. This is the
 * display half of the vacuous refusal, and it is independent of the door's.
 */
const VERDICTS = ["Passes", "Fails"];

export type State = "Draft" | "In question" | "Agreed" | "Enforced";

export function stateOf(r: Row): State {
  const raw = typeof r["population"] === "string" ? r["population"] : "—";
  const n = Number(raw);
  const measured = raw !== "—" && Number.isFinite(n);
  const outcome = typeof r["outcome"] === "string" ? r["outcome"] : "";
  if (measured && n > 0 && VERDICTS.includes(outcome)) return "Enforced";
  if (r["blocked_on"]) return "In question";
  return "Agreed";
}

/** How a measurement reads, or `null` when none has ever run. */
export function measurement(r: Row): { label: string; tone: "ok" | "warn" | "bad" } | null {
  const pop = typeof r["population"] === "string" ? r["population"] : "—";
  if (pop === "—") return null;
  const outcome = typeof r["outcome"] === "string" ? r["outcome"] : "";
  if (outcome === "Vacuous") return { label: "Examines nothing", tone: "bad" };
  if (outcome === "CannotBeGrounded") return { label: "Cannot run here", tone: "bad" };
  if (outcome === "Examined") return { label: `${pop} records, undecided`, tone: "warn" };
  return { label: `${pop} records · ${outcome}`, tone: "ok" };
}
