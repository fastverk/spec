/**
 * Evaluations: how many records a check actually examined.
 *
 * The TypeScript half of `services/spec/src/evaluation.rs`. Both execute
 * `conformance/evaluation_cases.json`; neither owns the cases. See
 * `conformance/README.md` for why porting the tests alongside the logic was not
 * good enough.
 *
 * ## Why this is not a proposal
 *
 * A proposal is a person's judgement — what a word means, what a requirement
 * should say. An evaluation is a MEASUREMENT: a project ran a query in its own
 * environment and reported a count. Nobody is asked to agree with it. So it gets
 * its own append-only table rather than riding the op vocabulary.
 *
 * What travels is the count, the query fingerprint, and the outcome. Never rows:
 * spec has no data access to any project and must not acquire one by the back
 * door of "just a few examples".
 *
 * ## The door refuses a vacuous pass
 *
 * `//rdf/lint/authoring:vacuous-invariant.rq` fails a corpus where an evaluation
 * examined zero records and reports `Passes` or `Fails`, and
 * `tools/proposals/materialize.py` drops one rather than promoting it. Those
 * gates stay. But an evaluation that reaches this module is refused BEFORE it is
 * recorded, because the alternative is knowingly appending a defect to an
 * append-only table and relying on a later gate to notice.
 *
 * Zero is an exception, never a result. `Vacuous` is the honest recording of "it
 * ran and examined nothing"; `CannotBeGrounded` is "it could not run at all".
 * Both legitimately carry a population of zero. Neither is a pass.
 *
 * ## A machine reports, never judges
 *
 * A machine principal — `author` prefixed `machine:`, minted only by the
 * evaluation route from a credential (RFC-004a §4) — may report `Examined`,
 * `Vacuous` or `CannotBeGrounded`, and may not report `Passes` or `Fails`. A
 * count says how many records a check would examine; whether the claim holds
 * over them is a judgment, and a `SELECT count(*)` did not make one.
 */

/**
 * `au:Outcome` — what an evaluation may report.
 *
 * ⛔ There is no `Unknown`. An evaluation that cannot say what happened is not an
 * evaluation, and such a bucket would immediately become where anything awkward
 * went.
 *
 * ⚠ `Examined` is NOT that bucket, and the distinction is the whole reason it
 * exists. The grounding adapter measures a POPULATION and deliberately refuses to
 * decide the predicate — it returns CANNOT_BE_GROUNDED / VACUOUS / EVALUABLE and
 * never PASSES, because reporting a pass is only meaningful once the predicate
 * itself is evaluated, which nothing yet does.
 *
 * Collapsing `Examined` into `Passes` is the exact failure this pipeline is
 * about, committed at the last step. So it is a distinct outcome, and nothing
 * counts it as a pass.
 *
 * ⚠ Order and spelling are asserted against the Rust constant and the fixtures by
 * `conformance/check_conformance.py`, which runs with no toolchain.
 */
export const OUTCOMES = ["Passes", "Fails", "Examined", "Vacuous", "CannotBeGrounded"] as const;

/**
 * Outcomes that assert records were examined. A population of zero makes every
 * one of them meaningless — including `Examined`, whose whole content is "there
 * were records to look at".
 */
export const POSITIVE = ["Passes", "Fails", "Examined"] as const;

/**
 * Outcomes that are a JUDGMENT rather than a measurement. A count says how many
 * records a check would examine; whether the claim holds over them is a
 * different question, and a machine that ran `SELECT count(*)` did not answer
 * it.
 *
 * ⛔ A machine principal (`author` prefixed `MACHINE_PREFIX`) may report
 * `Examined`, `Vacuous` or `CannotBeGrounded` and may not report either of
 * these. This is the evaluation-side half of RFC-004a §4's boundary: a machine
 * reports what it measured and may not author, amend, withdraw — or judge — a
 * requirement. `Examined` is deliberately NOT here: it is the one outcome a
 * machine exists to report.
 *
 * ⚠ Asserted against the Rust constant and the fixtures by
 * `conformance/check_conformance.py`, like OUTCOMES and POSITIVE.
 */
export const JUDGMENTS = ["Passes", "Fails"] as const;

