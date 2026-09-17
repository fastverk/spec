/**
 * The routes, as the attack.
 *
 * The first HTTP-level tests in this directory. Everything before this tested
 * pure functions; the machine credential (RFC-004a §4) is a property of WHICH
 * route accepts WHAT, and only a request can say that. Written as the attack:
 * the load-bearing case is the replay of a valid evaluation credential against
 * the op door, and it must come back 401 with nothing appended.
 *
 * Setup is the JSONL backend in a temp dir, no identity provider, not
 * production — the same shape as `docs/running-locally.md` §1 — with both
 * secrets set and different. `sessionPrincipal()` catches `cookies()` throwing
 * outside a request scope and answers null, which is exactly the "no session"
 * a CI job has.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as postEvaluation } from "../app/api/evaluation/route";
import { POST as postProposalOp } from "../app/api/proposal/op/route";
import { mintMachineToken } from "../lib/auth/machine";

const SESSION = "session-secret-0123456789abcdef0123456789abcdef";
const MACHINE = "machine-secret-0123456789abcdef0123456789abcdef";
const key = (s: string) => new TextEncoder().encode(s);

let dir = "";
const evaluationLog = () => join(dir, "evaluations.jsonl");
const proposalLog = () => join(dir, "proposals.jsonl");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "spec-routes-"));
  for (const k of ["GOOGLE_CLIENT_ID", "VERCEL_ENV", "DATABASE_URL", "SPEC_AUTHOR", "SPEC_MACHINE_TOKEN_REVOKED"]) {
    vi.stubEnv(k, undefined);
  }
  vi.stubEnv("SPEC_PROPOSAL_LOG", proposalLog());
  vi.stubEnv("SPEC_EVALUATION_LOG", evaluationLog());
  vi.stubEnv("SESSION_SECRET", SESSION);
  vi.stubEnv("SPEC_MACHINE_TOKEN_SECRET", MACHINE);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const mint = (implementation = "studio-nextjs") =>
  mintMachineToken({ implementation, ttlSeconds: 3600, secret: key(MACHINE) });

const post = (
  handler: (req: Request) => Promise<Response>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  handler(
    new Request(`http://console.local${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const measurement = {
  claim: "auth-24",
  implementation: "studio-nextjs",
  outcome: "Examined",
  population: 1412,
  project: "studio",
  query_fingerprint: "sha256:b05e76b22a0cc44b",
};

const assertNS = { parent: "corpus:test", op: "assertNS", subject: "s", text: "t", discipline: "d", rung: "R0" };

const lastLine = (path: string) => {
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
};

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe("POST /api/evaluation with a machine credential", () => {
  it("records an Examined count under machine:<implementation>", async () => {
    const { token } = await mint();
    const res = await post(postEvaluation, "/api/evaluation", measurement, bearer(token));
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(body["recorded"]).toBe(true);
    expect(body["author"]).toBe("machine:studio-nextjs");
    expect(body["population"]).toBe(1412);

    const line = lastLine(evaluationLog());
    expect(line["author"]).toBe("machine:studio-nextjs");
    expect(line["query_fingerprint"]).toBe("sha256:b05e76b22a0cc44b");
    expect(line["outcome"]).toBe("Examined");
  });

  it("⛔ the replay: the same credential against /api/proposal/op is 401 and appends nothing", async () => {
    const { token } = await mint();
    const res = await post(postProposalOp, "/api/proposal/op", assertNS, bearer(token));
    expect(res.status).toBe(401);
    expect((await json(res))["error"]).toBe("E_NO_PRINCIPAL");
    expect(existsSync(proposalLog())).toBe(false);
  });

  it("…and that refusal is for want of a principal, not a malformed body", async () => {
    // Positive control for the replay: the identical op from a person is admitted.
    vi.stubEnv("SPEC_AUTHOR", "you@example.com");
    const res = await post(postProposalOp, "/api/proposal/op", assertNS);
    expect(res.status).toBe(202);
    expect(existsSync(proposalLog())).toBe(true);
  });

  it("without any credential, the old answer stands: 401 E_NO_PRINCIPAL", async () => {
    const res = await post(postEvaluation, "/api/evaluation", measurement);
    expect(res.status).toBe(401);
    expect((await json(res))["error"]).toBe("E_NO_PRINCIPAL");
    expect(existsSync(evaluationLog())).toBe(false);
  });

  it("a person is still a person: SPEC_AUTHOR and no header records under the email", async () => {
    vi.stubEnv("SPEC_AUTHOR", "you@example.com");
    const res = await post(postEvaluation, "/api/evaluation", measurement);
    expect(res.status).toBe(202);
    expect((await json(res))["author"]).toBe("you@example.com");
  });

  it("a bad token is 401 E_MACHINE_TOKEN_REJECTED — and does NOT fall back to SPEC_AUTHOR", async () => {
    vi.stubEnv("SPEC_AUTHOR", "you@example.com");
    for (const token of ["garbage", "a.b.c", (await mint()).token.slice(0, -4) + "xxxx"]) {
      const res = await post(postEvaluation, "/api/evaluation", measurement, bearer(token));
      expect(res.status).toBe(401);
      expect((await json(res))["error"]).toBe("E_MACHINE_TOKEN_REJECTED");
    }
    // A token signed with the SESSION secret is not a machine credential.
    const forged = await mintMachineToken({ implementation: "studio-nextjs", ttlSeconds: 60, secret: key(SESSION) });
    const res = await post(postEvaluation, "/api/evaluation", measurement, bearer(forged.token));
    expect(res.status).toBe(401);
    expect(existsSync(evaluationLog())).toBe(false);
  });

  it("a Basic header is present-but-wrong, not absent", async () => {
    vi.stubEnv("SPEC_AUTHOR", "you@example.com");
    const res = await post(postEvaluation, "/api/evaluation", measurement, { authorization: "Basic dXNlcjpwYXNz" });
    expect(res.status).toBe(401);
    expect((await json(res))["error"]).toBe("E_MACHINE_TOKEN_REJECTED");
  });

  it("a header on a deployment with no machine secret is 401 E_MACHINE_TOKENS_UNCONFIGURED", async () => {
    const { token } = await mint();
    vi.stubEnv("SPEC_MACHINE_TOKEN_SECRET", undefined);
    const res = await post(postEvaluation, "/api/evaluation", measurement, bearer(token));
    expect(res.status).toBe(401);
    expect((await json(res))["error"]).toBe("E_MACHINE_TOKENS_UNCONFIGURED");
  });

  it("a machine secret equal to the session secret is treated as unconfigured", async () => {
    vi.stubEnv("SPEC_MACHINE_TOKEN_SECRET", SESSION);
    const { token } = await mintMachineToken({ implementation: "studio-nextjs", ttlSeconds: 60, secret: key(SESSION) });
    const res = await post(postEvaluation, "/api/evaluation", measurement, bearer(token));
    expect(res.status).toBe(401);
    expect((await json(res))["error"]).toBe("E_MACHINE_TOKENS_UNCONFIGURED");
  });

  it("a machine may not judge: Passes and Fails are 422, nothing appended", async () => {
    const { token } = await mint();
    for (const outcome of ["Passes", "Fails"]) {
      const res = await post(postEvaluation, "/api/evaluation", { ...measurement, outcome, population: 88 }, bearer(token));
      expect(res.status).toBe(422);
      expect((await json(res))["message"]).toContain("Examined");
    }
    expect(existsSync(evaluationLog())).toBe(false);
  });

  it("the existing refusals are unchanged: Examined over zero is still Vacuous", async () => {
    const { token } = await mint();
    const res = await post(postEvaluation, "/api/evaluation", { ...measurement, population: 0 }, bearer(token));
    expect(res.status).toBe(422);
    expect((await json(res))["message"]).toContain("Vacuous");
  });

  it("a credential reports only for the implementation it was issued for: 403", async () => {
    const { token } = await mint("studio-nextjs");
    const res = await post(postEvaluation, "/api/evaluation", { ...measurement, implementation: "ampere" }, bearer(token));
    expect(res.status).toBe(403);
    expect((await json(res))["error"]).toBe("E_IMPLEMENTATION_MISMATCH");
    expect(existsSync(evaluationLog())).toBe(false);
  });

  it("a revoked jti is 401", async () => {
    const { token, jti } = await mint();
    vi.stubEnv("SPEC_MACHINE_TOKEN_REVOKED", `some-other-jti, ${jti}`);
    const res = await post(postEvaluation, "/api/evaluation", measurement, bearer(token));
    expect(res.status).toBe(401);
    expect((await json(res))["error"]).toBe("E_MACHINE_TOKEN_REJECTED");
  });

  it("a valid credential on a read-only instance is 503 — after the credential is judged", async () => {
    vi.stubEnv("SPEC_PROPOSAL_LOG", undefined);
    vi.stubEnv("SPEC_EVALUATION_LOG", undefined);
    const { token } = await mint();
    const res = await post(postEvaluation, "/api/evaluation", measurement, bearer(token));
    expect(res.status).toBe(503);
    // And a bad one is still 401 there, not 503: an unauthenticated write to a
    // read-only instance is a 401.
    const bad = await post(postEvaluation, "/api/evaluation", measurement, bearer("garbage"));
    expect(bad.status).toBe(401);
  });

  it("a valid credential with a non-JSON body is 400", async () => {
    const { token } = await mint();
    const res = await post(postEvaluation, "/api/evaluation", "{not json", bearer(token));
    expect(res.status).toBe(400);
  });
});
