#!/usr/bin/env node
/**
 * Give `spec_app` a password, so it can finally connect.
 *
 *   DATABASE_URL='<owner>' SPEC_APP_PASSWORD='...' node db/set-app-password.mjs
 *
 * The migrations create the role deliberately WITHOUT one: it exists and cannot
 * connect until somebody does this on purpose, which is the safe default. A
 * credential does not belong in a migration either — that would put it in git,
 * in the ledger's sha256, and in every clone.
 *
 * ⚠ Run it from CI with the password as a secret, or locally against a database
 * you own. It is separate from `migrate.mjs` so that applying schema and issuing
 * a credential stay separate acts.
 */
import pg from "pg";

const url = process.env.DATABASE_URL?.trim();
const password = process.env.SPEC_APP_PASSWORD;

if (!url) {
  console.error("DATABASE_URL is unset.");
  process.exit(1);
}
// ⛔ No default and no generated fallback. A password nobody chose is a password
// nobody can rotate, and one printed to a CI log is one that leaked.
if (!password || password.length < 16) {
  console.error(
    "SPEC_APP_PASSWORD is unset or shorter than 16 characters.\n" +
      "  Generate one with `openssl rand -base64 24` and store it as a secret.",
  );
  process.exit(1);
}

const client = new pg.Client({
  connectionString: url,
  ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: true },
});
await client.connect();
try {
  const { rows } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'spec_app'");
  if (rows.length === 0) {
    console.error("spec_app does not exist — run the migrations first.");
    process.exit(1);
  }
  // Parameters are not allowed in ALTER ROLE, so quote it as a literal. Never
  // interpolate raw: a password containing a quote would end the statement.
  const quoted = await client.query("SELECT quote_literal($1) q", [password]);
  await client.query(`ALTER ROLE spec_app WITH PASSWORD ${quoted.rows[0].q}`);

  // ⛔ Never print the password, and never print a connection string containing
  // it. Print what someone needs to BUILD one instead.
  const who = await client.query(
    "SELECT current_database() db, (SELECT rolcanlogin FROM pg_roles WHERE rolname='spec_app') can_login",
  );
  console.log("spec_app password set.");
  console.log(`  database: ${who.rows[0].db}   can_login: ${who.rows[0].can_login}`);
  console.log("  Build the app URL as:");
  console.log("    postgres://spec_app:<the password>@<host from the owner url>/<database>?sslmode=require");
  console.log("  That string — not the owner url — is what the console gets.");
} finally {
  await client.end();
}