/**
 * The author prefix that marks a machine principal (RFC-004a §4). Only
 * `lib/auth/machine.ts` ever produces it, and a person's email cannot start
 * with it, so keying the rule on the string is keying it on the credential —
 * the same way agent capability is keyed on the `agent:` sub prefix.
 */
export const MACHINE_PREFIX = "machine:";

export type Outcome = (typeof OUTCOMES)[number];

export type Evaluation = {
  claim: string;
  project: string;
  implementation: string;
  outcome: Outcome;
  /** `null` is "nothing ran", which is not the same as `0`. */
  population: number | null;
  queryFingerprint: string;
  author: string;
  detail: string;
};

export type Checked =
  | { ok: true; evaluation: Evaluation }
  | { ok: false; message: string };

const str = (body: Record<string, unknown>, k: string): string => {
  const v = body[k];
  return typeof v === "string" ? v.trim() : "";
};

/**
 * Validate a submitted evaluation. The message is what the caller is shown.
 *
 * Pure: no database, no clock, no environment. That is what makes it executable
 * from a fixture file in two languages, and it is worth keeping that way.
 */
export function checkEvaluation(body: unknown, author: string): Checked {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "body is not a JSON object" };
  }
  const o = body as Record<string, unknown>;

  const claim = str(o, "claim");
  if (!claim) {
    return {
      ok: false,
      message: "`claim` is required — an evaluation of nothing is not a measurement",
    };
  }
  const implementation = str(o, "implementation");
  if (!implementation) {
    return {
      ok: false,
      message:
        "`implementation` is required — the same claim can pass in one product and be " +
        "ungroundable in another, and an unattributed count cannot tell you which",
    };
  }
  const outcome = str(o, "outcome");
  if (!(OUTCOMES as readonly string[]).includes(outcome)) {
    return {
      ok: false,
      message: `\`${outcome}\` is not an au:Outcome (expected one of ${OUTCOMES.join(", ")})`,
    };
  }

  // ⛔ A machine reports, never judges. Before the population rules, so a
  // machine's `Examined` over zero still hears "Vacuous": this rule adds a
  // refusal and removes none.
  if (author.startsWith(MACHINE_PREFIX) && (JUDGMENTS as readonly string[]).includes(outcome)) {
    return {
      ok: false,
      message:
        `\`${outcome}\` is a judgment, and a machine reports what it measured — record Examined ` +
        "with the population and let a person decide whether the claim holds",
    };
  }

  let population: number | null;
  const raw = o["population"];
  if (raw === undefined || raw === null) {
    population = null;
  } else if (typeof raw === "number" && Number.isInteger(raw)) {
    population = raw;
  } else {
    return {
      ok: false,
      message: "`population` must be an integer count of records examined",
    };
  }

  const positive = (POSITIVE as readonly string[]).includes(outcome);

  // ⛔ The two refusals this module exists for.
  if (population === null && positive) {
    return {
      ok: false,
      message:
        `\`${outcome}\` without a population is a result nobody can audit — say how many ` +
        "records were examined, or report CannotBeGrounded",
    };
  }
  if (population === 0 && positive) {
    return {
      ok: false,
      message:
        `examined 0 records but reports ${outcome}. An invariant that examined nothing ` +
        "succeeds trivially; record it as Vacuous, which is what it is",
    };
  }
  if (population !== null && population < 0) {
    return { ok: false, message: "`population` cannot be negative" };
  }

  return {
    ok: true,
    evaluation: {
      claim,
      project: str(o, "project"),
      implementation,
      outcome: outcome as Outcome,
      population,
      queryFingerprint: str(o, "query_fingerprint"),
      author,
      detail: str(o, "detail"),
    },
  };
}

/**
 * The record as it is stored and as it is exported back to JSONL.
 *
 * ⚠ Key names are snake_case and must stay that way: `tools/proposals/
 * materialize.py` reads exactly these, and promotion is what puts a measurement
 * in front of the gates.
 */
export function evaluationRecord(e: Evaluation): Record<string, unknown> {
  return {
    claim: e.claim,
    project: e.project,
    implementation: e.implementation,
    outcome: e.outcome,
    population: e.population,
    query_fingerprint: e.queryFingerprint,
    author: e.author,
    detail: e.detail,
  };
}
