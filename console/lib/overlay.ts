/**
 * The pending overlay — what the log says has been proposed but not yet adopted.
 *
 * The TypeScript half of `services/spec/src/overlay.rs`. Both execute
 * `conformance/overlay_cases.json`; neither owns the cases.
 *
 * ⛔ **`pending` means "differs from the corpus", never "is in the log".** The log
 * is append-only, so a proposal stays in it forever — including after it has been
 * promoted into the TTL. Marking on presence alone would leave every adopted
 * decision reading "proposed, not yet adopted" for the rest of time, and the one
 * badge that tells an author whether their answer landed would become permanently
 * meaningless.
 *
 * Adoption (`toRows`) is the same rule from the other end: measured against the
 * corpus, never assumed from the log.
 */

export type Amend = {
  text?: string;
  discipline?: string;
  modality?: string;
  author: string;
};

export type Row = Record<string, unknown>;

/**
 * One append-only record, in the shape both the JSONL log and the Neon table
 * carry. `canonical` is the canonical JSON of the proposal body, AS A STRING —
 * it is a content-addressed blob, so it is replayed rather than re-derived.
 */
export type ProposalRecord = {
  parent?: string;
  author?: string;
  author_email?: string;
  surface?: string;
  canonical?: string;
  /** `sha256:<64 hex>` over `{author, ops, parent}` — RFC-002 §5's `Proposal.id`. */
  address?: string;
  /** `au:Verdict`. Absent on records written before the door computed one. */
  verdict?: string;
};

/**
 * ⛔ The one verdict this reader ACTS on.
 *
 * A rejected proposal is never appended — `lib/door.ts` returns 422 and writes
 * nothing — so a record carrying this verdict cannot have come from the door.
 * It can only come from a hand-edited log or a restored file, which is precisely
 * the case the verdict column exists to survive: recording the door's decision
 * is decoration unless something downstream refuses to replay a refusal.
 *
 * ⚠ Absent is NOT rejected. Every record written before the door computed a
 * verdict has no `verdict` at all, and treating those as refusals would blank
 * the overlay for the whole history.
 */
const REJECTED = "Rejected";

const str = (o: Row, k: string): string => {
  const v = o[k];
  return typeof v === "string" ? v.trim() : "";
};

/**
 * A term op's scope. Ops carry `project` optionally; without it the binding
 * applies to every project that uses the surface.
 *
 * ⚠ That fallback is a real ambiguity, not a convenience: `public` is a term in
 * more than one corpus and they need not mean the same thing.
 */
// ⚠ NUL, spelled as an escape and never as a literal character — a source file
// carrying one reads as binary to grep and to every review tool.
//
// The separator must be NUL and not a space: Rust keys these maps on a
// `(String, String)` tuple, which cannot collide, and a flattened string key
// can. Studio's surfaces include `SAVVI admin` and `Grant management`, so with a
// space separator `("studio", "a b")` and `("studio a", "b")` are one key. NUL
// cannot occur in either half: the log-line domain refuses control characters.
const SEP = "\u0000";
const scopeKey = (project: string, surface: string) => `${project}${SEP}${surface}`;

/** Exact `(project, surface)` first, then the surface-only wildcard. */
function find<T>(m: Map<string, T>, project: string, surface: string): T | undefined {
  return m.get(scopeKey(project, surface)) ?? m.get(scopeKey("", surface));
}

export class Pending {
  bound = new Map<string, { value: string; author: string; project: string; surface: string }>();
  aligned = new Map<string, { value: string; author: string; project: string; surface: string }>();
  retractedTerms = new Map<string, { value: string; author: string; project: string; surface: string }>();
  amended = new Map<string, Amend>();
  retractedNs = new Map<string, string>();
  asserted: Row[] = [];
  records = 0;

  isEmpty(): boolean {
    return (
      this.bound.size === 0 &&
      this.aligned.size === 0 &&
      this.retractedTerms.size === 0 &&
      this.amended.size === 0 &&
      this.retractedNs.size === 0 &&
      this.asserted.length === 0
    );
  }

