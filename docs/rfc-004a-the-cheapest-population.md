# RFC-004a — the cheapest path to a real population

Status: **proposed**; §4 (the machine credential) and §5 (the job) landed in
#48. A narrowing of RFC-004 §5 Phase 3, written because the adapter is the only
item on the critical path this repo cannot unblock, and the question *"how much
of our model do we have to adopt to use this?"* deserves a smaller answer than
"implement a gRPC service".

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

## 4. The machine credential

`POST /api/evaluation` authenticates with the console's session cookie —
`principal()` resolves a signed-in human, or `SPEC_AUTHOR` in local development
— **or with a machine credential**, which is the thing this section used to say
did not exist. It is deliberately NOT a general-purpose API key:

- **Accepted only by `POST /api/evaluation`.** `/api/proposal/op` never consults
  it — that route calls `principal()`, which can only ever produce a `google:`
  or `dev:` sub — so a machine cannot reach the op door by construction, and
  `checkOp` refuses the `machine:` prefix as a second lock. A machine may report
  what it measured and may not author, amend or withdraw a requirement: the same
  boundary `proposal.ts` draws for agents, one door over.
- **A named principal.** The token's `sub` is `machine:<implementation>`, and
  that string is the `author` on the row. Invariant ⑤ is that nothing is
  attributed to nobody, and "a machine did it" is nobody.
- **Held in the project's CI secrets, rotatable, and useless for anything except
  appending counts.** An HS256 JWT signed with `SPEC_MACHINE_TOKEN_SECRET` — a
  secret of its own, required to differ from `SESSION_SECRET` — carrying
  `aud spec-console:evaluation`, `typ spec-machine+jwt`, a required `exp`
  (90 days by default, a year at most) and a `jti`, so one leaked token can be
  revoked by name (`SPEC_MACHINE_TOKEN_REVOKED`) without rotating the secret
  out from under every consumer. Rotating the secret kills every token at once;
  re-mint and redistribute.

Two rules ride on it, both enforced before anything is appended:

- **A machine reports, never judges.** `Passes` and `Fails` from a `machine:`
  author are refused (422). A count says how many records a check would
  examine; whether the claim holds over them is a judgment, and a
  `SELECT count(*)` did not make one. The rule lives in the shared conformance
  cases (`conformance/evaluation_cases.json`), so the Rust door says the same.
- **A credential reports for the implementation it names, and no other.** A
  token issued for `studio-nextjs` posting against `implementation: "ampere"`
  is a 403, not a rewrite.

And a presented credential is judged, never ignored: an `Authorization` header
that does not verify is a 401 here and now, never a fall-back to a cookie or
`SPEC_AUTHOR`. The refusals, by code: `E_MACHINE_TOKEN_REJECTED` (not this
console's, expired, or revoked), `E_MACHINE_TOKENS_UNCONFIGURED` (the
deployment has no machine secret), `E_IMPLEMENTATION_MISMATCH`.

Minting is an operator's laptop, not a route — `console/tools/mint-machine-token.mjs`,
walked through in `console/DEPLOY.md` → "Machine credentials". The verifier is
`console/lib/auth/machine.ts`; the tests that matter are
`console/test/routes.test.ts`, written as the attack.

## 5. The job

`tools/evaluation/post_evaluation.mjs` is the job: one dependency-free file a
project copies into its CI. It runs wherever the project's database is
reachable — which is the point: spec never sees the database, only the number.

```sh
# Your SQL, your pool, your credentials. Only the count leaves.
POP=$(psql "$DATABASE_URL" -X -A -t -c "$(cat checks/auth-24.sql)")

SPEC_CONSOLE_URL=https://spec.example.com SPEC_EVALUATION_TOKEN=… \
node post_evaluation.mjs --claim auth-24 --implementation studio-nextjs \
    --project studio --population "$POP" --sql-file checks/auth-24.sql
```

What it sends is §3's body: the claim, the implementation, the count, and
`sha256:` + the first 16 hex of the SHA-256 of the query text — so the count
can be reproduced later without storing what was counted. The outcome is a
function of the count, `Vacuous` at zero and `Examined` otherwise; the script
has no way to say `Passes`. `--dry-run` prints the body without reading the
token. `tools/evaluation/README.md` has the GitHub Actions and GitLab CI shapes
and the refusals the job will meet.

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
| **3a** | the CI job in §5, plus the machine credential in §4 | **shipped on the console side (#48).** What remains is the consumer's CI running it — days, and not this repo's days |
| **3b** | `Probe`, for the grounding conversation | weeks, and worth it once terms are being bound at volume |

The six-week clock RFC-004 §8 puts on Phase 3 should be started against **3a**
— from the day the first credential is handed over. If a count has not arrived
in that window, the blocker was never the protocol.
