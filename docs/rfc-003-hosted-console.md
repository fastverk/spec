# RFC-003 — the hosted console: Vercel, Neon, and one set of safety cases

Status: **in progress**. The spec-side enablers and the ported safety rules have
landed; the console's routes and panes have not. §9 says exactly which.

Companion to RFC-002 (the authoring plane) and RFC-002a (the browser authoring
path). Those two describe a write path that works on one laptop. This one is
about the fact that it works *only* on one laptop.

---

## 1. Why

Everything below the browser already exists and is gated: a generated TTL corpus
with SPARQL/SHACL gates run by Bazel in CI, a read model projected to committed
JSON, a Rust service serving it, and a Vite SPA with the full write path. None of
it is reachable by a product owner. `portal/` has no image, no chart, no CI
publish and no deployment story of any kind — it runs as `vite dev` on
`127.0.0.1:5174`, and its identity comes from a dev proxy that injects headers
from an environment variable.

The measurement that makes this urgent: **AUTH-24** — *"sponsor:edit never
implies deploy"* — grounded on the deployer role, examines **0 records** in
Studio. A check there would report success forever, having examined nothing. The
machinery to refuse that exists and nobody outside the repo can see it work.

## 2. The obstacles, and what each forces

| obstacle | consequence |
|---|---|
| the Rust service has no natural Vercel runtime | the reads and writes are ported to Route Handlers |
| the JSONL logs need a filesystem serverless does not have | genuine runtime state moves to Neon; nothing else does |
| identity comes from a Vite dev proxy | WorkOS AuthKit, read server-side, never from a body or a client-settable header |
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
  lib/evaluation.ts     the vacuous refusal          <- conformance/evaluation_cases.json
  lib/overlay.ts        pending + adoption           <- conformance/overlay_cases.json
  db/migrations/        the two append-only tables
  test/conformance.test.ts
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

**Promotion** runs from CI, not from Vercel: export with a SELECT-only
credential, `materialize.py`, re-emit the read model, run the gates, open a PR. A
human merges it. The PR diff — appended log lines, regenerated `proposals.ttl`,
regenerated payloads, new `corpus_version` — is the reviewable step between
"someone clicked a button" and "the specification changed".

⚠ **A hole this exposes.** Nothing today checks that `corpus/studio/proposals.ttl`
corresponds to any log; a hand-edited one passes every gate in the repo. That is
invariant ⑥ being false in practice. Committing the exported JSONL makes
"re-materializing produces no diff" a deterministic test, which is why the
snapshot is committed rather than treated as a build artifact.

**On stale `parent`:** `corpus_version` is one global digest across all projects,
and `proposals.ttl` is inside it, so every promotion necessarily advances it and
makes every open tab stale. `parent` is therefore provenance, not a precondition —
it stays unvalidated at the door, the console *says* when it is behind, and
promotion never rewrites it. Rewriting `parent` to the current version at
promotion time would be falsifying provenance, and it is the one edit in this
area that would be silently wrong.

## 9. What is not done

- The 10 panes are not ported. Only `lib/` and its tests exist.
- The Route Handlers are not written.
- `db/migrate.mjs`, the export workflow, and the committed `logs/*.jsonl`
  snapshot do not exist yet, so the §8 gate is described and not built.
- The npm package that carries the read model and fixtures across the repo
  boundary is not built; the console reads both by relative path, from one file
  each, so extraction is a two-line change.
- **Two live write paths.** Once the console writes to Neon, `services/spec` can
  still append to a file. Both are "the" log; neither sees the other. Retiring
  spec's write path is a config change — `SPEC_PROPOSAL_LOG` unset already
  answers 503 with a stated reason — and it must happen in the same change that
  turns the console's on.
- The Rust conformance tests are **written but not compiled**. The private crates
  401 in this environment and `protoc` is absent, which is the same hole CI has.
