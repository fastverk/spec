/**
 * The write path, nested form: a whole multi-op proposal.
 *
 * `POST /api/proposal/op` takes the flat, one-op shape a declarative meridian
 * `FormPanel` can submit. This takes the shape RFC-002 §5 actually describes —
 * `{parent, surface?, ops: [...], intent?}` — which is what an MCP client, an
 * adhoc composer, or anything reviewing a change at op granularity composes.
 *
 * ⛔ It exists because the plugin's `POST /proposal` was retired in the same
 * change. Removing a write path and not replacing it would have quietly narrowed
 * the system to one op per proposal, and a proposal is a DIFF with per-row
 * triage (§5, property 2) — "accepting three of five ops emits a derived
 * proposal against the same parent" is not expressible one op at a time.
 *
 * Both routes go through `lib/door.ts`, which is the single callsite §4.1 asks
 * for. The property that matters is testable and tested: the flat form and the
 * nested form of the same op produce the SAME content address.
 */
import { NextResponse } from "next/server";

import { NO_PRINCIPAL, principal } from "../../../lib/auth";
import { admit } from "../../../lib/door";
import { READ_ONLY_REASON, writeEnabled } from "../../../lib/store";

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
    return NextResponse.json({ error: "E_MALFORMED_PROPOSAL", message: "body is not JSON" }, { status: 400 });
  }
  return admit(who, body);
}
