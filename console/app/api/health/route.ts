/**
 * The operator's answer.
 *
 * "The corpus is clean" and "the payload never shipped" render identically in a
 * table: both are an empty page. This says which.
 */
import { NextResponse } from "next/server";

import { principal } from "../../../lib/auth";
import { CORPUS_VERSION, ROUTES, rowsOf } from "../../../lib/corpus";
import { READ_ONLY_REASON, backend, evaluationRecords, proposalRecords, writeEnabled } from "../../../lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const rows: Record<string, number> = {};
  for (const r of ROUTES) rows[r] = rowsOf(r).length;

  let proposals = 0;
  let evaluations = 0;
  let logError = "";
  try {
    proposals = (await proposalRecords()).length;
    evaluations = (await evaluationRecords()).length;
  } catch (e) {
    logError = e instanceof Error ? e.message : String(e);
  }

  const who = await principal();
  return NextResponse.json({
    corpus_version: CORPUS_VERSION,
    rows,
    log_backend: backend(),
    write_enabled: writeEnabled(),
    write_disabled_because: writeEnabled() ? "" : READ_ONLY_REASON,
    log_error: logError,
    proposal_records: proposals,
    evaluation_records: evaluations,
    // Whether a write would be attributed, not who to. The identity itself is
    // not something a health endpoint should hand out.
    principal: who ? "present" : "absent",
    grounding_adapter: process.env["GROUNDING_ADAPTER_URL"]?.trim() ? "configured" : "unset",
    adopt_with: "tools/proposals/materialize.py",
  });
}
