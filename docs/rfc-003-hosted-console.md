# RFC-003 — the hosted console: Vercel, Neon, and one set of safety cases

Status: **in progress**. The console is built, runs, and replaces `portal/`; the
safety rules are ported and gated. It has not been deployed against Neon or a
real identity provider. §10 says exactly what is outstanding.

Companion to RFC-002 (the authoring plane) and RFC-002a (the browser authoring
path). Those two describe a write path that works on one laptop. This one is
about the fact that it works *only* on one laptop.

---

## 1. Why

Everything below the browser already existed and was gated: a generated TTL
corpus with SPARQL/SHACL gates run by Bazel in CI, a read model projected to
committed JSON, a Rust service serving it, and a Vite SPA with the full write
path. None of it was reachable by a product owner. `portal/` had no image, no
chart, no CI publish and no deployment story of any kind — it ran as `vite dev`
on `127.0.0.1:5174`, and its identity came from a dev proxy injecting headers
from an environment variable.

`portal/` is now **retired**; the console replaces it. Keeping both would have
meant two frontends against one read model, drifting — which is the same failure
this RFC spends §3 avoiding between Rust and TypeScript, at the UI layer.

The measurement that makes this urgent: **AUTH-24** — *"sponsor:edit never
implies deploy"* — grounded on the deployer role, examines **0 records** in
Studio. A check there would report success forever, having examined nothing. The
machinery to refuse that exists and nobody outside the repo can see it work.

## 2. The obstacles, and what each forces

| obstacle | consequence |
|---|---|
| the Rust service has no natural Vercel runtime | the reads and writes are ported to Route Handlers |
| the JSONL logs need a filesystem serverless does not have | genuine runtime state moves to Neon; nothing else does |
| identity comes from a Vite dev proxy | Google OAuth restricted to one Workspace domain by the `hd` claim, read server-side, never from a body or a client-settable header |
| the adapter is reached at `localhost:3010` | it becomes a configured origin that degrades honestly when unset |

Two things do **not** move. The corpus stays generated and gated in CI — the
console *imports* the committed read-model JSON, so a page cannot render a
`corpus_version` other than the one it shipped with. And the Rust service stays
on the Bazel/plugin plane: `backend.rs` is a filesystem estate indexer for the
Lean plane, which has no meaning on Vercel and no reason to leave.

## 3. The risk this RFC is mostly about

The port duplicates three rules: the vacuous refusal, the pending overlay, and
the adoption computation.

**Two implementations of a safety rule diverge silently.** Not loudly — each
keeps passing its own suite while they drift apart, and the suites are the only
thing anybody looks at. The rule that decides whether a green build tested
anything is the worst possible candidate for that.

So the cases live in `conformance/*.json`, in a language neither implementation
is written in, and both execute *those*. Porting the tests alongside the logic
was considered and rejected: it leaves two suites free to drift in exactly the
way the two implementations are.

### 3.1 The part that does not work yet, said plainly

`//services/spec:spec_test` — where the Rust half runs — executes only when CI
can mint a token for the private plugin crates. That step is `continue-on-error`
and it has been skipping. On an ordinary PR the TypeScript half runs and the Rust
half does not.

Three mitigations, in the order they pay off:

1. **`conformance/check_conformance.py`** — stdlib-only, no toolchain, runs
   unconditionally under `//conformance/...`. It parses the constants out of both
   sources and *re-derives every evaluation verdict from them*. Dropping
   `Examined` from `POSITIVE` — a one-word edit that silently permits a vacuous
   pass under a quieter name — fails three checks on a normal PR. Verified by
   making the edit and watching it fail.
2. **The reader ⊆ vocabulary check** (§5.2), which catches the class of bug that
   motivated it.
3. Making the skipped step *visible* in the job summary, so "did the Rust half
   run on the commit that shipped?" is answerable after the fact.

⚠ **The residual hole.** All of that checks the *data* the rule is made of, not
the control flow that reads it. Reordering the guards in `evaluation::check` so
the zero-check becomes unreachable leaves every constant intact and passes. Only
`//services/spec:spec_test` catches that, and it needs the credential fixed.
These are mitigations for that target being unrunnable, not a replacement.

## 4. Shape

One Next.js app. The eight corpus reads are **imported**, so those pages are pure
functions of the build. Only the overlay needs the database.

