/**
 * The session cookie.
 *
 * A signed JWT in an httpOnly cookie. Signed rather than encrypted because
 * nothing in it is secret — it carries a Google `sub` and an email, both of which
 * the user already knows. What matters is that it cannot be FORGED, because it is
 * the only thing standing between a request and an author's name on a permanent
 * record.
 */
import { SignJWT, jwtVerify } from "jose";

export type Session = { sub: string; email: string; name: string };

const ISSUER = "spec-console";
const COOKIE = "spec_session";
/** Eight hours: a working day, then sign in again. */
const TTL_SECONDS = 8 * 60 * 60;

/**
 * ⛔ No default. A session secret with a fallback value is a session secret
 * everybody knows, and forging a cookie would then forge an author.
 */
function secret(): Uint8Array {
  const s = process.env["SESSION_SECRET"]?.trim();
  if (!s || s.length < 32) {
    throw new Error(
      "SESSION_SECRET is unset or shorter than 32 characters. Generate one with " +
        "`openssl rand -hex 32`. There is deliberately no default: a known secret " +
        "lets anyone forge a session, and a forged session forges an author.",
    );
  }
  return new TextEncoder().encode(s);
}

export const SESSION_COOKIE = COOKIE;
export const SESSION_MAX_AGE = TTL_SECONDS;

export async function sealSession(s: Session): Promise<string> {
  return new SignJWT({ email: s.email, name: s.name })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(s.sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(secret());
}

/** `null` for anything that does not verify. Never throws for a bad cookie. */
export async function openSession(token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { issuer: ISSUER });
    const sub = typeof payload.sub === "string" ? payload.sub : "";
    const email = typeof payload["email"] === "string" ? payload["email"] : "";
    if (!sub || !email) return null;
    return { sub, email, name: typeof payload["name"] === "string" ? payload["name"] : email };
  } catch {
    return null;
  }
}

/** The attributes every session cookie is set with. */
export function cookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    // Lax, not Strict: the OAuth callback is a top-level cross-site navigation
    // back from Google, and Strict would drop the cookie on that hop.
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge: TTL_SECONDS,
  };
}
