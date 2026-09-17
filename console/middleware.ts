/**
 * Gate the whole console behind a session, when a provider is configured.
 *
 * ⚠ This is a CONVENIENCE, not the enforcement. It runs on the edge runtime and
 * only checks that a session cookie verifies — it does not decide what a write
 * may do. Every write route re-reads the principal server-side and refuses
 * without one, so deleting this file would make the console ugly, not unsafe.
 * Enforcement lives next to the thing being enforced.
 */
import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE, openSession } from "./lib/auth/session";

const isProduction = () =>
  process.env["NODE_ENV"] === "production" || process.env["VERCEL_ENV"] === "production";

export async function middleware(req: NextRequest) {
  const configured = Boolean(process.env["GOOGLE_CLIENT_ID"]);

  // ⛔ FAILS CLOSED IN PRODUCTION.
  //
  // "No provider configured" means local development, where there is nothing to
  // sign in to and a redirect would just loop. It must NOT mean "let everyone
  // in" on a deployment — and the first deploy of a project is exactly when the
  // environment variables are not set yet.
  //
  // The corpus is a customer's authorization model: 69 requirements naming their
  // roles, their permission surfaces and where their controls are weak. A deploy
  // that went out before someone finished the settings page would publish all of
  // it, and nothing would look wrong. So an unconfigured PRODUCTION deployment
  // is closed, and the sign-in page says which variables are missing.
  if (!configured) {
    if (!isProduction()) return NextResponse.next();
    const url = req.nextUrl.clone();
    url.pathname = "/signin";
    url.search = "";
    return NextResponse.redirect(url);
  }

  const session = await openSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (session) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = "/signin";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // ⛔ PAGES ONLY. `/api/*` is deliberately NOT matched.
  //
  // A redirect is the right answer for a browser that asked for a page and the
  // wrong answer for a program that asked for JSON. Worse, a 307 preserves the
  // method — so an unauthenticated `POST /api/proposal/op` was being re-POSTed
  // to the sign-in page, where it would 405 or, in some clients, silently look
  // like it had gone somewhere. The API routes read the principal themselves and
  // answer 401 with a reason, which is what a caller can act on.
  //
  // `/signin` is excluded because that is where this sends people, and
  // `/api/health` was already open on purpose: an operator must be able to ask
  // what a deployment is serving without holding an account.
  matcher: ["/((?!signin|api/|_next/static|_next/image|favicon.ico).*)"],
};
