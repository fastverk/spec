import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { authorizeUrl, googleConfig } from "../../../../lib/auth/google";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const rand = () => {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Buffer.from(b).toString("base64url");
};

export async function GET() {
  let cfg;
  try {
    cfg = googleConfig();
  } catch (e) {
    return NextResponse.json(
      { error: "E_AUTH_MISCONFIGURED", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
  if (!cfg) {
    return NextResponse.json(
      {
        error: "E_AUTH_UNCONFIGURED",
        message:
          "No identity provider is configured. Set GOOGLE_CLIENT_ID, " +
          "GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI and GOOGLE_ALLOWED_DOMAIN.",
      },
      { status: 503 },
    );
  }

  // `state` is CSRF protection for the callback; `nonce` is replay protection
  // inside the signed token. They are separate values doing separate jobs, and
  // reusing one for both would leave whichever job it was not chosen for undone.
  const state = rand();
  const nonce = rand();
  const secure = cfg.redirectUri.startsWith("https://");
  const jar = await cookies();
  const opts = { httpOnly: true, sameSite: "lax" as const, secure, path: "/", maxAge: 600 };
  jar.set("spec_oauth_state", state, opts);
  jar.set("spec_oauth_nonce", nonce, opts);

  return NextResponse.redirect(authorizeUrl(cfg, state, nonce));
}
