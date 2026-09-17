#!/usr/bin/env node
/**
 * Apply the numbered SQL migrations, once each, in order.
 *
 *   DATABASE_URL='postgres://...' node db/migrate.mjs
 *
 * Deliberately not a schema-diff tool. The DDL here IS the invariant: a tool
 * that emitted `DROP CONSTRAINT zero_is_an_exception_never_a_pass` to reconcile a
 * model against a database would unmake invariant ③ silently, and none of them
 * handle roles, grants and triggers well anyway.
 *
 * ⚠ node-postgres, NOT @neondatabase/serverless. The serverless driver's HTTP
 * path runs ONE statement per request, and every migration here is a
 * multi-statement script with `$$` function bodies in it. The app uses the
 * serverless driver because it is right for a serverless request; migrations are
 * not that, and run over an ordinary connection.
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

import pg from "pg";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL is unset.");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

const client = new pg.Client({
  connectionString: url,
  // Neon requires TLS; a local test database has none. Decide from the URL
  // rather than disabling verification outright.
  ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: true },
});
await client.connect();

try {
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS spec;
    CREATE TABLE IF NOT EXISTS spec.schema_migration (
      filename   text PRIMARY KEY,
      sha256     text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
  `);

  // One writer at a time. Two deploys racing would both see "not applied" and
  // both run the same CREATE, and the loser's error is confusing rather than
  // informative.
  await client.query("SELECT pg_advisory_lock(hashtext('spec.migrate'))");

  const { rows } = await client.query("SELECT filename, sha256 FROM spec.schema_migration");
  const applied = new Map(rows.map((r) => [r.filename, r.sha256]));

  let ran = 0;
  for (const f of files) {
    const body = readFileSync(join(dir, f), "utf8");
    const sha = createHash("sha256").update(body).digest("hex");
    const seen = applied.get(f);

    if (seen) {
      // ⛔ An edited migration is a silently different database. Refuse rather
      // than skip: skipping leaves two deployments claiming the same schema
      // version while disagreeing about what it means.
      if (seen !== sha) {
        console.error(
          `\n${f} was already applied, but its contents have changed.\n` +
            `  recorded ${seen}\n  on disk  ${sha}\n\n` +
            "Add a new migration instead of editing an applied one.",
        );
        process.exit(1);
      }
      console.log(`  = ${f}`);
      continue;
    }

    // Each migration in its own transaction, with its ledger row written inside
    // it: a migration that half-applied and was recorded as done is the one
    // outcome there is no clean way back from.
    console.log(`  + ${f}`);
    await client.query("BEGIN");
    try {
      await client.query(body);
      await client.query(
        "INSERT INTO spec.schema_migration (filename, sha256) VALUES ($1, $2)",
        [f, sha],
      );
      await client.query("COMMIT");
      ran += 1;
    } catch (e) {
      await client.query("ROLLBACK");
      console.error(`\n${f} failed and was rolled back:\n  ${e.message}\n`);
      process.exit(1);
    }
  }

  console.log(ran === 0 ? "\nnothing to apply — the schema is current" : `\napplied ${ran} migration(s)`);
} finally {
  await client.end();
}
