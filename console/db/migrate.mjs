#!/usr/bin/env node
/**
 * Apply the numbered SQL migrations, once each, in order.
 *
 *   DATABASE_URL=postgres://... node db/migrate.mjs
 *
 * Deliberately not a schema-diff tool. The DDL here IS the invariant: a tool
 * that emitted `DROP CONSTRAINT zero_is_an_exception_never_a_pass` to reconcile a
 * model against a database would unmake invariant ③ silently, and none of them
 * handle roles, grants and triggers well anyway.
 *
 * ⚠ Run this with the OWNER credential, from CI or a laptop — never from the web
 * tier. The owner is exactly the role that can DISABLE TRIGGER and delete, and
 * putting it in the app's environment hands the web tier the power to erase an
 * append-only log.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL is unset.");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

const sql = neon(url, { fullResults: true });
// `neon()` splits on statement boundaries poorly for DDL with $$ bodies, so each
// migration is sent as ONE statement via the unsafe/raw path.
const run = async (text) => sql.query(text);

await run(`
  CREATE SCHEMA IF NOT EXISTS spec;
  CREATE TABLE IF NOT EXISTS spec.schema_migration (
    filename   text PRIMARY KEY,
    sha256     text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
  );
`);

const appliedRows = await run("SELECT filename, sha256 FROM spec.schema_migration");
const applied = new Map((appliedRows.rows ?? appliedRows).map((r) => [r.filename, r.sha256]));

let ran = 0;
for (const f of files) {
  const body = readFileSync(join(dir, f), "utf8");
  const sha = createHash("sha256").update(body).digest("hex");
  const seen = applied.get(f);

  if (seen) {
    // ⛔ An edited migration is a silently different database. Refuse rather than
    // skip: skipping leaves two deployments claiming the same schema version
    // while disagreeing about what it means.
    if (seen !== sha) {
      console.error(
        `${f} was already applied but its contents have changed.\n` +
          `  recorded ${seen}\n  on disk  ${sha}\n` +
          "Add a new migration instead of editing an applied one.",
      );
      process.exit(1);
    }
    console.log(`  = ${f} (already applied)`);
    continue;
  }

  console.log(`  + ${f}`);
  await run(body);
  await run(
    `INSERT INTO spec.schema_migration (filename, sha256) VALUES ('${f}', '${sha}')`,
  );
  ran += 1;
}

console.log(ran === 0 ? "nothing to apply — the schema is current" : `applied ${ran} migration(s)`);
