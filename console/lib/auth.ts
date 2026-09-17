/**
 * Who is writing.
 *
 * ⑤ Nothing is attributed to nobody. A write with no principal is refused, never
 * attributed to an anonymous default — an append-only log of anonymous edits is
 * worse than no log.
 *
 * ⛔ Read server-side, on every write, never from a request body and never from a
 * header the client can set. spec's plugin trusts `x-fastverk-user-sub` because a
 * gateway it trusts injects it; **the console is the edge**, so anything
 * client-supplied here is client-controlled.
 */
import type { Principal } from "./proposal";

const isProduction = () =>
  process.env["NODE_ENV"] === "production" || process.env["VERCEL_ENV"] === "production";

const csv = (name: string): string[] =>
  (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

function capabilities(sub: string): { kernel: boolean; agent: boolean } {
  return {
    // Fails CLOSED: an empty allow-list means nobody holds kernel capability, so
    // `declarePrecedence` is queued for an operator rather than applied.
    kernel: csv("SPEC_KERNEL_SUBS").includes(sub),
    agent: sub.startsWith("agent:") || csv("SPEC_AGENT_SUBS").includes(sub),
  };
}

/**
 * The dev shim.
 *
 * ⚠ Returns `null` when unconfigured, so an unconfigured environment refuses
 * writes. There is deliberately no `dev@localhost` fallback: a default author is
 * attribution to nobody wearing a name, which is the thing invariant ⑤ forbids.
 *
 * ⚠ Stamps `sub` as `dev:<email>`. Because the log is append-only, a dev-authored
 * record can never be removed — so it must be self-labelling forever.
 */
function devPrincipal(): Principal | null {
  const who = process.env["SPEC_AUTHOR"]?.trim();
  if (!who) return null;
  const email = who.includes("@") ? who : `${who}@local`;
  const sub = `dev:${email}`;
  return { sub, email, ...capabilities(sub) };
}

/**
 * The real provider: a signed session cookie, set only after Google asserted a
 * verified address inside the allowed Workspace domain.
 *
 * ⛔ Read server-side from the cookie jar, never from a request body and never
 * from a header. The console is the EDGE — there is no gateway in front of it
 * that could be trusted to inject an identity, so anything the client can set is
 * client-controlled.
 */
async function sessionPrincipal(): Promise<Principal | null> {
  const { cookies } = await import("next/headers");
  const { SESSION_COOKIE, openSession } = await import("./auth/session");
  let token: string | undefined;
  try {
    token = (await cookies()).get(SESSION_COOKIE)?.value;
  } catch {
    // Called outside a request scope (a build-time render). No session, and
    // therefore no author — which is the correct answer, not an error.
    return null;
  }
  const s = await openSession(token);
  if (!s) return null;
  // `sub` is Google's stable account id, not the email: an address can be
  // reassigned inside a Workspace and the log is forever.
  return { sub: `google:${s.sub}`, email: s.email, ...capabilities(`google:${s.sub}`) };
}

/** Whether a real identity provider is wired up at all. */
export const authConfigured = () => Boolean(process.env["GOOGLE_CLIENT_ID"]?.trim());

/**
 * Whether a caller must be authenticated, for reads as well as writes.
 *
 * ⛔ True whenever a provider is configured, AND whenever this is production even
 * if one is not. The second half is the important one: an unconfigured
 * production deployment is the state a project is in between "first deploy
 * succeeded" and "somebody finished the environment variables", and the corpus
 * is a customer's authorization model. Open-by-default there would publish it,
 * and nothing would look wrong.
 */
export const mustAuthenticate = () => authConfigured() || isProduction();

/** Why reads are refused when nothing is configured. */
export const NOT_CONFIGURED =
  "no identity provider is configured on this deployment, so it cannot tell who " +
  "you are and will not serve a customer's authorization model to an unknown " +
  "caller. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI and " +
  "GOOGLE_ALLOWED_DOMAIN.";

export async function principal(): Promise<Principal | null> {
  const session = await sessionPrincipal();
  if (session) return session;
  // ⛔ The dev shim never runs in production, and never when a real provider is
  // configured. A local convenience that survives into a deployment is an
  // authentication bypass with a friendly name.
  if (isProduction() || authConfigured()) return null;
  return devPrincipal();
}

/** Why a write was refused, in the words the console shows. */
export const NO_PRINCIPAL =
  "a write with no principal has no author to record, so it is refused rather " +
  "than attributed to nobody. Sign in, or set SPEC_AUTHOR for local development.";
