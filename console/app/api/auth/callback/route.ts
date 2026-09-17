import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { exchangeCode, googleConfig } from "../../../../lib/auth/google";
import { SESSION_COOKIE, cookieOptions, sealSession } from "../../../../lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deny = (req: Request, why: string) =>
  NextResponse.redirect(new URL(`/signin?error=${encodeURIComponent(why)}`, req.url));

export async function GET(req: Request) {
  const cfg = googleConfig();
  if (!cfg) return deny(req, "No identity provider is configured.");

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const err = url.searchParams.get("error");
  if (err) return deny(req, `Google returned: ${err}`);
  if (!code || !state) return deny(req, "The sign-in response was incomplete.");

  const jar = await cookies();
  const expectedState = jar.get("spec_oauth_state")?.value;
  const nonce = jar.get("spec_oauth_nonce")?.value;
  // Single-use, whatever happens next.
  jar.delete("spec_oauth_state");
  jar.delete("spec_oauth_nonce");

  if (!expectedState || !nonce) return deny(req, "The sign-in took too long. Try again.");
  if (state !== expectedState) return deny(req, "The sign-in could not be matched to this browser.");

  const result = await exchangeCode(cfg, code, nonce);
  if (!result.ok) return deny(req, result.message);

  const res = NextResponse.redirect(new URL("/overview", req.url));
  res.cookies.set(
    SESSION_COOKIE,
    await sealSession(result.session),
    cookieOptions(cfg.redirectUri.startsWith("https://")),
  );
  return res;
}
