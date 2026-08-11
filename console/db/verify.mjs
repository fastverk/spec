#!/usr/bin/env node
/**
 * Prove the door refuses, against the real database, writing nothing.
 *
 *   DATABASE_URL='postgres://...' node db/verify.mjs
 *
 * A schema that has been APPLIED is not the same fact as a schema that REFUSES.
 * The migrations create triggers, grants and CHECK constraints; this exercises
 * every one of them and fails if any accepts what it exists to reject. A gate
 * that has never been shown to reject anything is an assertion, not a check —
 * so the migration workflow runs this immediately after applying.
 *
 * ⛔ EVERYTHING RUNS INSIDE ONE TRANSACTION THAT IS ALWAYS ROLLED BACK.
 *
 * This is not tidiness. The log is append-only BY DESIGN: there is no UPDATE and
 * no DELETE, so a verification record cannot be removed afterwards. Verifying
 * against a live database therefore permanently pollutes the log with rows
 * attributed to a person who never proposed anything — measured the hard way,
 * against a real Neon database, where the only honest cleanup left was dropping
 * the schema and starting over.
 *
 * Inside a rolled-back transaction the proof still holds: BEFORE triggers fire
 * and raise, CHECK constraints evaluate, and grants are enforced — all before
 * any commit. What does not survive is the data.
 *
 * ⚠ One thing DOES survive a rollback: consumed sequence values. Sequences are
 * non-transactional, so `seq` will show gaps. That is already true of any refused
 * insert and is documented in 0001_schema.sql: a gap means the door did its job,
 * never that a record was removed.
 */
import pg from "pg";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL is unset.");
  process.exit(1);
}

const client = new pg.Client({
  connectionString: url,
  ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: true },
});

let failures = 0;
let checks = 0;

/** `expect` is what the database is supposed to do: "accept" or "refuse". */
async function must(expect, label, sql) {
  checks += 1;
  // A failed statement aborts the transaction, so each case gets a savepoint.
  await client.query("SAVEPOINT s");
  try {
    await client.query(sql);
    if (expect === "refuse") {
      failures += 1;
      console.log(`  ✗ ACCEPTED — ${label}`);
      console.log("      it was supposed to refuse this");
    } else {
      console.log(`  ✓ accepted — ${label}`);
    }
    await client.query("RELEASE SAVEPOINT s");
  } catch (e) {
    await client.query("ROLLBACK TO SAVEPOINT s");
    if (expect === "refuse") {
      console.log(`  ✓ refused  — ${label}`);
    } else {
      failures += 1;
      console.log(`  ✗ REFUSED  — ${label}`);
      console.log(`      ${e.message}`);
    }
  }
}

const PROPOSAL_LINE =
  '{"author":"verify","author_email":"verify@invalid","canonical":"{}",' +
  '"parent":"corpus:verify","surface":"Meridian"}';

const evalLine = (outcome, population) =>
  `{"author":"verify@invalid","claim":"verify","implementation":"verify",` +
  `"outcome":"${outcome}","population":${population}}`;

const appendEval = (outcome, population) =>
  `SELECT spec.append_evaluation('${evalLine(outcome, population)}', 'verify', 'verify',
     'verify', '${outcome}', ${population}, '', 'verify@invalid', '')`;

await client.connect();
try {
  await client.query("BEGIN");

  console.log("\nthe log accepts an append:");
  await must("accept", "a well-formed proposal",
    `SELECT spec.append_proposal('${PROPOSAL_LINE}', 'corpus:verify', 'verify',
       'verify@invalid', 'Meridian', '{}')`);

  console.log("\n② a proposal is not the corpus — the log never forgets:");
  await must("refuse", "UPDATE", "UPDATE spec.proposal_log SET parent = 'tampered'");
  await must("refuse", "DELETE", "DELETE FROM spec.proposal_log");
  // Statement-level, not row-level: the INTENT is refused, not merely the rows.
  await must("refuse", "DELETE ... WHERE false", "DELETE FROM spec.proposal_log WHERE false");
  await must("refuse", "TRUNCATE", "TRUNCATE spec.proposal_log");

  console.log("\n⑤ nothing is attributed to nobody:");
  await must("refuse", "an author of only whitespace",
    `INSERT INTO spec.proposal_log (line, parent, author, author_email, surface, canonical)
     VALUES ('${PROPOSAL_LINE}', 'corpus:verify', '   ', '', 'Meridian', '{}')`);
  await must("refuse", "no read point",
    `INSERT INTO spec.proposal_log (line, parent, author, author_email, surface, canonical)
     VALUES ('${PROPOSAL_LINE}', '', 'verify', '', 'Meridian', '{}')`);
  await must("refuse", "a decomposition that disagrees with its own line",
    `INSERT INTO spec.proposal_log (line, parent, author, author_email, surface, canonical)
     VALUES ('${PROPOSAL_LINE}', 'corpus:DIFFERENT', 'verify', 'verify@invalid', 'Meridian', '{}')`);

  console.log("\n③ zero is an exception, never a pass:");
  await must("accept", "Vacuous over 0 records", appendEval("Vacuous", 0));
  await must("accept", "CannotBeGrounded over 0 records", appendEval("CannotBeGrounded", 0));
  await must("accept", "Passes over 88 records", appendEval("Passes", 88));
  await must("refuse", "Passes over 0 records", appendEval("Passes", 0));
  await must("refuse", "Fails over 0 records", appendEval("Fails", 0));
  // ⛔ The same lie in a quieter voice. `Examined` asserts there were records to
  // look at; over zero there were not.
  await must("refuse", "Examined over 0 records", appendEval("Examined", 0));
  await must("refuse", "Passes with no population at all", appendEval("Passes", "null"));
  await must("refuse", "a negative population", appendEval("Passes", -1));
  await must("refuse", "an outcome outside the closed vocabulary", appendEval("Probably", 5));

  console.log("\nthe line-terminator domain:");
  await must("refuse", "a line carrying U+2028",
    `INSERT INTO spec.proposal_log (line, parent, author, author_email, surface, canonical)
     VALUES ('{"a":"x' || U&'\\2028' || 'y"}', 'p', 'verify', 'verify@invalid', 'Meridian', '{}')`);

  // ⛔ Always. There is no success path that commits.
  await client.query("ROLLBACK");

  const { rows } = await client.query(
    `SELECT (SELECT count(*) FROM spec.proposal_log) p,
            (SELECT count(*) FROM spec.evaluation_log) e`,
  );
  console.log(`\nafter rollback the log holds ${rows[0].p} proposal(s) and ${rows[0].e} evaluation(s) — `
    + "verification writes nothing it cannot take back");

  if (failures > 0) {
    console.error(`\nFAIL — ${failures} of ${checks} behaviours were wrong`);
    process.exit(1);
  }
  console.log(`\nOK — ${checks} behaviours verified against the live database`);
} catch (e) {
  try { await client.query("ROLLBACK"); } catch { /* already aborted */ }
  console.error(`\nverification could not run: ${e.message}`);
  process.exit(1);
} finally {
  await client.end();
}
