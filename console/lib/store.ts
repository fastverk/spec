/**
 * The append-only logs, behind one interface.
 *
 * Three backends, chosen by environment, in this order:
 *
 *   DATABASE_URL        Neon. What a deployment uses.
 *   SPEC_PROPOSAL_LOG   a local JSONL file. Exactly the shape the Rust service
 *                       appends to, so local work is promotable by the same
 *                       `materialize.py` invocation and nothing special is
 *                       needed to try the write path.
 *   neither             READ-ONLY, and the console says so plainly rather than
 *                       letting the buttons appear to work.
 *
 * ⛔ Append only. There is no update and no delete, here or in the schema. The
 * log keeps everything forever — that is the property the overlay rests on,
 * because `pending` means "differs from the corpus", never "is in the log".
 * Correction is another record; later wins.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

import type { ProposalRecord } from "./overlay";

export type Backend = "neon" | "jsonl" | "none";

export type EvaluationRow = Record<string, unknown>;

export type Appended = { seq: number };

const url = () => process.env["DATABASE_URL"]?.trim() || "";
const proposalPath = () => process.env["SPEC_PROPOSAL_LOG"]?.trim() || "";
const evaluationPath = () => process.env["SPEC_EVALUATION_LOG"]?.trim() || "";

export function backend(): Backend {
  if (url()) return "neon";
  if (proposalPath()) return "jsonl";
  return "none";
}

export function writeEnabled(): boolean {
  return backend() !== "none";
}

/** Why the write path is off, in the words the console shows the author. */
export const READ_ONLY_REASON =
  "neither DATABASE_URL nor SPEC_PROPOSAL_LOG is set, so there is nowhere to append. " +
  "This instance is read-only.";

// ── the local JSONL backend ──────────────────────────────────────────────────

function readLines(path: string): string[] {
  if (!path || !existsSync(path)) return [];
  // split("\n"), never splitlines()-equivalent behaviour: a record carrying
  // U+2028/U+2029/U+0085 must stay one record. See tools/proposals/materialize.py.
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
}

function appendLine(path: string, line: string): number {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line + "\n", "utf8");
  return readLines(path).length;
}

// ── the Neon backend ─────────────────────────────────────────────────────────
//
// Imported lazily so a local run with no DATABASE_URL never loads the driver.

async function sql() {
  const { neon } = await import("@neondatabase/serverless");
  return neon(url());
}

// ── the interface ────────────────────────────────────────────────────────────

/** Every proposal record, oldest first. Order is the whole contract: later wins. */
export async function proposalRecords(): Promise<ProposalRecord[]> {
  const parse = (lines: string[]) =>
    lines.flatMap((l) => {
      try {
        return [JSON.parse(l) as ProposalRecord];
      } catch {
        // A malformed record is SKIPPED, not fatal: one bad line must not blind
        // the reader to the good ones written after it.
        return [];
      }
    });

  if (backend() === "neon") {
    const q = await sql();
    const rows = (await q`SELECT line FROM spec.proposal_log ORDER BY seq`) as { line: string }[];
    return parse(rows.map((r) => r.line));
  }
  return parse(readLines(proposalPath()));
}

/** Every evaluation record, oldest first. */
export async function evaluationRecords(): Promise<EvaluationRow[]> {
  const parse = (lines: string[]) =>
    lines.flatMap((l) => {
      try {
        return [JSON.parse(l) as EvaluationRow];
      } catch {
        return [];
      }
    });

  if (backend() === "neon") {
    const q = await sql();
    const rows = (await q`SELECT line FROM spec.evaluation_log ORDER BY seq`) as { line: string }[];
    return parse(rows.map((r) => r.line));
  }
  return parse(readLines(evaluationPath() || proposalPath().replace(/\.jsonl$/, "-evaluations.jsonl")));
}

/**
 * ⚠ `address` and `verdict` are the door's outputs (migration 0004), and the
 * table CHECKs that both match the line — so they are passed as columns AND
 * carried in `line`, and the two cannot disagree. A record written before 0004
 * has neither; the columns are nullable for exactly those rows and for nothing
 * else, and `tools/proposals/replay.py` can still name such a record because the
 * address is recomputable from its canonical bytes.
 */
export async function appendProposal(record: {
  address: string;
  author: string;
  author_email: string;
  canonical: string;
  parent: string;
  surface: string;
  verdict: string;
}, line: string): Promise<Appended> {
  if (backend() === "neon") {
    const q = await sql();
    const rows = (await q`
      SELECT seq FROM spec.append_proposal(
        ${line}, ${record.parent}, ${record.author},
        ${record.author_email}, ${record.surface}, ${record.canonical},
        ${record.address}, ${record.verdict})
    `) as { seq: string | number }[];
    return { seq: Number(rows[0]?.seq ?? 0) };
  }
  if (backend() === "jsonl") return { seq: appendLine(proposalPath(), line) };
  throw new Error(READ_ONLY_REASON);
}

export async function appendEvaluation(
  record: Record<string, unknown>,
  line: string,
): Promise<Appended> {
  if (backend() === "neon") {
    const q = await sql();
    const rows = (await q`
      SELECT seq FROM spec.append_evaluation(
        ${line}, ${record["claim"] as string}, ${record["project"] as string},
        ${record["implementation"] as string}, ${record["outcome"] as string},
        ${record["population"] as number | null}, ${record["query_fingerprint"] as string},
        ${record["author"] as string}, ${record["detail"] as string})
    `) as { seq: string | number }[];
    return { seq: Number(rows[0]?.seq ?? 0) };
  }
  if (backend() === "jsonl") {
    const path = evaluationPath() || proposalPath().replace(/\.jsonl$/, "-evaluations.jsonl");
    return { seq: appendLine(path, line) };
  }
  throw new Error(READ_ONLY_REASON);
}
