/**
 * Recording a measurement.
 *
 * ⛔ Refuses a pass over an empty population BEFORE recording it. The corpus gate
 * catches that defect too, and so does `materialize.py` at promotion — but
 * appending it to an append-only log first and relying on a later gate to notice
 * means knowingly writing something permanent and wrong.
 *
 * Zero is an exception, never a result.
 */
import { NextResponse } from "next/server";

import { NO_PRINCIPAL, principal } from "../../../lib/auth";
import { canonicalJson } from "../../../lib/canonical";
import { checkEvaluation, evaluationRecord } from "../../../lib/evaluation";
import { READ_ONLY_REASON, appendEvaluation, writeEnabled } from "../../../lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const who = await principal();
  if (!who) return NextResponse.json({ error: "E_NO_PRINCIPAL", message: NO_PRINCIPAL }, { status: 401 });
  if (!writeEnabled()) {
    return NextResponse.json({ error: "E_WRITE_DISABLED", message: READ_ONLY_REASON }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "E_VACUOUS_OR_MALFORMED", message: "body is not JSON" }, { status: 400 });
  }

  // ⚠ The author is the email here and the sub on a proposal. Deliberately
  // different: the overlay prefers author_email and falls back to author.
  const checked = checkEvaluation(body, who.email);
  if (!checked.ok) {
    return NextResponse.json({ error: "E_VACUOUS_OR_MALFORMED", message: checked.message }, { status: 422 });
  }

  const record = evaluationRecord(checked.evaluation);
  try {
    const { seq } = await appendEvaluation(record, canonicalJson(record));
    return NextResponse.json(
      {
        recorded: true,
        log_seq: seq,
        claim: checked.evaluation.claim,
        outcome: checked.evaluation.outcome,
        population: checked.evaluation.population,
      },
      { status: 202 },
    );
  } catch (e) {
    return NextResponse.json(
      { error: "E_LOG_APPEND", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
