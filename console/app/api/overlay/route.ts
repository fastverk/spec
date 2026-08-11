/**
 * The pending overlay, and only the overlay.
 *
 * The corpus is imported at build time and rendered statically; this route
 * carries the one thing that cannot be — what the log says has been proposed but
 * not yet adopted.
 *
 * ⛔ NEVER CACHED. The overlay is rebuilt on read rather than invalidated, so a
 * write is visible on the very next request without an invalidation protocol to
 * get wrong. A stale overlay tells an author their write did not land.
 */
import { NextResponse } from "next/server";

import { CORPUS_VERSION, requirements, terms } from "../../../lib/corpus";
import { Evaluated } from "../../../lib/evaluated";
import { Pending } from "../../../lib/overlay";
import { READ_ONLY_REASON, evaluationRecords, proposalRecords, writeEnabled } from "../../../lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const pending = Pending.fromRecords(await proposalRecords());
    const measured = Evaluated.fromRecords(await evaluationRecords());

    const reqRows = requirements();
    pending.applyRequirements(reqRows);
    measured.apply(reqRows);

    const termRows = terms();
    pending.applyTerms(termRows);

    return NextResponse.json({
      corpus_version: CORPUS_VERSION,
      requirements: reqRows,
      terms: termRows,
      proposals: pending.toRows(terms(), requirements()),
      evaluations: measured.toRows(),
      records: pending.records,
      evaluation_records: measured.records,
      write_enabled: writeEnabled(),
      write_disabled_because: writeEnabled() ? "" : READ_ONLY_REASON,
      adopt_with: "tools/proposals/materialize.py",
    });
  } catch (e) {
    // ⛔ "Could not ask" is not "nothing is pending". The client renders this as
    // a missing answer and keeps showing the corpus, rather than showing a clean
    // page that means something it does not.
    return NextResponse.json(
      {
        error: "E_OVERLAY_UNAVAILABLE",
        message: e instanceof Error ? e.message : String(e),
        corpus_version: CORPUS_VERSION,
      },
      { status: 503 },
    );
  }
}
