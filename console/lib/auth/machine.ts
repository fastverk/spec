/**
 * The machine credential.
 *
 * A consumer project's CI runs one `SELECT count(*)` and posts the number. It
 * has no session cookie and no `SPEC_AUTHOR`, so until this existed it got a 401
 * — RFC-004a §4, "the one thing that does not exist yet". This is the one other
 * way a write gets a name, and it is deliberately narrow:
 *
 *   * Accepted ONLY by `POST /api/evaluation`. `/api/proposal/op` never calls
 *     this module — it calls `principal()`, which can only ever produce a
 *     `google:` or `dev:` sub — so a machine cannot reach the op door by
 *     construction. `checkOp` refuses the `machine:` prefix as a second lock.
 *   * Maps to a NAMED principal, `machine:<implementation>`. Invariant ⑤ is
 *     that nothing is attributed to nobody, and "a machine did it" is nobody.
 *   * Signed with its OWN secret. A session secret that could mint a machine
 *     token — or the reverse — would collapse the boundary between a person who
 *     may author and a machine that may only report. The two must differ; a
 *     deployment where they do not cannot verify machine credentials at all.
 *
 * ⛔ `lib/auth.ts` forbids identity from a client-settable header, and this is
 * not that. Nothing in the header is believed: the token is a signature
 * verified against a secret only the console holds, and the principal is what
 * the console signed, not what the caller says.
 *
 * ⚠ `MachinePrincipal` is deliberately NOT a `Principal`: no email, no kernel,
 * no agent capability. `checkProposal(body, machine)` is a type error, and the
 * compiler is the one saying so.
 *
 * What a token carries, and why:
 *
 *   iss  spec-console              the session JWT's issuer too — the same
 *                                  deployment speaking
 *   aud  spec-console:evaluation   a session cookie carries no audience, so
 *                                  neither token satisfies the other's verifier
 *                                  even if the secrets were ever the same
 *   typ  spec-machine+jwt          the same boundary, at the header
 *   sub  machine:<implementation>  the author string written to the log
 *   implementation                 the one the credential was issued for; the
 *                                  route refuses a body reporting for another
 *   exp  REQUIRED                  a token that never expires is a secret that
 *                                  never rotates
 *   jti                            so ONE leaked token can be revoked by name
 *                                  (SPEC_MACHINE_TOKEN_REVOKED) without rotating
 *                                  the secret out from under every consumer
 *
 * Rotating the secret invalidates every token at once; re-mint and redistribute.
 * Minting is `console/tools/mint-machine-token.mjs`, run on a laptop with the
 * secret — deliberately not a route, because a route that mints is a route that
 * can be asked to.
 */
import { randomBytes } from "node:crypto";

import { SignJWT, jwtVerify, type JWTPayload } from "jose";

import { MACHINE_PREFIX } from "../evaluation";

export const MACHINE_ISSUER = "spec-console";
export const MACHINE_AUDIENCE = "spec-console:evaluation";
export const MACHINE_TOKEN_TYP = "spec-machine+jwt";
export const MACHINE_SECRET_ENV = "SPEC_MACHINE_TOKEN_SECRET";
export const MACHINE_REVOKED_ENV = "SPEC_MACHINE_TOKEN_REVOKED";
/** A year and a day. Longer is a secret that never rotates, wearing an expiry. */
export const MACHINE_MAX_TTL_SECONDS = 366 * 24 * 60 * 60;

export type MachinePrincipal = { kind: "machine"; sub: string; implementation: string; jti: string };

export type MachineRejection = {
  kind: "rejected";
  error: "E_MACHINE_TOKEN_REJECTED" | "E_MACHINE_TOKENS_UNCONFIGURED";
  message: string;
};

export type MachineResolution = { kind: "absent" } | MachineRejection | MachinePrincipal;

export const MACHINE_TOKEN_REJECTED =
  "the bearer token presented is not a machine credential this deployment issued, or it has " +
  "expired or been revoked. A presented credential is judged, never ignored, so there is no " +
  "fall-back to a session. Nothing was appended.";

export const MACHINE_TOKENS_UNCONFIGURED =
  "a bearer token was presented, but this deployment has no SPEC_MACHINE_TOKEN_SECRET (or it " +
  "equals SESSION_SECRET), so it cannot verify a machine credential. Nothing was appended.";

