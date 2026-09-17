/**
 * The write path, flat form: one op, checked against the closed vocabulary,
 * addressed, appended.
 *
 * Order of refusals: no principal first (401), then the write path being off
 * (503), then the body (400), then the vocabulary (422). An unauthenticated
 * write to a read-only instance is a 401, not a 503.
 *
 * ⚠ This route used to mirror `services/spec`'s `POST /proposal/op`. It no longer
 * mirrors anything: the plugin's write path is retired and answers 410, because
 * two doors that both append are two places the op vocabulary, the canonical
 * bytes and now the content address can disagree — and they DID, on `bound_value`
 * (the plugin coerced the form's string to an f64; this one does not coerce at
 * all, so the same submission got two different names). See `lib/door.ts`.
 */
import { NextResponse } from "next/server";

import { NO_PRINCIPAL, principal } from "../../../../lib/auth";
import { admit } from "../../../../lib/door";
import { fromFlat } from "../../../../lib/proposal";
import { READ_ONLY_REASON, writeEnabled } from "../../../../lib/store";

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
    return NextResponse.json({ error: "E_MALFORMED_FORM", message: "body is not JSON" }, { status: 400 });
  }

  const lifted = fromFlat(body);
  if (!lifted.ok) {
    return NextResponse.json({ error: "E_MALFORMED_FORM", message: lifted.message }, { status: 400 });
  }
  return admit(who, lifted.value);
}
