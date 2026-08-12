# RFC-004a — the cheapest path to a real population

Status: **proposed**. A narrowing of RFC-004 §5 Phase 3, written because the
adapter is the only item on the critical path this repo cannot unblock, and the
question *"how much of our model do we have to adopt to use this?"* deserves a
smaller answer than "implement a gRPC service".

---

## 1. The short answer

**Almost none of it, and you can skip the adapter entirely for the first
numbers.**

`POST /api/evaluation` is deployed, authenticated and correct — it has been since
#29 — and it has never had a caller. A CI job in the project that runs one
`SELECT count(*)` and posts the result gets a requirement a real population with
**no proto, no service, no ontology and no spec vocabulary**. That is the whole
integration:

```
studio-nextjs CI  ──POST /api/evaluation──▶  console  ──▶  spec.evaluation_log
   one SQL count                                            (append-only)
```

AUTH-24 stops reading `— / NOT-EVALUATED` and starts reading
**"1,412 records, undecided"**, which is the sentence this repo was built to make
possible.

## 2. What actually crosses the boundary

The two RPCs in `proto/spec/v1/grounding_adapter.proto` cost very differently,
and conflating them is what makes the adapter look expensive.

| | what it asks of the project | how much of spec's model it carries |
|---|---|---|
| `Probe` | "given these strings *you wrote*, how many records does each match?" | **none** — `invariant_id` and `term_id` are opaque and echoed back, and the proto says outright: *"The project decides what a locator means; spec never parses one"* |
| `Evaluate` | "resolve this `Grounding`, run this `Check`, and decide the predicate" | **a lot** — both types come from `invariant.proto` |

So the shoehorning risk is real and it lives entirely in `Evaluate`. RFC-004 §4.2
already declines it: 25 of Studio's 69 predicates use implication or lattice
language and none carries a numeric threshold, so `Evaluate` for AUTH-24 is a
decision procedure over Studio's authorization lattice — a research project, not
an endpoint.

**Ship `Probe`, never ship `Evaluate`.** Everything then lands on `Examined`:
measured, undecided. That is the honest state, it is what `OUTCOME_EXAMINED`
exists for, and its price is stated in RFC-004 §4.2 — no Studio requirement can
ever read "Enforced". A column of real numbers beats a column of em dashes.

And the direction of travel is worth naming: a locator is written by *your*
engineer in *your* vocabulary during binding. The model that crosses the wire is
yours, moving outward. Nothing of spec's moves in.

## 3. The evaluation POST, exactly

Verified against `console/lib/evaluation.ts` and `console/app/api/evaluation/route.ts`.

```jsonc
POST /api/evaluation
{
  "claim":             "auth-24",         // REQUIRED — an evaluation of nothing is not a measurement
  "implementation":    "studio-nextjs",   // REQUIRED — the same claim can pass in one product and be
                                          //            ungroundable in another; an unattributed count
                                          //            cannot tell you which
  "outcome":           "Examined",        // Passes | Fails | Examined | Vacuous | CannotBeGrounded
  "population":        1412,              // integer; REQUIRED for Passes/Fails/Examined
  "project":           "studio",          // optional
  "query_fingerprint": "sha256:9f2c1a…",  // optional, and the thing that makes a count reproducible
  "detail":            ""                 // optional, failure case only — not evidence
}
→ 202 { "recorded": true, "log_seq": 1, … }
```

Three refusals you will meet, and each is deliberate:

- **`Examined` with `population: 0` → 422.** Zero is an exception, never a
  result. Report `Vacuous`, which is what it is. This is the entire point of the
  system and it is enforced in six independent places.
- **A positive outcome with no `population` → 422.** A result nobody can audit.
- **No principal → 401.** See §4.

**Report `Examined`, not `Passes`.** A count is a measurement; a pass is a
judgement. The adapter measures a population and refuses to decide the predicate,
and a CI job posting `Passes` would be making a claim its `SELECT count(*)` did
not check.

## 4. The one thing that does not exist yet

`POST /api/evaluation` authenticates with the console's session cookie —
`principal()` resolves a signed-in human, or `SPEC_AUTHOR` in local development.
**A CI job has neither.** There is no machine credential in this system today, so
the job in §1 gets a 401.

That is a small, well-scoped addition and it should NOT be a general-purpose API
key:

- A bearer token accepted **only** by `POST /api/evaluation`. Not by
  `/api/proposal/op` — a machine may report what it measured and may not author,
  amend or withdraw a requirement, which is the same boundary
  `proposal.ts:141-146` already draws for agents.
- The token maps to a **named** principal, not to an anonymous one. Invariant ⑤
  is that nothing is attributed to nobody, and "a machine did it" is nobody. The
  natural name is the `implementation` the token is issued for, recorded as
  `author: "machine:studio-nextjs"`.
- Held in the project's CI secrets, rotatable, and useless for anything except
  appending counts.

Until that exists, §5 is runnable by a person with a session cookie, which is
enough to prove the path end to end before anyone builds anything.

## 5. The job

```js
// A dependency-free sketch. Runs wherever the project's database is reachable —
// which is the point: spec never sees the database, only the number.
import { createHash } from "node:crypto";

const CONSOLE = process.env.SPEC_CONSOLE_URL;   // https://spec-…vercel.app
const TOKEN   = process.env.SPEC_EVALUATION_TOKEN;  // §4

// One entry per grounded requirement. The SQL is YOURS — spec never parses it,
// never stores it, and never sees a row it selected.
const CHECKS = [
  {
    claim: "auth-24",
    sql: `SELECT count(*) FROM team_memberships WHERE role = 'deployer'`,
  },
];

for (const { claim, sql } of CHECKS) {
  const { rows } = await db.query(sql);           // your pool, your credentials
  const population = Number(rows[0].count);

  const res = await fetch(`${CONSOLE}/api/evaluation`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      claim,
      project: "studio",
      implementation: "studio-nextjs",
      // ⛔ Examined, never Passes. The count says how many records a check WOULD
      // examine. Whether the claim holds over them is a different question and
      // this job did not answer it.
      outcome: population === 0 ? "Vacuous" : "Examined",
      population,
      // Reproduces the count later without storing what was counted.
      query_fingerprint: `sha256:${createHash("sha256").update(sql).digest("hex").slice(0, 16)}`,
    }),
  });

  if (!res.ok) throw new Error(`${claim}: ${res.status} ${await res.text()}`);
}
```

Note what is absent: no `.proto`, no generated client, no ontology import, no
term ids, no rungs. A list of `(claim, SQL)` pairs and one POST.

## 6. What this does not get you

- **No candidate readings.** The "three fields could mean *a sponsor they
  brought*, and they disagree by 47 sponsors" conversation needs `Probe`, because
  it needs counts for readings nobody has committed to yet. This job only counts
  a reading already chosen.
- **No examples.** `DisplayExample` is transit-only and exists for that same
  conversation. Nothing here renders a row.
- **Nothing reads "Enforced".** By construction, as in §2.
- **Drift is not watched.** A count posted once is a count from that day. Running
  the job on a schedule is what turns it into a tripwire, and RFC-004 §3.2's
  `drift-watch` is the same idea with a model attached.

## 7. Where this leaves RFC-004

Phase 3 splits in two, and only the first half is on the critical path:

| | | |
|---|---|---|
| **3a** | the CI job in §5, plus the machine token in §4 | days, no proto, unblocks the first real population |
| **3b** | `Probe`, for the grounding conversation | weeks, and worth it once terms are being bound at volume |

The six-week clock RFC-004 §8 puts on Phase 3 should be started against **3a**.
If a count has not arrived in that window, the blocker was never the protocol.
