import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { extract } from "../../../console/lib/decompose";
import { overlay, submitOp } from "../lib/console";

/**
 * The only write this agent has, and the only write it is permitted.
 *
 * ⛔ `assertNS` AT R0 IS EXACTLY THE AGENT CAPABILITY. `console/lib/proposal.ts`
 * rejects every agent op that is not `assertNS`, and then rejects an `assertNS`
 * at any rung but R0, before the capability table is consulted. That rule is not
 * amended to make this agent work — it is left enforced, and this agent is built
 * to need nothing more. Every other op is absent rather than denied, because a
 * tool that does not exist is a stronger refusal than one that argues.
 *
 * So there is no bindTerm here, no amendNS, no retractNS, no evaluation. The
 * agent proposes SENTENCES. People decide what the words point at.
 */
export default defineTool({
  description:
    "Propose a new requirement. Stops for a person before anything is recorded — you are " +
    "drafting, they are deciding. The proposal is recorded under THEIR name, not yours, and " +
    "it lands as pending against the corpus rather than in it.",
  // ⛔ always(), not once(). `once()` would auto-approve every later proposal in
  // the session after one sign-off, which for an append-only log with no DELETE
  // means one click authorising an unbounded number of permanent rows.
  approval: always(),
  inputSchema: z.object({
    subject: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/, "lowercase id, e.g. `auth-70`")
      .describe("The requirement id. Must not already exist."),
    text: z
      .string()
      .min(10)
      .describe(
        "The requirement, with the words that carry weight marked in `code spans` or " +
          "**emphasis**. This markup is the entire input to decomposition.",
      ),
    discipline: z.string().describe("An existing discipline from the corpus."),
    modality: z.enum(["MUST", "MUST_NOT", "SHOULD", "SHOULD_NOT", "MAY"]).default("MUST"),
    project: z.string().describe("The project this claim belongs to, e.g. `studio`."),
  }),
  async execute(input) {
    const o = await overlay();

    if (!o.write_enabled) {
      return { recorded: false, reason: o.write_disabled_because };
    }

    // The console would refuse a duplicate id anyway; refusing here means the
    // person is not asked to approve something that cannot succeed.
    const taken = o.requirements.some(
      (r) => String(r["requirement_id"] ?? "").toLowerCase() === input.subject.toLowerCase(),
    );
    if (taken) {
      return {
        recorded: false,
        reason: `${input.subject} already exists — an id names one claim, and reusing it would shadow the original`,
      };
    }

    const res = await submitOp(
      "assertNS",
      {
        subject: input.subject,
        text: input.text,
        discipline: input.discipline,
        // ⛔ R0, always, and not a parameter. The agent capability is R0-only, and
        // a rung is evidence rather than intent — `decompose.py` promotes a claim
        // to R2 once it can enumerate the holes, and `ladder-integrity.rq` refuses
        // a hand-set rung. Exposing this as an input would let the model assert
        // evidence nobody produced.
        rung: "R0",
        modality: input.modality,
        project: input.project,
      },
      // The read point the proposal is made against. Taken from the overlay the
      // agent just read, never defaulted — a proposal made against a corpus you
      // were not looking at is a different proposal.
      o.corpus_version,
    );

    return {
      recorded: true,
      requirement_id: input.subject,
      parent: o.corpus_version,
      // Returned so the model reports what the RULE found, not what it intended
      // the sentence to say.
      decomposes_to: extract(input.text),
      // ⚠ `log_seq`, not `seq`. The route answers
      // `{queued, log_seq, log_offset, admissible_ops, …}`
      // (proposal/op/route.ts), and reading a key it never sends is not a
      // missing sequence number — it is a successful write that reports itself
      // as unrecorded, every time, with nothing in the response to say so.
      seq: res["log_seq"] ?? null,
      // ⚠ Said every time. `pending` is not `adopted`, and a model summarising
      // "recorded" as "added to the specification" would be describing invariant
      // ② exactly backwards.
      status:
        "pending — recorded in the proposal log against the read point, and NOT in the corpus. " +
        "A person promotes it separately, and the gates run over the result.",
    };
  },
});
