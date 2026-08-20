/**
 * The machine credential in isolation: what verifies and — mostly — what does
 * not. A verifier only ever shown to accept is an assertion.
 */
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import {
  MACHINE_AUDIENCE,
  MACHINE_ISSUER,
  MACHINE_MAX_TTL_SECONDS,
  MACHINE_TOKEN_TYP,
  bearerOf,
  mintMachineToken,
  verifyMachineToken,
} from "../lib/auth/machine";
import { checkOp } from "../lib/proposal";

const key = (s: string) => new TextEncoder().encode(s);
const SECRET = key("machine-secret-0123456789abcdef0123456789abcdef");
const OTHER = key("session-secret-0123456789abcdef0123456789abcdef");
const NONE: ReadonlySet<string> = new Set();

/** A token that is right in every respect except the one named. */
const lookalike = (o: {
  secret?: Uint8Array;
  iss?: string;
  aud?: string;
  typ?: string;
  sub?: string;
  implementation?: string | null;
  exp?: boolean;
  jti?: boolean;
}) => {
  const claims = o.implementation === null ? {} : { implementation: o.implementation ?? "studio-nextjs" };
  let j = new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: o.typ ?? MACHINE_TOKEN_TYP })
    .setSubject(o.sub ?? "machine:studio-nextjs")
    .setIssuer(o.iss ?? MACHINE_ISSUER)
    .setAudience(o.aud ?? MACHINE_AUDIENCE)
    .setIssuedAt();
  if (o.exp !== false) j = j.setExpirationTime("1h");
  if (o.jti !== false) j = j.setJti("jti-1");
  return j.sign(o.secret ?? SECRET);
};

describe("mint → verify", () => {
  it("round-trips a token to its named principal", async () => {
    const { token, sub, jti, exp } = await mintMachineToken({
      implementation: "studio-nextjs",
      ttlSeconds: 3600,
      secret: SECRET,
      now: 1_700_000_000,
    });
    expect(sub).toBe("machine:studio-nextjs");
    expect(exp).toBe(1_700_000_000 + 3600);
    // A fixed clock in the past makes the token expired; the positive control
    // below mints against the real clock.
    expect(await verifyMachineToken(token, SECRET, NONE)).toBeNull();

    const live = await mintMachineToken({ implementation: "studio-nextjs", ttlSeconds: 3600, secret: SECRET });
    expect(await verifyMachineToken(live.token, SECRET, NONE)).toEqual({
      kind: "machine",
      sub: "machine:studio-nextjs",
      implementation: "studio-nextjs",
      jti: live.jti,
    });
    expect(live.jti).not.toBe(jti);
  });

  it("refuses to mint for nobody, for two words, or for longer than a year", async () => {
    await expect(mintMachineToken({ implementation: "  ", ttlSeconds: 60, secret: SECRET })).rejects.toThrow();
    await expect(mintMachineToken({ implementation: "two words", ttlSeconds: 60, secret: SECRET })).rejects.toThrow();
    await expect(
      mintMachineToken({ implementation: "x", ttlSeconds: MACHINE_MAX_TTL_SECONDS + 1, secret: SECRET }),
    ).rejects.toThrow();
    await expect(mintMachineToken({ implementation: "x", ttlSeconds: 0, secret: SECRET })).rejects.toThrow();
  });
});

describe("what does NOT verify", () => {
  it("the same claims under another secret", async () => {
    expect(await verifyMachineToken(await lookalike({ secret: OTHER }), SECRET, NONE)).toBeNull();
  });
  it("garbage", async () => {
    expect(await verifyMachineToken("not.a.jwt", SECRET, NONE)).toBeNull();
    expect(await verifyMachineToken("", SECRET, NONE)).toBeNull();
  });
  it("the wrong audience, issuer or typ", async () => {
    expect(await verifyMachineToken(await lookalike({ aud: "spec-console:proposal" }), SECRET, NONE)).toBeNull();
    expect(await verifyMachineToken(await lookalike({ iss: "someone-else" }), SECRET, NONE)).toBeNull();
    expect(await verifyMachineToken(await lookalike({ typ: "JWT" }), SECRET, NONE)).toBeNull();
  });
  it("a session cookie's JWT — even one signed with the machine secret", async () => {
    // The exact shape `lib/auth/session.ts` seals: HS256, issuer spec-console,
    // no audience, no typ. The secrets are required to differ in a deployment;
    // this shows the claims alone are enough to keep the two apart.
    const session = await new SignJWT({ email: "a@b.c", name: "A" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("google:1")
      .setIssuer("spec-console")
      .setIssuedAt()
      .setExpirationTime("8h")
      .sign(SECRET);
    expect(await verifyMachineToken(session, SECRET, NONE)).toBeNull();
  });
  it("a sub that is not a machine", async () => {
    expect(await verifyMachineToken(await lookalike({ sub: "google:123" }), SECRET, NONE)).toBeNull();
    expect(await verifyMachineToken(await lookalike({ sub: "agent:eve" }), SECRET, NONE)).toBeNull();
  });
  it("an implementation that disagrees with the sub, or is missing", async () => {
    expect(await verifyMachineToken(await lookalike({ implementation: "ampere" }), SECRET, NONE)).toBeNull();
    expect(await verifyMachineToken(await lookalike({ implementation: null }), SECRET, NONE)).toBeNull();
  });
  it("a token with no expiry", async () => {
    expect(await verifyMachineToken(await lookalike({ exp: false }), SECRET, NONE)).toBeNull();
  });
  it("a token with no jti, or a revoked one", async () => {
    expect(await verifyMachineToken(await lookalike({ jti: false }), SECRET, NONE)).toBeNull();
    const { token, jti } = await mintMachineToken({ implementation: "studio-nextjs", ttlSeconds: 60, secret: SECRET });
    expect(await verifyMachineToken(token, SECRET, new Set([jti]))).toBeNull();
    // Positive control: the same token, not revoked.
    expect(await verifyMachineToken(token, SECRET, new Set(["some-other-jti"]))).not.toBeNull();
  });
});

describe("bearerOf", () => {
  it("distinguishes absent from present-but-wrong", () => {
    expect(bearerOf(null)).toEqual({ present: false });
    expect(bearerOf("")).toEqual({ present: false });
    expect(bearerOf("   ")).toEqual({ present: false });
    expect(bearerOf("Basic dXNlcjpwYXNz")).toEqual({ present: true, token: null });
    expect(bearerOf("Bearer")).toEqual({ present: true, token: null });
    expect(bearerOf("Bearer a b")).toEqual({ present: true, token: null });
    expect(bearerOf("bearer x.y.z")).toEqual({ present: true, token: "x.y.z" });
    expect(bearerOf("  Bearer   x.y.z  ")).toEqual({ present: true, token: "x.y.z" });
  });
});

describe("the op door's second lock", () => {
  it("refuses a machine principal even on the one op an agent may write", () => {
    const op = { op: "assertNS", subject: "s", text: "t", discipline: "d", rung: "R0" };
    const machine = { sub: "machine:studio-nextjs", email: "", kernel: false, agent: false };
    const r = checkOp(op, machine);
    expect(r.verdict).toBe("REJECTED");
    expect(r.reason).toContain("machine");
    // Positive control: the same op from a person is admitted.
    expect(checkOp(op, { sub: "google:1", email: "a@b.c", kernel: false, agent: false }).verdict).toBe("OK");
  });
});