```
console/
  lib/evaluation.ts     the vacuous refusal        <- conformance/evaluation_cases.json
  lib/overlay.ts        pending + adoption         <- conformance/overlay_cases.json
  lib/evaluated.ts      measurements, and stateOf (the display half of the refusal)
  lib/proposal.ts       the closed op vocabulary, 17 constructors
  lib/canonical.ts      canonical JSON — the pre-image of a content address
  lib/corpus.ts         the imported read model, and CORPUS_VERSION
  lib/project.ts        which project a pane opens on, and the unscoped-row rule
  lib/auth/             Google OAuth, and the session cookie
  db/migrations/        the two append-only tables
  app/                  seven panes, six route handlers
  test/conformance.test.ts
  test/project.test.ts
```

**Requirements and Terms render the corpus statically and fetch the overlay
client-side.** The alternative — applying the overlay server-side — has two
defects: a database outage makes the corpus itself unviewable, and it conflates
*"nothing is pending"* with *"could not ask"*. With the split, the corpus is
always readable and pending state is either attributed or explicitly absent:

> could not read pending proposals — showing the corpus only

which is a different statement from "nothing pending". That is the same
distinction as `Vacuous` versus `CannotBeGrounded`, applied to the overlay.

The overlay is **never cached**. It is rebuilt on read rather than invalidated,
so a write is visible on the very next request without an invalidation protocol
to get wrong. A stale overlay tells an author their write did not land.

## 5. What landed in this change

### 5.1 Two op-vocabulary bugs, and one that was not one

Three of six write paths answered 422 and appended nothing:

- `amendNS` sent `discipline`; `OPS` did not declare it → **fixed in `OPS`**.
- `assertNS` sent `project`; `OPS` did not declare it → **fixed in `OPS`**.
- `retractNS` omitted the required `reason` → **fixed in the caller**.

The third is the interesting one. `retractNS` requiring a reason is deliberate —
*"retract never deletes; it demotes,"* and a demotion with no stated ground is
indistinguishable from a mistake. So Withdraw now asks for the ground rather than
the vocabulary accepting its absence.

Both `OPS` gaps had the same shape: `overlay.rs` *already read* the fields the
door rejected. The two halves of the write path disagreed in the direction where
the feature simply does not work, and nothing said so.

### 5.2 So the disagreement is now a gate

`check_conformance.py` parses every `s(op, "field")` out of `overlay.rs`'s match
arms and asserts the field is one that `proposal.rs::OPS` declares for that op.
Reverting either fix fails it with the reason. Nothing in the type system
connects a field read to the `OpSpec` that permits it, so the connection is made
there.

### 5.3 A served route nobody declared

`POST /evaluation` was served since #29 and named in no `routes.rs` table.
`routes_match_describe` compares GET routes only, and `check_wiring.py` checked
declared→registered but never the reverse — so the shell could not resolve
`spec.v1.Authoring/SubmitEvaluation`, and the failure reads in a browser as a
console bug. Declared now, and `check_wiring.py` checks both directions (169 → 194
checks).

### 5.4 A silently dropped proposal

`materialize.py` split its log with `str.splitlines()`. Python splits on U+2028,
U+2029 and U+0085; JSON does not, and `serde_json` emits all three **raw** inside
a string. A proposal carrying a LINE SEPARATOR — pasting from a PDF is the usual
way — became two fragments, neither of which parsed, and both were skipped by the
`except`. The record stayed in the log, never promoted, and read as *"pending,
not yet adopted"* in the console forever, with no error anywhere.

Measured, not inferred: one such line splits into 2 pieces and 0 of them
`json.loads()`. Fixed to `split("\n")`, and the database refuses to hold such a
line at all (§6).

## 6. Neon

Two tables, `spec.proposal_log` and `spec.evaluation_log` — separate, because
replaying judgements and measurements from one table would make *"who decided
this"* and *"what did it measure"* the same question.

Each row stores the **log line verbatim** plus derived columns, with a CHECK that
the decomposition matches the line. Export is then `SELECT line ORDER BY seq`,
with no serializer that could reorder keys — which matters because `canonical` is
the pre-image of a content address, and `jsonb` would sort keys by
length-then-bytes rather than lexicographically.

Append-only is enforced by the database:

- statement-level `BEFORE UPDATE/DELETE/TRUNCATE` triggers that **raise**. Not a
  rule that swallows: `DO INSTEAD NOTHING` makes the UPDATE *succeed* affecting
  zero rows, which is the same family of error as reporting a pass over an empty
  population.
- `INSERT, SELECT` grants and nothing else. TRUNCATE is a separate privilege and
  is not implied by DELETE — leaving it reachable empties the log in one
  statement.
