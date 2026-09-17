/**
 * Recording a measurement.
 *
 * ⛔ Refuses a pass over an empty population BEFORE recording it. The corpus gate
 * catches that defect too, and so does `materialize.py` at promotion — but
 * appending it to an append-only log first and relying on a later gate to notice
 * means knowingly writing something permanent and wrong.
 *
 * Zero is an exception, never a result.
 *
 * ## Two ways a measurement gets a name
 *
 * A person, from the session (`principal()`), or a machine, from a bearer
 * credential (`machinePrincipal()`, RFC-004a §4). This is the ONLY route that
 * consults the second; `/api/proposal/op` cannot see a machine by construction.
 *
 * ⛔ A presented credential is judged, never ignored. An `Authorization` header
 * that does not verify is a 401 here and now — never a fall-back to a cookie or
 * `SPEC_AUTHOR`, which would attribute a bad token's write to whoever else was
 * signed in. And a machine may report only for the implementation its
 * credential names: a token issued for one product cannot put numbers against
 * another's claims.
 */
import { NextResponse } from "next/server";

import { NO_PRINCIPAL, principal } from "../../../lib/auth";
import { machinePrincipal } from "../../../lib/auth/machine";
import { canonicalJson } from "../../../lib/canonical";
import { checkEvaluation, evaluationRecord } from "../../../lib/evaluation";
import { READ_ONLY_REASON, appendEvaluation, writeEnabled } from "../../../lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // Who is reporting. The credential first, because presenting one is explicit;
  // a person only when none was presented at all.
  let author: string;
  let issuedFor: string | null = null;
  const machine = await machinePrincipal(req);
  if (machine.kind === "rejected") {
    return NextResponse.json({ error: machine.error, message: machine.message }, { status: 401 });
  }
  if (machine.kind === "machine") {
    // The sub IS the author: `machine:<implementation>`, self-labelling forever
    // in an append-only log, the way `dev:<email>` is.
    author = machine.sub;
    issuedFor = machine.implementation;
  } else {
    const who = await principal();
    if (!who) return NextResponse.json({ error: "E_NO_PRINCIPAL", message: NO_PRINCIPAL }, { status: 401 });
    // ⚠ The author is the email here and the sub on a proposal. Deliberately
    // different: the overlay prefers author_email and falls back to author.
    author = who.email;
  }
  if (!writeEnabled()) {
    return NextResponse.json({ error: "E_WRITE_DISABLED", message: READ_ONLY_REASON }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "E_VACUOUS_OR_MALFORMED", message: "body is not JSON" }, { status: 400 });
  }

  const checked = checkEvaluation(body, author);
  if (!checked.ok) {
    return NextResponse.json({ error: "E_VACUOUS_OR_MALFORMED", message: checked.message }, { status: 422 });
  }

  // ⛔ A credential reports for the implementation it was issued for, and no
  // other. Refused, not rewritten: silently substituting the token's name for
  // the body's would be the dropped-key failure the op door exists to prevent.
  if (issuedFor !== null && checked.evaluation.implementation !== issuedFor) {
    return NextResponse.json(
      {
        error: "E_IMPLEMENTATION_MISMATCH",
        message:
          `this credential was issued for \`${issuedFor}\` and may not report for ` +
          `\`${checked.evaluation.implementation}\`; nothing was appended`,
      },
      { status: 403 },
    );
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
        author,
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
