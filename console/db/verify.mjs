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
import { createHash } from "node:crypto";

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

// ── the record this file proposes, built the way the door builds one ─────────
//
// Written out rather than imported: this script runs on a laptop and in
// migrate.yml with nothing installed but `pg`, and console/lib/address.ts is
// TypeScript. Building the bytes by hand is also the point — it is a THIRD
// construction of the pre-image, so a change to the rule that nobody mirrored
// here fails against the real database rather than agreeing with itself.
const OPS = '[{"op":"retractNS","reason":"verify","subject":"verify"}]';
const AUTHOR = "verify";
const PARENT = "corpus:verify";

// ⛔ Keys sorted, as canonicalJson emits them. `surface` and `intent` are in the
// stored bytes and NOT in the pre-image — RFC-002 §4.1: the door does not see
// provenance, so the same change from two surfaces has one address.
const CANONICAL =
  `{"author":"${AUTHOR}","intent":null,"ops":${OPS},"parent":"${PARENT}","surface":"Meridian"}`;
const PRE_IMAGE = `{"author":"${AUTHOR}","ops":${OPS},"parent":"${PARENT}"}`;
const ADDRESS = "sha256:" + createHash("sha256").update(PRE_IMAGE, "utf8").digest("hex");

const line = (over = {}) => {
  const rec = {
    address: ADDRESS,
    author: AUTHOR,
    author_email: "verify@invalid",
    canonical: CANONICAL,
    parent: PARENT,
    surface: "Meridian",
    verdict: "Admitted",
    ...over,
  };
  // Keys sorted, no whitespace — the same shape the log carries.
  return JSON.stringify(rec, Object.keys(rec).sort());
};

const PROPOSAL_LINE = line();

/** The door's append, as the app calls it. */
const appendProposal = (over = {}) => {
  const o = { line: line(over), parent: PARENT, author: AUTHOR, email: "verify@invalid",
              surface: "Meridian", canonical: CANONICAL, address: ADDRESS, verdict: "Admitted", ...over };
  const sql = (v) => (v === null ? "NULL" : `'${v}'`);
  return `SELECT spec.append_proposal(${sql(o.line)}, ${sql(o.parent)}, ${sql(o.author)},
     ${sql(o.email)}, ${sql(o.surface)}, ${sql(o.canonical)}, ${sql(o.address)}, ${sql(o.verdict)})`;
};

/** A hand-written INSERT — the path that routes around the function. */
const insert = (cols) => {
  const c = { line: PROPOSAL_LINE, parent: PARENT, author: AUTHOR, author_email: "verify@invalid",
              surface: "Meridian", canonical: CANONICAL, address: ADDRESS, verdict: "Admitted", ...cols };
  const v = (x) => (x === null ? "NULL" : `'${x}'`);
  return `INSERT INTO spec.proposal_log (line, parent, author, author_email, surface, canonical, address, verdict)
     VALUES (${v(c.line)}, ${v(c.parent)}, ${v(c.author)}, ${v(c.author_email)},
             ${v(c.surface)}, ${v(c.canonical)}, ${v(c.address)}, ${v(c.verdict)})`;
};

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
  await must("accept", "a well-formed proposal", appendProposal());

  console.log("\n② a proposal is not the corpus — the log never forgets:");
  await must("refuse", "UPDATE", "UPDATE spec.proposal_log SET parent = 'tampered'");
  await must("refuse", "DELETE", "DELETE FROM spec.proposal_log");
  // Statement-level, not row-level: the INTENT is refused, not merely the rows.
  await must("refuse", "DELETE ... WHERE false", "DELETE FROM spec.proposal_log WHERE false");
  await must("refuse", "TRUNCATE", "TRUNCATE spec.proposal_log");

  console.log("\n⑤ nothing is attributed to nobody:");
  await must("refuse", "an author of only whitespace", insert({ author: "   " }));
  await must("refuse", "no read point", insert({ parent: "" }));
  await must("refuse", "a decomposition that disagrees with its own line",
    insert({ parent: "corpus:DIFFERENT" }));

  console.log("\nthe door: a proposal has a name, and the decision that let it in:");
  // ⛔ The address is the one field a record cannot be given later. RFC-002 §5's
  // `Proposal.id`, over {author, ops, parent} — NOT over the stored bytes, which
  // also carry the surface. §9.1: a click and a chat that author the same change
  // are one proposal with two provenance records.
  await must("refuse", "an address that disagrees with its own line",
    insert({ address: "sha256:" + "0".repeat(64) }));
  await must("refuse", "a verdict that disagrees with its own line",
    insert({ verdict: "Queued" }));
  await must("refuse", "an address that is not a sha256 content address",
    insert({ line: line({ address: "deadbeef" }), address: "deadbeef" }));
  // Case matters: an upper-case digest names the same bytes with a different
  // string, and two spellings of one address is what pinning the spelling avoids.
  await must("refuse", "an UPPER-CASE digest",
    insert({ line: line({ address: ADDRESS.toUpperCase().replace("SHA256", "sha256") }),
             address: ADDRESS.toUpperCase().replace("SHA256", "sha256") }));
  // ⛔ `Rejected` is not a value this table can hold, because a rejected proposal
  // is never appended at all. Partial admission (Queued) is; refusal is not.
  await must("refuse", "a Rejected verdict — a refused proposal is not appended",
    insert({ line: line({ verdict: "Rejected" }), verdict: "Rejected" }));
  await must("refuse", "a verdict outside au:Verdict",
    insert({ line: line({ verdict: "Probably" }), verdict: "Probably" }));
  // Half a door is not a door.
  await must("refuse", "an address with no verdict",
    insert({ line: line({ verdict: undefined }), verdict: null }));
  await must("refuse", "the door called with no address at all",
    appendProposal({ line: line({ address: undefined }), address: null }));
  // ⛔ ONE OVERLOAD. 0004 dropped the six-argument form; if it came back, a caller
  // could append a record with no address by picking the older signature.
  await must("refuse", "the retired six-argument append_proposal",
    `SELECT spec.append_proposal('${PROPOSAL_LINE}', '${PARENT}', '${AUTHOR}',
       'verify@invalid', 'Meridian', '${CANONICAL}')`);

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

  console.log("\n④ a machine reports, never judges:");
  // RFC-004a §4. The same refusal as console/lib/evaluation.ts and
  // services/spec/src/evaluation.rs, at the one layer a hand-written INSERT
  // cannot route around.
  const machineEval = (outcome, population) =>
    `INSERT INTO spec.evaluation_log (line, claim, project, implementation, outcome,
       population, query_fingerprint, author, detail)
     VALUES ('{"author":"machine:verify","claim":"verify","implementation":"verify","outcome":"${outcome}","population":${population}}',
             'verify', 'verify', 'verify', '${outcome}', ${population}, '', 'machine:verify', '')`;
  await must("accept", "a machine reporting Examined over 1412", machineEval("Examined", 1412));
  await must("accept", "a machine reporting Vacuous over 0", machineEval("Vacuous", 0));
  await must("refuse", "a machine judging Passes", machineEval("Passes", 88));
  await must("refuse", "a machine judging Fails", machineEval("Fails", 88));
  // The control: the same judgement from a person is exactly what the log is for.
  await must("accept", "a PERSON judging Passes over 88", appendEval("Passes", 88));

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
