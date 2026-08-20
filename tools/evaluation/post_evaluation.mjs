#!/usr/bin/env node
/**
 * Post one measurement to the spec console — the consumer's half of RFC-004a.
 *
 * Dependency-free (Node ≥ 20: global `fetch`, `node:crypto`). Copy this one
 * file into the project's CI, or call it from there:
 *
 *   SPEC_CONSOLE_URL=https://spec.example.com \
 *   SPEC_EVALUATION_TOKEN=… \
 *   node post_evaluation.mjs --claim auth-24 --implementation studio-nextjs \
 *       --project studio --population "$POP" --sql-file checks/auth-24.sql
 *
 * What crosses the wire: a count, a hash of the query that produced it, and an
 * outcome. Never the SQL, never a row. spec has no data access to any project
 * and must not acquire one by the back door of "just a few examples".
 *
 * ⛔ This script cannot post `Passes` or `Fails`. A count says how many records
 * a check would examine; whether the claim holds over them is a judgment, and a
 * `SELECT count(*)` did not make one. Zero is `Vacuous`; anything else is
 * `Examined`; a check that could not run at all is `CannotBeGrounded`. The
 * console refuses a judgment from a machine credential regardless — this just
 * means the job never tries.
 *
 * `--dry-run` prints the body and exits 0 without reading the token, which is
 * how to see exactly what would leave the building before anything does.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** `sha256:` + the first 16 hex characters of the SHA-256 of the query text (RFC-004a §5). */
export function fingerprint(sql) {
  return `sha256:${createHash("sha256").update(sql).digest("hex").slice(0, 16)}`;
}

/**
 * The request body for one measurement. `population` is an integer count, or
 * `null` for a check that could not run at all.
 *
 * There is no `outcome` parameter on purpose: the outcome is a function of the
 * count, and the only outcomes this can produce are the three a machine may
 * report.
 */
export function buildBody({ claim, implementation, project = "", population, sql = "", detail = "" }) {
  if (!claim) throw new Error("claim is required — an evaluation of nothing is not a measurement");
  if (!implementation) {
    throw new Error("implementation is required — an unattributed count cannot say which product it measured");
  }
  const body = { claim, implementation };
  if (project) body.project = project;
  if (population === null) {
    body.outcome = "CannotBeGrounded";
  } else {
    if (!Number.isInteger(population) || population < 0) {
      throw new Error("population must be a non-negative integer count of records, or --cannot-be-grounded");
    }
    body.outcome = population === 0 ? "Vacuous" : "Examined";
    body.population = population;
  }
  if (sql) body.query_fingerprint = fingerprint(sql);
  if (detail) body.detail = detail;
  return body;
}

/** POST the body. Resolves to `{ status, body }`; the caller decides what a non-202 means. */
export async function post(consoleUrl, token, body) {
  const res = await fetch(`${consoleUrl.replace(/\/+$/, "")}/api/evaluation`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

const USAGE =
  "usage: post_evaluation.mjs --claim <id> --implementation <name> [--project <name>]\n" +
  "           (--population <N> | --cannot-be-grounded) [--sql <text> | --sql-file <path>]\n" +
  "           [--detail <text>] [--dry-run]\n" +
  "env:   SPEC_CONSOLE_URL, SPEC_EVALUATION_TOKEN (not read under --dry-run)";

export function parseArgs(argv) {
  const a = { claim: "", implementation: "", project: "", population: undefined, cannotBeGrounded: false, sql: "", sqlFile: "", detail: "", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${k} needs a value\n${USAGE}`);
      return v;
    };
    switch (k) {
      case "--claim": a.claim = next().trim(); break;
      case "--implementation": a.implementation = next().trim(); break;
      case "--project": a.project = next().trim(); break;
      case "--population": a.population = next().trim(); break;
      case "--cannot-be-grounded": a.cannotBeGrounded = true; break;
      case "--sql": a.sql = next(); break;
      case "--sql-file": a.sqlFile = next(); break;
      case "--detail": a.detail = next(); break;
      case "--dry-run": a.dryRun = true; break;
      default: throw new Error(`unknown argument ${k}\n${USAGE}`);
    }
  }
  return a;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let body;
  try {
    const a = parseArgs(argv);
    const sql = a.sqlFile ? readFileSync(a.sqlFile, "utf8") : a.sql;
    const population = a.cannotBeGrounded ? null : a.population === undefined ? Number.NaN : Number(a.population);
    body = buildBody({ claim: a.claim, implementation: a.implementation, project: a.project, population, sql, detail: a.detail });
    if (a.dryRun) {
      process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
      return 0;
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const url = env.SPEC_CONSOLE_URL?.trim();
  const token = env.SPEC_EVALUATION_TOKEN?.trim();
  if (!url || !token) {
    console.error("SPEC_CONSOLE_URL and SPEC_EVALUATION_TOKEN are required (use --dry-run to print the body without posting)");
    return 2;
  }
  const { status, body: reply } = await post(url, token, body);
  if (status !== 202) {
    console.error(`${body.claim}: ${status} ${JSON.stringify(reply)}`);
    return 1;
  }
  process.stdout.write(
    `${body.claim}: recorded as log_seq ${reply.log_seq} (${reply.outcome}, population ${reply.population ?? "—"}, author ${reply.author})\n`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
