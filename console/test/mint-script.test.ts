/**
 * The mint script is plain JavaScript with the claims duplicated from
 * `lib/auth/machine.ts`. This runs it and verifies its output with the
 * TypeScript verifier, so the two cannot drift silently.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { verifyMachineToken } from "../lib/auth/machine";

const script = fileURLToPath(new URL("../tools/mint-machine-token.mjs", import.meta.url));
const SECRET = "mint-script-secret-0123456789abcdef0123456789abcdef";

/** The inherited environment minus both secrets, plus whatever a test sets. */
function env(over: Record<string, string>): NodeJS.ProcessEnv {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "SESSION_SECRET" && k !== "SPEC_MACHINE_TOKEN_SECRET") e[k] = v;
  }
  return { ...e, ...over } as NodeJS.ProcessEnv;
}

const run = (args: string[], over: Record<string, string>) =>
  spawnSync(process.execPath, [script, ...args], { env: env(over), encoding: "utf8" });

describe("tools/mint-machine-token.mjs", () => {
  it("mints a token the verifier accepts, and names its jti", async () => {
    const r = run(["--implementation", "studio-nextjs", "--days", "1"], { SPEC_MACHINE_TOKEN_SECRET: SECRET });
    expect(r.status, r.stderr).toBe(0);
    const token = r.stdout.trim();
    const who = await verifyMachineToken(token, new TextEncoder().encode(SECRET), new Set());
    expect(who?.sub).toBe("machine:studio-nextjs");
    expect(who?.implementation).toBe("studio-nextjs");
    const meta = JSON.parse(r.stderr) as { sub: string; jti: string; exp: number };
    expect(meta.sub).toBe("machine:studio-nextjs");
    expect(meta.jti).toBe(who?.jti);
    // Revoking the jti it printed revokes the token it printed.
    expect(await verifyMachineToken(token, new TextEncoder().encode(SECRET), new Set([meta.jti]))).toBeNull();
  });

  it("refuses without a secret, with a short one, or with the session secret", () => {
    expect(run(["--implementation", "x"], {}).status).toBe(1);
    expect(run(["--implementation", "x"], { SPEC_MACHINE_TOKEN_SECRET: "short" }).status).toBe(1);
    expect(run(["--implementation", "x"], { SPEC_MACHINE_TOKEN_SECRET: SECRET, SESSION_SECRET: SECRET }).status).toBe(1);
  });

  it("refuses to mint for nobody or for longer than a year", () => {
    expect(run([], { SPEC_MACHINE_TOKEN_SECRET: SECRET }).status).toBe(2);
    expect(run(["--implementation", "x", "--days", "400"], { SPEC_MACHINE_TOKEN_SECRET: SECRET }).status).toBe(2);
    expect(run(["--implementation", "x", "--bogus"], { SPEC_MACHINE_TOKEN_SECRET: SECRET }).status).toBe(2);
  });
});
