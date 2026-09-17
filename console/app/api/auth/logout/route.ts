import { NextResponse } from "next/server";

import { SESSION_COOKIE } from "../../../../lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST, not GET: a sign-out on GET can be triggered by any page that embeds an
// image pointing at it.
export async function POST(req: Request) {
  const res = NextResponse.redirect(new URL("/signin", req.url), { status: 303 });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
