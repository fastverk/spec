/**
 * The door, at the route.
 *
 * `lib/address.ts` is checked against the shared cases in `address.test.ts`;
 * this file checks the thing a unit test cannot reach — that a REQUEST comes
 * back with the name the fixtures say it should, that the name is written to the
 * log, and that the two entry points cannot disagree about it.
 *
 * ⛔ The load-bearing test is `the flat form and the nested form are one
 * proposal`. RFC-002 §8.1 claimed exactly that property for `canonical`, and
 * §9.1 claims the stronger one across surfaces. Neither had ever been executed:
 * the flat route lived in the console and the nested one in the plugin, so no
 * suite could compare them. Both are here now, and the second is only true
 * because the surface is outside the pre-image.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as postProposal } from "../app/api/proposal/route";
import { POST as postProposalOp } from "../app/api/proposal/op/route";
import { ADDRESS_PATTERN, addressOfCanonical, contentAddress } from "../lib/address";
import { Pending, type ProposalRecord } from "../lib/overlay";

const AUTHOR = "you@example.com";
const SUB = `dev:${AUTHOR}`;

let dir = "";
const proposalLog = () => join(dir, "proposals.jsonl");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "spec-door-"));
  for (const k of ["GOOGLE_CLIENT_ID", "VERCEL_ENV", "DATABASE_URL", "SPEC_KERNEL_SUBS", "SPEC_AGENT_SUBS"]) {
    vi.stubEnv(k, undefined);
  }
  vi.stubEnv("SPEC_PROPOSAL_LOG", proposalLog());
  vi.stubEnv("SPEC_AUTHOR", AUTHOR);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const post = (handler: (req: Request) => Promise<Response>, path: string, body: unknown) =>
  handler(
    new Request(`http://console.local${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

const lines = (): ProposalRecord[] =>
  readFileSync(proposalLog(), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as ProposalRecord);

const PARENT = "corpus:studio@2026-08-20";
const OP = { op: "assertNS", subject: "auth-24", text: "Sessions MUST expire", discipline: "security", rung: "R0" };
const FLAT = { parent: PARENT, ...OP };
const NESTED = { parent: PARENT, ops: [OP] };

describe("POST /api/proposal — the door", () => {
  it("hands back a content address, a verdict, and the bytes both were taken over", async () => {
    const res = await post(postProposal, "/api/proposal", NESTED);
    expect(res.status).toBe(202);
    const body = await json(res);

    expect(body["verdict"]).toBe("Admitted");
    expect(ADDRESS_PATTERN.test(body["address"] as string)).toBe(true);
    // Computed independently of the route, from the three fields the pre-image
    // is made of. If the door ever starts hashing the surface, this fails.
    expect(body["address"]).toBe(contentAddress({ author: SUB, ops: [OP], parent: PARENT }));

    // The pre-image is checked as bytes AND as a digest, independently of the
    // module that produced it: it must parse to exactly the three fields, and
    // hashing it must give back the address the route returned. A route that
    // returned a pre-image it had not actually hashed would pass neither.
    const pre = body["address_pre_image"] as string;
    expect(Object.keys(JSON.parse(pre))).toEqual(["author", "ops", "parent"]);
    expect(JSON.parse(pre)).toEqual({ author: SUB, ops: [OP], parent: PARENT });
    expect("sha256:" + createHash("sha256").update(pre, "utf8").digest("hex")).toBe(body["address"]);
  });

  it("writes the address and the verdict into the log line", async () => {
    const body = await json(await post(postProposal, "/api/proposal", NESTED));
    const [rec] = lines();
    expect(rec!.address).toBe(body["address"]);
    expect(rec!.verdict).toBe("Admitted");
    // ⛔ And the line's own bytes name it. A record whose stored address is not
    // the address of its own body is a record that lies about its name;
    // tools/proposals/replay.py refuses one, and this is where it would start.
    expect(addressOfCanonical(rec!.canonical as string)).toBe(rec!.address);
  });

  it("⛔ the flat form and the nested form are ONE proposal", async () => {
    const flat = await json(await post(postProposalOp, "/api/proposal/op", FLAT));
    const nested = await json(await post(postProposal, "/api/proposal", NESTED));
    expect(flat["address"]).toBe(nested["address"]);
    // The bytes too, not merely the digest: a digest that matches tells you
    // nothing about WHERE two implementations would have diverged.
    expect(flat["address_pre_image"]).toBe(nested["address_pre_image"]);
    expect(flat["canonical"]).toBe(nested["canonical"]);
  });

  it("⛔ §9.1: the same change from two surfaces is one proposal with two provenance records", async () => {
    const meridian = await json(await post(postProposalOp, "/api/proposal/op", { ...FLAT, surface: "Meridian" }));
    const chat = await json(await post(postProposalOp, "/api/proposal/op", { ...FLAT, surface: "Chat" }));

    // One name…
    expect(chat["address"]).toBe(meridian["address"]);
    // …two records. Provenance is KEPT; it just does not get a vote.
    expect(chat["canonical"]).not.toBe(meridian["canonical"]);
    expect(lines().map((r) => r.surface)).toEqual(["Meridian", "Chat"]);
    expect(new Set(lines().map((r) => r.address)).size).toBe(1);
  });

  it("a proposal against another read point is a different proposal", async () => {
    const a = await json(await post(postProposal, "/api/proposal", NESTED));
    const b = await json(await post(postProposal, "/api/proposal", { ...NESTED, parent: "corpus:studio@2026-08-19" }));
    expect(b["address"]).not.toBe(a["address"]);
  });

  it("queues a kernel op rather than rejecting it, and still names it", async () => {
    const precedence = {
      parent: PARENT,
      ops: [{ op: "declarePrecedence", higher: "st:a", lower: "st:b", rationale: "life safety first" }],
    };
    const res = await post(postProposal, "/api/proposal", precedence);
    expect(res.status).toBe(202);
    const body = await json(res);
    // RFC-002 §5: partial admission is normal. Precedence is the expensive move,
    // so it waits for an operator — the proposal is still appended and named.
    expect(body["verdict"]).toBe("Queued");
    expect(body["queued_ops"]).toBe(1);
    expect(lines()[0]!.verdict).toBe("Queued");

    // The control: the same op from a principal who HOLDS kernel capability is
    // Admitted, so `Queued` is a statement about capability and not about the op.
    vi.stubEnv("SPEC_KERNEL_SUBS", SUB);
    const second = await json(await post(postProposal, "/api/proposal", precedence));
    expect(second["verdict"]).toBe("Admitted");
    // Same ops, same author, same parent — so the SAME address, twice, with two
    // different verdicts. That is content addressing working, not a collision:
    // the address names the proposal, the verdict names what the door did.
    expect(second["address"]).toBe(body["address"]);
  });

  it("refuses an ill-formed op with a verdict and a name, and appends nothing", async () => {
    const res = await post(postProposal, "/api/proposal", { parent: PARENT, ops: [{ op: "assertNS", subject: "x" }] });
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body["error"]).toBe("E_OP_REJECTED");
    expect(body["verdict"]).toBe("Rejected");
    // RFC-002 §7.1: "graph state is untouched and a witness is returned". The
    // address IS the witness — it is what the author quotes in the reply.
    expect(ADDRESS_PATTERN.test(body["address"] as string)).toBe(true);
    expect(existsSync(proposalLog())).toBe(false);
  });

  it("refuses a number it could not name the proposal by — 422, not 500", async () => {
    // ⛔ `canonicalJson` THROWS on a value it cannot render reproducibly. Before
    // the door scanned for one, this body reached the canonicalizer and came
    // back as an unhandled 500 telling the author nothing.
    const res = await post(postProposal, "/api/proposal", {
      parent: PARENT,
      ops: [{ op: "assertNS", subject: "s", text: "t", discipline: "d", rung: "R0", bound_value: 1.5 }],
    });
    expect(res.status).toBe(422);
    const body = await json(res);
    const ops = body["ops"] as { verdict: string; reason: string }[];
    expect(ops[0]!.verdict).toBe("REJECTED");
    expect(ops[0]!.reason).toContain("bound_value");
    expect(ops[0]!.reason).toContain("safe integer");
    // ⛔ And NO address. This is the one rejection that is a rejection of the
    // NAME: there is no reproducible pre-image, so there is nothing to hash, and
    // a plausible-looking digest would be worse than none.
    expect(body["address"]).toBeNull();
    expect(existsSync(proposalLog())).toBe(false);
  });
});

describe("the verdict is honoured downstream", () => {
  it("⛔ the overlay refuses to replay a Rejected record", async () => {
    await post(postProposal, "/api/proposal", NESTED);
    const [rec] = lines();

    // As written — Admitted — the claim reaches the overlay.
    expect(Pending.fromRecords([rec!]).asserted).toHaveLength(1);

    // The same record carrying the verdict the door never writes. It can only
    // come from a hand-edited log or a restored file, and that is exactly the
    // case recording the verdict exists to survive: a decision nothing
    // downstream honours is decoration.
    expect(Pending.fromRecords([{ ...rec!, verdict: "Rejected" }]).asserted).toHaveLength(0);

    // ⚠ ABSENT is not Rejected. Every record written before the door computed a
    // verdict has none, and treating those as refusals would blank the whole
    // history.
    const { verdict: _dropped, ...noVerdict } = rec!;
    expect(Pending.fromRecords([noVerdict]).asserted).toHaveLength(1);
  });
});
