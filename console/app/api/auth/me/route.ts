import { NextResponse } from "next/server";

import { principal } from "../../../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who the console will attribute a write to, or nobody. */
export async function GET() {
  const who = await principal();
  return NextResponse.json(
    who ? { signed_in: true, email: who.email, sub: who.sub } : { signed_in: false },
  );
}
