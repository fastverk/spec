/**
 * Google as the identity provider, restricted to one Workspace domain.
 *
 * ⛔ THE DOMAIN CHECK IS `hd`, NOT THE EMAIL SUFFIX.
 *
 * `hd` is the Google Workspace hosted domain, asserted by Google in a signed ID
 * token. An email ending `@savvifi.com` is not the same fact: a consumer Google
 * account can carry an arbitrary alternate address, and `email` alone would let
 * one in. Checking `hd` is checking that Google says this account belongs to the
 * Workspace. Both are checked, plus `email_verified`.
 *
 * ⚠ The `hd` parameter on the authorize URL is a HINT to the account chooser. It
 * is not enforcement and must never be treated as such — enforcement is the claim
 * check in `verifyIdToken` below, on the server, after signature verification.
 */
import { createRemoteJWKSet, jwtVerify } from "jose";

import type { Session } from "./session";

const AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const JWKS_URL = new URL("https://www.googleapis.com/oauth2/v3/certs");
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

// Cached across invocations; jose refreshes on unknown key id.
const jwks = createRemoteJWKSet(JWKS_URL);

export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  allowedDomain: string;
};

/**
 * `null` when the provider is not configured, which is how the console tells
 * "no identity provider" from "you are not signed in".
 */
export function googleConfig(): GoogleConfig | null {
  const clientId = process.env["GOOGLE_CLIENT_ID"]?.trim();
  const clientSecret = process.env["GOOGLE_CLIENT_SECRET"]?.trim();
  const redirectUri = process.env["GOOGLE_REDIRECT_URI"]?.trim();
  const allowedDomain = process.env["GOOGLE_ALLOWED_DOMAIN"]?.trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  // ⛔ Fails CLOSED, exactly like SPEC_KERNEL_SUBS: an unset allow-list means
  // nobody, never everybody. A console that let the whole internet author
  // proposals because one variable was missing is not a console anybody can
  // trust the log of.
  if (!allowedDomain) {
    throw new Error(
      "GOOGLE_ALLOWED_DOMAIN is unset. It fails closed on purpose — without it " +
        "any Google account could sign in and author permanent records. Set it to " +
        "the Workspace domain, e.g. savvifi.com.",
    );
  }
  return { clientId, clientSecret, redirectUri, allowedDomain };
}

export function authorizeUrl(cfg: GoogleConfig, state: string, nonce: string): string {
  const u = new URL(AUTHORIZE);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", state);
  u.searchParams.set("nonce", nonce);
  // A hint to the account chooser, nothing more. See the module note.
  u.searchParams.set("hd", cfg.allowedDomain);
  u.searchParams.set("prompt", "select_account");
  return u.toString();
}

export type IdClaims = {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  hd?: unknown;
  name?: unknown;
  nonce?: unknown;
};

export type SignInResult =
  | { ok: true; session: Session }
  | { ok: false; message: string };

/** Exchange the authorization code and verify what comes back. */
export async function exchangeCode(
  cfg: GoogleConfig,
  code: string,
  nonce: string,
): Promise<SignInResult> {
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    return { ok: false, message: `Google refused the code exchange (${res.status}).` };
  }
  const body = (await res.json()) as { id_token?: unknown };
  if (typeof body.id_token !== "string") {
    return { ok: false, message: "Google returned no id_token." };
  }

  // ⛔ Verify the SIGNATURE, not just the claims. Google's own guidance allows
  // skipping this for a token fetched directly from the token endpoint over TLS,
  // and that is true today — but it stops being true the moment anyone refactors
  // this to accept a token from the client, and that refactor would look
  // harmless. Verifying always costs one cached JWKS fetch.
  let claims: IdClaims;
  try {
    const { payload } = await jwtVerify(body.id_token, jwks, {
      issuer: ISSUERS,
      audience: cfg.clientId,
    });
    claims = payload as IdClaims;
  } catch (e) {
    return { ok: false, message: `The Google token did not verify: ${e instanceof Error ? e.message : e}` };
  }

  return checkClaims(claims, cfg, nonce);
}

/**
 * The tenant gate: everything the console decides about a verified Google token.
 *
 * ⛔ SEPARATE FROM `exchangeCode` SO IT CAN BE SHOWN TO REJECT. RFC-003 §10 has
 * said, correctly, that `GOOGLE_ALLOWED_DOMAIN` is "proved to admit and not yet
 * proved to reject" — the flow had been run end to end by an in-domain account
 * and never once from outside. That gap survived because the rule sat inside a
 * function that first talks to Google's token endpoint and its JWKS, so no test
 * could reach it without the network and a real account at another domain.
 *
 * The signature check stays where it was; it is jose's job and not the rule
 * under test. This is the rule, and `test/google.test.ts` runs every branch of
 * it — including the one the module header names as the reason `hd` is checked
 * at all.
 *
 * ⚠ Per-tenant by construction. `cfg.allowedDomain` comes from this deployment's
 * environment, which is what makes "one console per consumer" (#52) an
 * arrangement rather than a hope: a second tenant is a second deployment with a
 * second value, and neither can see the other's log.
 */
export function checkClaims(claims: IdClaims, cfg: GoogleConfig, nonce: string): SignInResult {
  // Replay protection: the nonce we generated must come back inside the signed
  // token. Without it a token minted for one sign-in attempt can be presented at
  // another.
  if (claims.nonce !== nonce) {
    return { ok: false, message: "The sign-in could not be matched to this browser. Try again." };
  }

  const sub = typeof claims.sub === "string" ? claims.sub : "";
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
  if (!sub || !email) return { ok: false, message: "Google returned no account identity." };
  if (claims.email_verified !== true) {
    return { ok: false, message: "That Google account has no verified email address." };
  }

  // The two domain checks. `hd` is the Workspace assertion; the suffix check is
  // belt, and neither substitutes for the other.
  const hd = typeof claims.hd === "string" ? claims.hd.toLowerCase() : "";
  const want = cfg.allowedDomain.toLowerCase();
  if (hd !== want || !email.endsWith(`@${want}`)) {
    return {
      ok: false,
      message: `This console is limited to ${cfg.allowedDomain} accounts. Signed in as ${email}.`,
    };
  }

  return {
    ok: true,
    session: { sub, email, name: typeof claims.name === "string" ? claims.name : email },
  };
}
