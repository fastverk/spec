/**
 * The write path: one flat op, checked against the closed vocabulary, appended.
 *
 * Order of refusals matters and mirrors the Rust door (http.rs:474-539): no
 * principal first (401), then the write path being off (503), then the body
 * (400), then the vocabulary (422). An unauthenticated write to a read-only
 * instance is a 401, not a 503.
 */
import { NextResponse } from "next/server";

import { NO_PRINCIPAL, principal } from "../../../../lib/auth";
import { canonicalJson } from "../../../../lib/canonical";
import { checkProposal, fromFlat } from "../../../../lib/proposal";
import { READ_ONLY_REASON, appendProposal, writeEnabled } from "../../../../lib/store";

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
  const result = checkProposal(lifted.value, who);
  if (!result.ok) {
    return NextResponse.json({ error: "E_MALFORMED_PROPOSAL", message: result.message }, { status: 400 });
  }
  const checked = result.checked;

  // ⛔ Nothing is appended if ANY op is rejected. A partially-written proposal is
  // a permanent record of something nobody proposed.
  if (checked.rejected > 0) {
    return NextResponse.json(
      {
        error: "E_OP_REJECTED",
        message: `${checked.rejected} of ${checked.ops.length} ops are not well-formed; nothing was appended`,
        ops: checked.ops,
      },
      { status: 422 },
    );
  }

  const record = {
    parent: checked.parent,
    author: who.sub,
    author_email: who.email,
    surface: checked.surface,
    canonical: checked.canonical,
  };
  try {
    const { seq } = await appendProposal(record, canonicalJson(record));
    return NextResponse.json(
      {
        queued: true,
        log_seq: seq,
        // Named, not omitted: a caller that expected a byte offset should find out
        // why there is not one rather than read a missing key as a bug.
        log_offset: null,
        log_offset_retired: "the log is a table, not a file; a byte offset would be invented. Use log_seq.",
        admissible_ops: checked.admissible,
        queued_ops: checked.queued,
        ops: checked.ops,
        canonical: checked.canonical,
        address: null,
        address_computed_by: "the door, in the build — this console has no hash primitive",
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
