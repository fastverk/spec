/**
 * The door — the one callsite that appends a proposal.
 *
 * RFC-002 §4.1: *"the audit that keeps this true is small and static — there must
 * be exactly one callsite that applies ops, inside the door."* Two routes reach
 * it (`POST /api/proposal` with a nested multi-op body, `POST /api/proposal/op`
 * with the flat one-op form a declarative FormPanel can submit) and they differ
 * only in how they get from a request body to an `ops` array. Everything after
 * that — the check, the address, the verdict, the append — happens here, once,
 * so the two entry points cannot drift in what they admit.
 *
 * ## What the door decides, and what it does not
 *
 * **Decides:** well-typedness against the closed op vocabulary, and capability.
 * Both are decidable from the proposal alone, which is why they can be answered
 * synchronously by a serverless function with no query engine. The answer is an
 * `au:Verdict` — `Admitted`, `Queued` or `Rejected` — recorded in the log line
 * beside the content address.
 *
 * **Does not decide:** the gate set. RFC-002 §7.1 is explicit that "every named
 * gate returns zero rows after application" is part of admission, and equally
 * explicit that it is a `GROUP BY … HAVING` over the POST-admission graph. That
 * needs Jena, the whole corpus, and the ontology — none of which exist in a
 * Vercel function. So the gate verdict is the BUILD's, on the promotion PR,
 * where `//corpus/...` and `//rdf/...` already run. The two verdicts are
 * deliberately not conflated and neither is reported as the other.
 *
 * ⚠ Preflight-at-write was considered and deferred, for four reasons that are
 * each independently sufficient: the `spec.v1.Derivation` gate plane is
 * gRPC-only (no HTTP path a Vercel function could call), it is not deployed with
 * this console, its `Preflight` takes TRIPLES rather than ops, and it refuses a
 * parent pin and any removal — so it could not answer the question this door
 * asks even if it were reachable. See RFC-006 and RFC-003 §8.
 */
import { NextResponse } from "next/server";

import { canonicalJson } from "./canonical";
import { checkProposal, type Principal } from "./proposal";
import { appendProposal } from "./store";

/**
 * Check, address, adjudicate, append. The caller has already established the
 * principal (401) and that there is somewhere to append (503), and has lifted
 * the request body into the nested `{parent, surface?, ops, intent?}` shape.
 */
export async function admit(who: Principal, body: unknown): Promise<NextResponse> {
  const result = checkProposal(body, who);
  if (!result.ok) {
    return NextResponse.json({ error: "E_MALFORMED_PROPOSAL", message: result.message }, { status: 400 });
  }
  const checked = result.checked;

  // ⛔ Nothing is appended if ANY op is rejected. A partially-written proposal is
  // a permanent record of something nobody proposed.
  //
  // The address and the verdict are returned anyway. A refusal that names what
  // was refused is reviewable; one that says only "no" cannot be quoted in the
  // reply the author writes next, and `Rejected` with an address is exactly the
  // witness RFC-002 §7.1 promises ("graph state is untouched and a witness is
  // returned").
  //
  // ⚠ `address` is null for the one rejection that is a rejection OF the name:
  // an op carrying a value with no reproducible rendering has no pre-image, so
  // there is nothing to hash. Null, never a plausible-looking digest.
  if (checked.rejected > 0) {
    return NextResponse.json(
      {
        error: "E_OP_REJECTED",
        message: `${checked.rejected} of ${checked.ops.length} ops are not well-formed; nothing was appended`,
        verdict: checked.verdict,
        address: checked.address,
        ops: checked.ops,
      },
      { status: 422 },
    );
  }

  // Unreachable: `rejected === 0` means every op canonicalized, and a value
  // outside the ops that could not would have been a 400 from `checkProposal`.
  // Written out anyway so the type is honest rather than asserted away.
  if (checked.address === null) {
    return NextResponse.json(
      { error: "E_MALFORMED_PROPOSAL", message: "the proposal has no reproducible pre-image" },
      { status: 400 },
    );
  }

  const record = {
    address: checked.address,
    author: who.sub,
    author_email: who.email,
    canonical: checked.canonical,
    parent: checked.parent,
    surface: checked.surface,
    verdict: checked.verdict,
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
        verdict: checked.verdict,
        address: checked.address,
        // The exact bytes the address was taken over, so a caller can recompute
        // the digest without knowing the rule — and disagree with this server if
        // it is wrong. Returning only the address would make the door the sole
        // authority on its own output.
        address_pre_image: checked.addressPreImage,
        address_computed_by: "this console, at the door — see lib/address.ts and conformance/address_cases.json",
        admissible_ops: checked.admissible,
        queued_ops: checked.queued,
        ops: checked.ops,
        canonical: checked.canonical,
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
