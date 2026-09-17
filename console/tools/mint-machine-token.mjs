#!/usr/bin/env node
/**
 * Mint a machine credential for POST /api/evaluation (RFC-004a §4).
 *
 *   SPEC_MACHINE_TOKEN_SECRET='…' node tools/mint-machine-token.mjs \
 *       --implementation studio-nextjs [--days 90]
 *
 * The token goes to stdout and nowhere else. `{ sub, jti, exp }` goes to stderr —
 * RECORD THE jti: it is the only handle for revoking this one token
 * (SPEC_MACHINE_TOKEN_REVOKED) without rotating the secret out from under every
 * consumer.
 *
 * ⚠ Run on a laptop with the secret pulled from the deployment (`vercel env
 * pull`), never inside the console. There is deliberately no route that mints:
 * a route that mints is a route that can be asked to.
 *
 * ⚠ The claims are duplicated from lib/auth/machine.ts on purpose — this is
 * plain JavaScript so it runs with no build step. test/mint-script.test.ts runs
 * this file and verifies its output with the TypeScript verifier, so the two
 * cannot drift silently.
 */
import { randomBytes } from "node:crypto";

import { SignJWT } from "jose";

const ISSUER = "spec-console";
const AUDIENCE = "spec-console:evaluation";
const TYP = "spec-machine+jwt";
const PREFIX = "machine:";
const MAX_DAYS = 366;
const DEFAULT_DAYS = 90;

function usage(msg) {
  console.error(msg);
  console.error(
    "usage: SPEC_MACHINE_TOKEN_SECRET='…' node tools/mint-machine-token.mjs --implementation <name> [--days N]",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
let implementation = "";
let days = DEFAULT_DAYS;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--implementation") implementation = (args[++i] ?? "").trim();
  else if (a === "--days") days = Number(args[++i]);
  else usage(`unknown argument ${a}`);
}
if (!implementation || /\s/.test(implementation)) {
  usage("--implementation must be a non-empty name with no whitespace");
}
if (!Number.isInteger(days) || days <= 0 || days > MAX_DAYS) {
  usage(`--days must be an integer between 1 and ${MAX_DAYS}`);
}

const secret = process.env.SPEC_MACHINE_TOKEN_SECRET?.trim();
if (!secret || secret.length < 32) {
  console.error(
    "SPEC_MACHINE_TOKEN_SECRET is unset or shorter than 32 characters. Generate one with " +
      "`openssl rand -hex 32`; it must differ from SESSION_SECRET.",
  );
  process.exit(1);
}
if (process.env.SESSION_SECRET?.trim() === secret) {
  console.error(
    "SPEC_MACHINE_TOKEN_SECRET equals SESSION_SECRET. A session secret that can mint a machine " +
      "token collapses the boundary between a person who may author and a machine that may only " +
      "report; use a different one.",
  );
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const exp = now + days * 24 * 60 * 60;
const jti = randomBytes(16).toString("hex");
const sub = `${PREFIX}${implementation}`;
const token = await new SignJWT({ implementation })
  .setProtectedHeader({ alg: "HS256", typ: TYP })
  .setSubject(sub)
  .setIssuer(ISSUER)
  .setAudience(AUDIENCE)
  .setIssuedAt(now)
  .setExpirationTime(exp)
  .setJti(jti)
  .sign(new TextEncoder().encode(secret));

process.stderr.write(`${JSON.stringify({ sub, jti, exp, expires: new Date(exp * 1000).toISOString() })}\n`);
process.stdout.write(`${token}\n`);
