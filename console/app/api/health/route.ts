/**
 * The operator's answer.
 *
 * "The corpus is clean" and "the payload never shipped" render identically in a
 * table: both are an empty page. This says which.
 */
import { NextResponse } from "next/server";

import { principal } from "../../../lib/auth";
import { machineCredentialHealth } from "../../../lib/auth/machine";
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
    // ⛔ WHICH CODE IS ANSWERING. `corpus_version` names the DATA this build
    // shipped with, not the BUILD, and the two come apart exactly when it
    // matters: a fix can be merged, green, and not deployed, and every other
    // number on this endpoint stays correct while the console serves the old
    // code. Measured the hard way — after a merge there was no way, from
    // outside, to tell whether production had picked it up. Page-chunk hashes
    // do not survive a different builder, so guessing from static assets
    // answers a different question than the one being asked.
    //
    // Short sha and stage only. The branch, the message and the author are not
    // facts a PUBLIC endpoint needs to hand out.
    deployment: {
      commit: (process.env["VERCEL_GIT_COMMIT_SHA"] ?? "").trim().slice(0, 7),
      // ⚠ "local" is not a Vercel stage — it is the ABSENCE of one, and saying
      // so is different from claiming production. An empty commit under stage
      // "production" means the system environment variables are not exposed,
      // which is a deployment defect and reads as one.
      stage: (process.env["VERCEL_ENV"] ?? "").trim() || "local",
    },
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
    // Whether a machine credential COULD be verified here, and how many have
    // been revoked by name. Not which implementations hold one.
    machine_credentials: machineCredentialHealth(),
    grounding_adapter: process.env["GROUNDING_ADAPTER_URL"]?.trim() ? "configured" : "unset",
    adopt_with: "tools/proposals/materialize.py",
  });
}