  /**
   * Replay records in append order. A malformed record is SKIPPED, not fatal: one
   * bad record must not blind the reader to the good ones written after it.
   *
   * Later records win — the log is ordered, and a person who binds a term twice
   * means the second one. So the caller must pass them oldest-first.
   */
  static fromRecords(records: ProposalRecord[]): Pending {
    const p = new Pending();
    for (const rec of records) {
      const author =
        (rec.author_email && rec.author_email !== "" ? rec.author_email : rec.author) ?? "";
      if (rec.verdict === REJECTED) continue;
      if (typeof rec.canonical !== "string") continue;
      let body: unknown;
      try {
        body = JSON.parse(rec.canonical);
      } catch {
        continue;
      }
      const ops = (body as Row | null)?.["ops"];
      if (!Array.isArray(ops)) continue;
      p.records += 1;

      for (const raw of ops) {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
        const op = raw as Row;
        const project = str(op, "project");
        const term = str(op, "term");
        const key = scopeKey(project, term);
        switch (str(op, "op")) {
          case "bindTerm":
            p.bound.set(key, { value: str(op, "definition"), author, project, surface: term });
            break;
          case "alignTerm":
            p.aligned.set(key, { value: str(op, "aligns_to"), author, project, surface: term });
            break;
          case "retractTerm":
            p.retractedTerms.set(key, { value: str(op, "reason"), author, project, surface: term });
            break;
          case "amendNS": {
            const subject = str(op, "subject");
            const e: Amend = p.amended.get(subject) ?? { author };
            // Only non-empty values overwrite: an untouched form field means
            // "the author left this blank", not "set this to the empty string".
            const set = (k: "text" | "discipline" | "modality") => {
              const v = str(op, k);
              if (v !== "") e[k] = v;
            };
            set("text");
            set("discipline");
            set("modality");
            e.author = author;
            p.amended.set(subject, e);
            break;
          }
          case "retractNS":
            p.retractedNs.set(str(op, "subject"), author);
            break;
          case "assertNS": {
            const modality = str(op, "modality");
            p.asserted.push({
              requirement_id: str(op, "subject"),
              predicate: str(op, "text"),
              discipline: str(op, "discipline"),
              modality: modality === "" ? "MUST" : modality,
              project: str(op, "project"),
              rung: str(op, "rung"),
              author,
            });
            break;
          }
          default:
            break;
        }
      }
    }
    return p;
  }

  /** Replay a JSONL log. Used by the conformance fixtures. */
  static fromLines(lines: string[]): Pending {
    const recs: ProposalRecord[] = [];
    let skipped = 0;
    for (const line of lines) {
      if (line.trim() === "") continue;
      try {
        recs.push(JSON.parse(line) as ProposalRecord);
      } catch {
        skipped += 1;
      }
    }
    void skipped;
    return Pending.fromRecords(recs);
  }

  /** Apply to the `terms` payload, in place. */
  applyTerms(rows: Row[]): void {
    for (const o of rows) {
      const project = typeof o["project"] === "string" ? o["project"] : "";
      const surface = typeof o["surface"] === "string" ? o["surface"] : "";

      const b = find(this.bound, project, surface);
      if (b) {
        // ⛔ PENDING MEANS "differs from the corpus", not "is in the log".
        const already = typeof o["bound_to"] === "string" ? o["bound_to"] : "";
        o["bound_to"] = b.value;
        o["open"] = false;
        if (already !== b.value) {
          o["pending"] = true;
          o["pending_by"] = b.author;
        }
      }
      const a = find(this.aligned, project, surface);
      if (a) {
        o["aligns_to"] = a.value;
        o["pending"] = true;
        o["pending_by"] = a.author;
      }
      const r = find(this.retractedTerms, project, surface);
      if (r) {
        o["retracted"] = true;
        o["retracted_reason"] = r.value;
        o["pending"] = true;
        o["pending_by"] = r.author;
      }
    }
  }

