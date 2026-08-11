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
 * The production provider. WorkOS AuthKit reads the session server-side; wiring
 * it is a matter of configuration, and until it is configured this returns null
 * rather than inventing an author.
 */
async function sessionPrincipal(): Promise<Principal | null> {
  if (!process.env["WORKOS_CLIENT_ID"]) return null;
  // Deliberately not implemented against a half-configured environment: an
  // identity provider that guesses is worse than one that refuses.
  //   const { withAuth } = await import("@workos-inc/authkit-nextjs");
  //   const { user } = await withAuth();
  //   return user && { sub: user.id, email: user.email, ...capabilities(user.id) };
  return null;
}

const isProduction = () =>
  process.env["NODE_ENV"] === "production" || process.env["VERCEL_ENV"] === "production";

export async function principal(): Promise<Principal | null> {
  const session = await sessionPrincipal();
  if (session) return session;
  // ⛔ The dev shim never runs in production. A local convenience that survives
  // into a deployment is an authentication bypass with a friendly name.
  if (isProduction()) return null;
  return devPrincipal();
}

/** Why a write was refused, in the words the console shows. */
export const NO_PRINCIPAL =
  "a write with no principal has no author to record, so it is refused rather " +
  "than attributed to nobody. Set SPEC_AUTHOR for local development.";
