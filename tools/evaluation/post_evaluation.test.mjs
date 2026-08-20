// node --test tools/evaluation/post_evaluation.test.mjs
//
// The consumer script's pure half. The fingerprint is the thing that makes a
// count reproducible later without storing what was counted, so it is pinned
// to a known value; and the script must be incapable of building a judgment.
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildBody, fingerprint, parseArgs } from "./post_evaluation.mjs";

const SQL = "SELECT count(*) FROM team_memberships WHERE role = 'deployer'";

test("the fingerprint is sha256: plus the first 16 hex of the query text (RFC-004a §5)", () => {
  assert.equal(fingerprint(SQL), "sha256:b05e76b22a0cc44b");
  assert.notEqual(fingerprint(SQL), fingerprint(`${SQL} `), "whitespace is part of the query");
});

test("zero is Vacuous, a count is Examined, a check that could not run is CannotBeGrounded", () => {
  const base = { claim: "auth-24", implementation: "studio-nextjs", project: "studio", sql: SQL };
  assert.deepEqual(buildBody({ ...base, population: 0 }), {
    claim: "auth-24", implementation: "studio-nextjs", project: "studio",
    outcome: "Vacuous", population: 0, query_fingerprint: "sha256:b05e76b22a0cc44b",
  });
  assert.deepEqual(buildBody({ ...base, population: 1412 }), {
    claim: "auth-24", implementation: "studio-nextjs", project: "studio",
    outcome: "Examined", population: 1412, query_fingerprint: "sha256:b05e76b22a0cc44b",
  });
  const cbg = buildBody({ ...base, population: null, detail: "table does not exist" });
  assert.equal(cbg.outcome, "CannotBeGrounded");
  assert.equal("population" in cbg, false, "nothing ran, so there is nothing to have counted");
  assert.equal(cbg.detail, "table does not exist");
});

test("⛔ a judgment cannot be built: no input produces Passes or Fails", () => {
  const base = { claim: "auth-24", implementation: "studio-nextjs" };
  for (const population of [0, 1, 88, 1412, null]) {
    const { outcome } = buildBody({ ...base, population, outcome: "Passes" });
    assert.ok(["Examined", "Vacuous", "CannotBeGrounded"].includes(outcome), outcome);
  }
  assert.throws(() => buildBody({ ...base, population: -1 }));
  assert.throws(() => buildBody({ ...base, population: 1.5 }));
  assert.throws(() => buildBody({ ...base, population: Number.NaN }));
});

test("an evaluation of nothing, or of nobody, is refused before it is sent", () => {
  assert.throws(() => buildBody({ claim: "", implementation: "x", population: 1 }), /claim/);
  assert.throws(() => buildBody({ claim: "auth-24", implementation: "", population: 1 }), /implementation/);
});

test("the CLI parses, and refuses what it does not know", () => {
  const a = parseArgs(["--claim", "auth-24", "--implementation", "x", "--population", "5", "--dry-run"]);
  assert.equal(a.claim, "auth-24");
  assert.equal(a.population, "5");
  assert.equal(a.dryRun, true);
  assert.throws(() => parseArgs(["--outcome", "Passes"]), /unknown argument/);
  assert.throws(() => parseArgs(["--claim"]), /needs a value/);
});