  /** Apply to the `requirements` payload, in place. Appends asserted claims. */
  applyRequirements(rows: Row[]): void {
    const known = new Set<string>();
    for (const r of rows) {
      if (typeof r["requirement_id"] === "string") known.add(r["requirement_id"]);
    }

    for (const o of rows) {
      const id = typeof o["requirement_id"] === "string" ? o["requirement_id"] : "";

      const a = this.amended.get(id);
      if (a) {
        // Same rule as bindTerm: pending is a DIFFERENCE from the corpus.
        const differs = (key: string, v: string | undefined) =>
          v === undefined ? false : (typeof o[key] === "string" ? o[key] : "") !== v;
        const changed =
          differs("predicate", a.text) ||
          differs("discipline", a.discipline) ||
          differs("modality", a.modality);
        if (a.text !== undefined) o["predicate"] = a.text;
        if (a.discipline !== undefined) o["discipline"] = a.discipline;
        if (a.modality !== undefined) o["modality"] = a.modality;
        if (changed) {
          o["pending"] = true;
          o["pending_by"] = a.author;
        }
      }
      const who = this.retractedNs.get(id);
      if (who !== undefined) {
        o["retracted"] = true;
        o["pending"] = true;
        o["pending_by"] = who;
      }
    }

    // A claim asserted twice, or asserted over an id the corpus already has, must
    // not double the list. The corpus wins: an assertNS colliding with a real id
    // is an authoring mistake worth seeing rather than silently shadowing the
    // original.
    for (const a of this.asserted) {
      const id = typeof a["requirement_id"] === "string" ? a["requirement_id"] : "";
      if (id === "" || known.has(id)) continue;
      known.add(id);
      rows.push({
        ...a,
        pending: true,
        pending_by: a["author"] ?? "",
        // ⛔ The em dash and 0 are DIFFERENT: 0 means a check ran and examined
        // nothing; the dash means no check has ever run.
        population: "—",
        outcome: "NOT-EVALUATED",
        implementation: "",
        blocked_on: "not-decomposed: newly written, nothing has broken it into terms yet",
      });
    }
  }

  /**
   * The proposal set as its own payload, each row marked `adopted` or not.
   *
   * ⛔ Adoption is computed against the CORPUS, never assumed from the log. A pane
   * that counted log rows would report "2 waiting to be adopted" for work that
   * landed an hour ago, and it would never go down.
   */
  toRows(corpusTerms: Row[], corpusReqs: Row[]): Row[] {
    const field = (rows: Row[], idKey: string, id: string, key: string): string => {
      const hit = rows.find((r) => r[idKey] === id);
      const v = hit?.[key];
      return typeof v === "string" ? v : "";
    };
    const termBound = (surface: string) => field(corpusTerms, "surface", surface, "bound_to");
    const claimText = (id: string) => field(corpusReqs, "requirement_id", id, "predicate");
    const claimExists = (id: string) => corpusReqs.some((r) => r["requirement_id"] === id);

    const out: Row[] = [];
    const termRow = (
      kind: string,
      e: { value: string; author: string; project: string; surface: string },
      adopted: boolean,
    ): Row => ({
      kind,
      project: e.project,
      subject: e.surface,
      detail: e.value,
      author: e.author,
      adopted,
    });

    for (const e of this.bound.values()) {
      out.push(termRow("bindTerm", e, termBound(e.surface) === e.value));
    }
    for (const e of this.aligned.values()) {
      // The corpus carries alignment as a triple the read model does not project,
      // so this cannot be confirmed here yet and says so by staying unadopted
      // rather than guessing.
      out.push(termRow("alignTerm", e, false));
    }
    for (const e of this.retractedTerms.values()) {
      const adopted = corpusTerms.some(
        (r) => r["surface"] === e.surface && r["retired"] === true,
      );
      out.push(termRow("retractTerm", e, adopted));
    }
    for (const [id, a] of this.amended) {
      const text = a.text ?? "";
      out.push({
        kind: "amendNS",
        project: "",
        subject: id,
        detail: text,
        author: a.author,
        adopted: text !== "" && claimText(id) === text,
      });
    }
    for (const [id, who] of this.retractedNs) {
      // No projected column to confirm against, so it cannot be shown adopted.
      out.push({ kind: "retractNS", project: "", subject: id, detail: "", author: who, adopted: false });
    }
    for (const a of this.asserted) {
      const id = typeof a["requirement_id"] === "string" ? a["requirement_id"] : "";
      out.push({
        kind: "assertNS",
        project: a["project"] ?? "",
        subject: id,
        detail: a["predicate"] ?? "",
        author: a["author"] ?? "",
        adopted: claimExists(id),
      });
    }

    const key = (v: Row) => `${v["kind"] ?? ""}${v["subject"] ?? ""}`;
    out.sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
    return out;
  }
}
