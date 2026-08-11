/**
 * The grounding adapter, proxied server-side.
 *
 * ⛔ spec never queries a project's database. The PROJECT evaluates in its own
 * environment and returns counts, fingerprints and transit-only examples. This
 * route forwards a question and returns an answer; it stores nothing.
 *
 * It is a server-side proxy rather than a browser fetch so the adapter's
 * credential never reaches the client and the boundary stays visible in one file.
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE = () => process.env["GROUNDING_ADAPTER_URL"]?.trim() || "";

export async function POST(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const base = BASE();
  if (!base) {
    // ⛔ 503 with a NAMED reason, and never an empty result. "No adapter is
    // configured" and "the term matches nothing" are different facts. A proxy
    // that answered `{population: {count: 0}}` here would manufacture the exact
    // vacuous measurement the door refuses — and it would be indistinguishable
    // from a real zero, which is the one thing this whole pipeline exists to
    // keep distinguishable.
    return NextResponse.json(
      {
        error: "E_ADAPTER_UNCONFIGURED",
        message: "GROUNDING_ADAPTER_URL is unset; this deployment cannot ground anything",
        // The adapter's own spelling, so the client's outcome map applies
        // unchanged and the UI renders an honest state rather than an error.
        outcome: "CANNOT_BE_GROUNDED",
        population: null,
        detail: "no grounding adapter is deployed for this environment",
      },
      { status: 503 },
    );
  }

  const { path } = await ctx.params;
  try {
    const upstream = await fetch(`${base}/api/spec/${path.join("/")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await req.text(),
      signal: AbortSignal.timeout(15_000),
    });
    // ⚠ 400 is NOT an outage. It is "no reading has been proposed for this term",
    // which is the honest state for 57 of Studio's 60 surfaces. Pass the status
    // through and let the client tell the two apart.
    return new NextResponse(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: "E_ADAPTER_UNREACHABLE",
        message: e instanceof Error ? e.message : String(e),
        outcome: "CANNOT_BE_GROUNDED",
        population: null,
        detail: `no grounding adapter is answering at ${base}`,
      },
      { status: 502 },
    );
  }
}