- a CHECK constraint that is the **fourth** independent refusal of a vacuous
  pass, and the only one that survives a hand-written INSERT.

Ordering: an advisory lock in the append function, because `GENERATED AS
IDENTITY` allocates `seq` before commit, so two invocations can take 41 and 42 and
commit in the other order. "Later wins" must not depend on who fsynced first.

`log_offset` (a byte offset) becomes `log_seq`. Nothing read it, so this is a
documented-surface change rather than a consumer-breaking one.

## 7. Identity

The rule is unchanged: a write with no principal is refused, never attributed to
nobody. What changes is where the principal comes from. spec's plugin trusts
`x-fastverk-user-sub` because a gateway it trusts injected them; **the console is
the edge**, so anything client-supplied is client-controlled. The session is read
server-side on every write.

The dev shim returns `null` when unconfigured, so an unconfigured environment
refuses writes. There is no `dev@localhost` fallback: a default author is
attribution to nobody wearing a name. Because the log is append-only, a
dev-authored record can never be removed — so it stamps `sub` as `dev:<email>`,
self-labelling forever.

Since #48 there is a second source of a principal, and it is a different type
on purpose. A consumer's CI holds a **machine credential** — an HS256 JWT under
its own secret, `aud spec-console:evaluation`, a required expiry and a
revocable `jti` (RFC-004a §4) — and `console/lib/auth/machine.ts` resolves it
to a `MachinePrincipal`: `sub machine:<implementation>`, no email, no kernel,
no agent capability. It is not assignable to `Principal`, so it cannot be handed
to `checkProposal`; only the evaluation route consults it, so it cannot reach
the op door; and `checkOp` refuses the `machine:` prefix regardless. A machine
reports what it measured and may not author, and the type system, the routing
and the door each say so separately. Like `dev:<email>`, the `machine:` author
is self-labelling forever in an append-only log.

## 8. The adapter, and the promotion loop

**The adapter is deferred.** Its commits are unpushed on a GitLab repo by
standing instruction. It becomes a configured origin; unset, the proxy answers
503 with `outcome: "CANNOT_BE_GROUNDED"` in the shape the client already handles,
so the UI renders an honest state rather than an error toast. It must **never**
manufacture `{population: {count: 0}}` — that is indistinguishable from a real
zero and would fabricate the exact vacuous measurement the door refuses.

This costs less than it looks. The vacuous refusal is a pure function of the
submitted measurement and does not care where the count came from, so the AUTH-24
refusal is demonstrable the moment any measurement source reports zero. Wiring a
live Studio is one environment variable.

**Promotion** runs from CI, not from Vercel — `.github/workflows/promote.yml`
since #49: export with a SELECT-only credential (pinned to a seq, so the two
logs describe one moment), `materialize.py`, re-emit the read model, run the
gates, open a PR. A human merges it. The PR diff — appended log lines, regenerated `proposals.ttl`,
regenerated payloads, new `corpus_version` — is the reviewable step between
"someone clicked a button" and "the specification changed".

**The hole this used to leave, now closed.** Nothing checked that
`corpus/studio/proposals.ttl` corresponded to any log — every gate ran over it as
committed, so a hand-edited one passed all of them and invariant ⑥ was a comment.
`logs/*.jsonl` is committed and `//corpus/studio:proposals_ttl_matches_the_log`
re-materializes from it, so promotion must update the log and the TTL together in
one reviewable diff. Shown to reject both ways: editing the TTL fails, and adding
a log line without promoting it fails.

The snapshot is committed rather than treated as a build artifact for a second
reason: Postgres cannot defend against its own owner, and a row can vanish from a
table without trace where a line cannot vanish from a reviewed diff.

**On stale `parent`:** `corpus_version` is one global digest across all projects,
and `proposals.ttl` is inside it, so every promotion necessarily advances it and
makes every open tab stale. `parent` is therefore provenance, not a precondition —
it stays unvalidated at the door, the console *says* when it is behind, and
promotion never rewrites it. Rewriting `parent` to the current version at
promotion time would be falsifying provenance, and it is the one edit in this
area that would be silently wrong.

## 9. What the console does not carry, and why

`portal/` had ten panes. Seven are ported: Overview, Requirements, Grounding,
Conflicts, Proposals, Document, Settings. Three are not, each for a reason:

| pane | why not |
|---|---|
| Proof | reads the Lean estate off the filesystem via `backend.rs`. There is no filesystem on Vercel and no reason to invent one — it belongs to the Bazel/plugin plane, where it already works. |
| Plan mode | was a placeholder saying it is not built. It still is not, and a nav entry that only says so is worse than its absence. |
| Liveness | same. |