const csv = (name: string): string[] =>
  (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

/**
 * The machine signing secret, or `null` when this deployment cannot verify one.
 *
 * ⛔ No default, for the same reason as SESSION_SECRET. And never the session
 * secret itself: a session secret that can mint a machine token collapses the
 * boundary this module exists to draw.
 */
function secret(): Uint8Array | null {
  const s = process.env[MACHINE_SECRET_ENV]?.trim();
  if (!s || s.length < 32) return null;
  if (s === process.env["SESSION_SECRET"]?.trim()) return null;
  return new TextEncoder().encode(s);
}

/** The `jti`s an operator has revoked by name. */
export function revokedJtis(): ReadonlySet<string> {
  return new Set(csv(MACHINE_REVOKED_ENV));
}

/**
 * Parse an `Authorization` header. `present` is what decides whether a session
 * is even consulted: a header that is there but wrong is a refusal, not a
 * fall-through.
 */
export function bearerOf(header: string | null): { present: false } | { present: true; token: string | null } {
  if (header === null || header.trim() === "") return { present: false };
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return { present: true, token: m?.[1] ?? null };
}

export async function mintMachineToken(o: {
  implementation: string;
  ttlSeconds: number;
  secret: Uint8Array;
  /** Seconds since the epoch; defaults to now. Tests pass a fixed clock. */
  now?: number;
}): Promise<{ token: string; sub: string; jti: string; exp: number }> {
  const implementation = o.implementation.trim();
  if (!implementation || /\s/.test(implementation)) {
    throw new Error("implementation must be a non-empty name with no whitespace");
  }
  if (!Number.isInteger(o.ttlSeconds) || o.ttlSeconds <= 0 || o.ttlSeconds > MACHINE_MAX_TTL_SECONDS) {
    throw new Error(`ttlSeconds must be an integer between 1 and ${MACHINE_MAX_TTL_SECONDS}`);
  }
  const now = o.now ?? Math.floor(Date.now() / 1000);
  const sub = `${MACHINE_PREFIX}${implementation}`;
  const jti = randomBytes(16).toString("hex");
  const exp = now + o.ttlSeconds;
  const token = await new SignJWT({ implementation })
    .setProtectedHeader({ alg: "HS256", typ: MACHINE_TOKEN_TYP })
    .setSubject(sub)
    .setIssuer(MACHINE_ISSUER)
    .setAudience(MACHINE_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .setJti(jti)
    .sign(o.secret);
  return { token, sub, jti, exp };
}

/** `null` for anything that does not verify. Never throws for a bad token. */
export async function verifyMachineToken(
  token: string,
  key: Uint8Array,
  revoked: ReadonlySet<string>,
): Promise<MachinePrincipal | null> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, key, {
      issuer: MACHINE_ISSUER,
      audience: MACHINE_AUDIENCE,
      algorithms: ["HS256"],
      typ: MACHINE_TOKEN_TYP,
    }));
  } catch {
    return null;
  }
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  const implementation = typeof payload["implementation"] === "string" ? payload["implementation"] : "";
  const jti = typeof payload.jti === "string" ? payload.jti : "";
  if (!sub.startsWith(MACHINE_PREFIX)) return null;
  if (!implementation || sub !== `${MACHINE_PREFIX}${implementation}`) return null;
  // jose enforces `exp` when it is present; a token WITHOUT one is refused here.
  if (typeof payload.exp !== "number") return null;
  if (!jti || revoked.has(jti)) return null;
  return { kind: "machine", sub, implementation, jti };
}

/**
 * Resolve the machine principal for one request. The ONLY entry point a route
 * uses, and only the evaluation route uses it.
 *
 * A presented credential is judged, never ignored: once an `Authorization`
 * header is there, the answer is this credential or a refusal — never a quiet
 * fall-back to a session cookie or `SPEC_AUTHOR`, which would let a bad token
 * get a write attributed to whoever else happened to be signed in.
 */
export async function machinePrincipal(req: Request): Promise<MachineResolution> {
  const bearer = bearerOf(req.headers.get("authorization"));
  if (!bearer.present) return { kind: "absent" };
  const key = secret();
  if (!key) {
    return { kind: "rejected", error: "E_MACHINE_TOKENS_UNCONFIGURED", message: MACHINE_TOKENS_UNCONFIGURED };
  }
  const who = bearer.token ? await verifyMachineToken(bearer.token, key, revokedJtis()) : null;
  if (!who) return { kind: "rejected", error: "E_MACHINE_TOKEN_REJECTED", message: MACHINE_TOKEN_REJECTED };
  return who;
}

/**
 * For `/api/health`: whether this deployment can verify a machine credential,
 * and how many it has revoked by name. Never which, and never for whom.
 */
export function machineCredentialHealth(): { configured: boolean; revoked: number } {
  return { configured: secret() !== null, revoked: revokedJtis().size };
}