Settings is not a port. The portal's was a hard-coded table naming an adapter URL
that was true on one laptop; the console's reads `/api/health`, so it cannot be
wrong about the deployment it is running in.

### 9.1 Which project a pane opens on

The corpora are loaded as separate graphs and never merged, so every pane showing
project-scoped rows must pick one. Each picked for itself: Overview and Document
spelled a preference inline, Conflicts took `projects[0]` — alphabetical, so
`ampere` — and Requirements had no notion of a project at all and listed all 133
rows of both products interleaved, offering all 27 disciplines of two businesses
that share none. `console/lib/project.ts` is now the one place that decides, and
`DEFAULT_PROJECT` is `studio`.

**The default moved; the data did not.** `ampere` stays in the payloads and stays
one click away, because dropping it would be a change to what the gates measure
wearing the clothes of a display change:

| payload | ampere | studio |
|---|---|---|
| conflicts | 12 | **0** |
| envelopes | 2 | **0** |
| witness rows | 33 | **0** |
| requirements | 64 | 69 |

`studio` is prose at R0/R2 with no typed quantities, so nothing in it can produce
an empty envelope or a modality clash. A corpus without `ampere` would run the
conflict and envelope gates over rows that cannot trip them — a gate that examines
nothing and reports success forever, which is invariant ③ inverted.

Two consequences worth stating rather than discovering:

- **Conflicts now opens empty**, on a pane whose only data is `ampere`'s. That is
  the honest reading: `studio` has no conflicts because nothing in it is typed
  enough to have one, and the empty state says so. The picker offers `ampere`.
- **A row that names no project is shown in every project, never in none.**
  `assertNS` and `bindTerm` both take `project` optionally, and the overlay
  already resolves an unscoped `bindTerm` against every corpus that uses the
  surface (`overlay.find`). Filtering with `row.project === p` instead would make
  a claim proposed without a project invisible in every pane at once, while
  sitting adopted in the log — the author submits, the list does not change, and
  nothing on screen says why. `inProject` is that rule, and it is unit-tested
  because this corpus has no such row to catch a regression.

## 10. What is not done

- ~~The export step in §8 is documented and **not automated**~~ — automated in
  #49 (`.github/workflows/promote.yml`, daily or on dispatch). ⚠ It cannot run
  until `NEON_EXPORT_URL` is set in the `corpus-production` environment, so
  `logs/*.jsonl` is still empty and every gate over it is examining nothing. The
  migrations themselves have since run against Neon, from CI under the
  `database-production` environment, and `db/verify.mjs` re-proved the refusals
  there in a rolled-back transaction.
- The npm package that carries the read model and fixtures across the repo
  boundary is not built; the console reads both by relative path, from one file
  each, so extraction is a two-line change.
- ~~**Two live write paths.** `services/spec` can still append to a file. Both are
  "the" log; neither sees the other. Retiring spec's write path is a config
  change — `SPEC_PROPOSAL_LOG` unset already answers 503 with a stated reason —
  and it must happen in the same change that points the console at Neon.~~
  **Closed in #44, and not as a config change.** Leaving it to configuration was
  the wrong instinct: an unset variable is a state an operator can restore, and
  what was needed was for the second door to stop existing. `POST /proposal` and
  `POST /proposal/op` on the plugin now answer **410 Gone** with a `use_instead`
  naming the console's routes — 410 rather than 404 because the route existed and
  works, and its removal is a decision rather than a deployment fault.

  The reason it could not wait: two doors are two implementations of the content
  address, and they had already diverged. The plugin's flat-form lift coerced
  `bound_value: "70"` to the float `70.0`; the console's leaves it a string. Same
  submission, two canonical bodies, and — once the door computed a name — two
  permanent names. `services/spec` still READS the log (the pending overlay is
  served from it); it no longer writes one. The plugin's `POST /evaluation` is a
  separate question and is still live: a measurement is not a judgement, and it
  has no address to disagree about.
- The Rust conformance tests are **written but not compiled**. The private crates
  401 in this environment and `protoc` is absent, which is the same hole CI has.
- The OAuth flow has since been run end to end against the live deployment by a
  `savvifi.com` account. What is still unverified is the **refusal**: no sign-in
  has been attempted from outside the hosted domain, so `GOOGLE_ALLOWED_DOMAIN`
  is proved to admit and not yet proved to reject.
