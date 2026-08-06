# RFC-002a — The path to spec authoring in the browser

**Status:** Draft · **Companion to:** [RFC-002](./rfc-002-authoring-plane.md) §8
**Date:** 2026-08-05

> *RFC-002 §8 says what the authoring surfaces should be. This says what has to
> happen, in what order, for any of it to appear in a browser — and which parts are
> unblocked today versus gated on another repo.*

---

## 1. Two facts that reframe the sequencing

RFC-002 §8.1 concluded that the authoring surfaces should ship as meridian `adhoc`
handlers, because the declarative descriptor vocabulary has no write primitive.
That is still true for **writing**. But it made the whole plane sound uniformly
blocked on a botnoc change, and two facts say otherwise.

**Fact 1 — a declarative plugin reaches the browser with no shell change at all.**
`plugin-mycelium/ui/panels.textproto` states the property in its own header:

> *DECLARATIVE table panels (like forge/depot/tbzl): the shell decodes the bundle,
> builds a nav leaf per panel, and renders each table via `renderPanelInto` —
> populating rows from `populate.service/.method`, which the shell routes through
> `/api/gw/mycelium/*` via the `web_routes` in `/describe`. **No shell-side
> (main.js) code.***

So any panel expressible as a `table` needs: a bundle entry, a `web_routes` entry
in `/describe`, and a route returning `{"<rows_field>": [...]}`. Nothing else. No
`ADHOC_HANDLERS` registration, no `meridian_schemas` change, no botnoc PR.

**Fact 2 — most of the authoring read model is tabular.** The conflict board, the
empty envelopes, the frontier, per-discipline coverage, the claim list, and a
conflict's witness parties are all rows and columns. The genuinely non-tabular
surfaces are fewer than §8.2 implies: the constraint-bar axis drawing, the
per-op proposal diff, the faceted lattice with a heat overlay, and the draft bar.

Together: **the read side of browser authoring is unblocked today, and it is most
of the value.** Seeing that two instruments are jointly infeasible by 27 MW is the
product; drawing it on an axis is presentation.

## 2. The blocking chain, and what actually gates each link

```
  [A] compute the read model            ── DONE, verified
        │
  [B] serve it from the plugin          ── needs: bazel build of services/spec
        │                                  gated on: issue #19 (CI is red on main)
  [C] declare the panels                ── DONE, verified (declarative, no shell change)
        │
  [D] read model visible in browser     ── needs only B + C
        ╎
        ╎  ── the line above is shippable without touching another repo ──
        ╎
  [E] rich read surfaces (axis, lattice) ── needs: ADHOC_HANDLERS entry in botnoc-web
        │                                  gated on: a botnoc PR
  [F] the write path (Proposal + Door)   ── needs: RFC-002 P1, Lean + a write route
        │
  [G] write affordances in the browser   ── needs: E + F, and either an adhoc form
                                             handler or the meridian descriptor
                                             extension (upstream, RFC-002 §8.3)
```

The important structural point: **D does not depend on E, F, or G.** Earlier framing
made the browser story sound like one big cross-repo negotiation. It is two
projects, and the first one is small.

## 3. Stage 1 — the read model in the browser

### 3.1 [A] Compute it — done

`tools/readmodel/emit_readmodel.py` runs six SPARQL queries over a corpus carrying
the `au:` vocabulary and emits one JSON file per route in the envelope
`services/spec/src/json.rs` already uses: `{"<rows_field>": [...],
"unreachable_repos": []}`.

Verified against `corpus/ampere` (2,080 triples):

| route | rows_field | rows |
|---|---|---:|
| `conflicts` | `conflicts` | 12 |
| `envelopes` | `envelopes` | 2 |
| `frontier` | `stalls` | 5 |
| `disciplines` | `disciplines` | 12 |
| `claims` | `claims` | 64 |
| `witness` | `parties` | 33 |

Committed output in [`mocks/ux/wire/`](../mocks/ux/wire/), including
`describe.web_routes.json` — the `/describe` fragment, emitted rather than
hand-maintained so the panel `populate` pairs and the routes cannot drift.

**The architectural decision this encodes: the build computes, the plugin serves.**
The alternative was a SPARQL engine in the Rust plugin, which means a new crate, a
second RDF implementation, and a second thing to keep in agreement with the Jena
gates. Instead the read model is generated the way the plugin already works — its
index is "a scan of the git-synced source tree at `$SPEC_SOURCE_ROOT`" — and there
stays exactly **one** SPARQL implementation of record.

The trade, stated plainly: the read model is as fresh as the last build, not live.
For a corpus where claims change at review cadence rather than per-request, that is
the right side of the trade. If it ever isn't, the fix is a rebuild trigger, not a
query engine in the BFF.

### 3.2 [B] Serve it — the one real blocker

`services/spec/` gains:

- six `GET` handlers returning the emitted JSON, alongside the existing
  `/specs`, `/contracts`, `/status`;
- six `web_routes` entries in `describe_json()`, copied from
  `describe.web_routes.json`;
- a second `meridian_panel_bundle` for the read-model panels, or the panels merged
  into the existing bundle;
- three `LayoutService` nav leaves (`fastverk_layout::leaf`) so they get a nav
  section rather than the flat-leaf fallback.

Every one of those is a small, mechanical edit against patterns already in the
file. **The blocker is not difficulty — it is that nobody can currently build or
test it.** `services/spec` needs `fastverk-plugin-crates` (private git deps,
`CARGO_NET_GIT_FETCH_WITH_CLI=true` + auth), and `fastverk/build` is red on `main`
for the reasons in **issue #19**. Writing these handlers blind is how RFC-002 §12.1
happened.

**So issue #19 is the critical path to browser authoring.** Not the descriptor
vocabulary, not the write path — the maven pinning.

### 3.3 [C] Declare the panels — done

[`mocks/ux/panels.readmodel.textproto`](../mocks/ux/panels.readmodel.textproto) —
six `table` panels, in the exact style of the shipped
`services/spec/ui/panels.textproto`, with each `populate` pair matching an emitted
route. Ready to move to `services/spec/ui/` once B is buildable.

One honest limitation found while writing it: **the declarative `populate` block
carries no argument.** So the witness panel cannot be "the parties of *this*
conflict" — stage 1 serves all parties of all conflicts with a `conflict_id`
column. Whether meridian's `populate` can take a selection argument is the first
question to ask upstream, because it is the difference between a browsable read
model and a drillable one, and it is much cheaper than a write descriptor.

## 4. Stage 2 — drill-down

Two ways, and the choice is worth making deliberately:

1. **Ask upstream for a parameterised `populate`.** Small, generic, benefits every
   plugin in the estate. If `meridian_schemas` can express "populate this table
   from the selected row of that one," the whole read model becomes drillable with
   no per-plugin code.
2. **Serve pre-sliced routes.** `/witness?conflict=INV-01` works today if the shell
   passes query params through — but nothing in a declarative descriptor selects
   the value, so it needs a nav leaf per conflict, which does not scale.

Option 1 is the right ask. Option 2 is the fallback that proves the routes work
before asking.

## 5. Stage 3 — the rich surfaces

Only now does the `ADHOC_HANDLERS` route become necessary, and only for four
surfaces: the envelope axis, the faceted lattice with conflict heat, the per-op
proposal diff, and the persistent draft bar.

The mechanism is established, not novel — botnoc-web ships nine adhoc handlers
(`chat`, `fleet`, `agents_launch`, `agents_graph`, `configs_manager`,
`tools_gallery`, `image_explorer`, `workspaces_cards`, `access_keys`), and
`access_keys` **mutates**, minting a scoped token via POST. So adhoc panels can
write. It is a botnoc PR, not an architecture problem.

Sequencing note: do stage 3 **after** stage 1 has been used. The point of shipping
tables first is to learn which surfaces people actually reach for, so the adhoc
handlers are written from evidence rather than from RFC-002 §8.2's guesses. That is
also the argument for deferring the upstream descriptor promotion (§8.3): promote
what proved stable, once.

## 6. Stage 4 — writing

Gated on RFC-002 P1 (`Spec.Authoring.{Proposal,Op,Door}`), which is a separate
piece of work with its own verification story and no browser dependency. When it
exists, the browser side is: `POST /proposal`, `POST /proposal/{pid}/verdict-preview`,
and either an adhoc form handler or the upstream `Action.emits_proposal_op`
extension.

Worth stating: **P1 should not be written in an environment that cannot build
Lean.** There is no Lean toolchain here, and the lesson of §12.1 is that unexercised
code in this repo is indistinguishable from working code for as long as CI is a
constant.

## 7. The critical path, in one list

1. **Fix issue #19** — pin `maven_install.json` so `//java/...` fetches without an
   ambient JDK, and `fastverk/build` becomes a signal again.
2. **Exercise the RFC-002 P0 wiring** — `bazel test //rdf/lint/authoring/...
   //corpus/ampere/...`. Four constructs are unvalidated (§12.1); this is where they
   get settled.
3. **Wire `emit_readmodel.py` into the build** — a `genrule` or `py_binary` emitting
   the JSON as a build artifact the plugin reads, so the read model refreshes with
   the corpus.
4. **Add the six handlers + `web_routes` + the panel bundle to `services/spec`**,
   built and run against `corpus/ampere`.
5. **Ask upstream about a parameterised `populate`** — the cheapest unlock for
   drill-down.
6. Then stage 3, then stage 4.

Steps 1 and 2 are not spec-authoring work at all. They are the difference between
building on evidence and building blind, and everything after them is ordinary.

## 8. What is done, and what it cost to know

**Done and verified in this change:** [A] the read model computation, [C] the
declarative panel bundle, and the finding that they need no shell change.

**Not done:** everything requiring a build. That is deliberate — see §12.1 for what
happened the last time this repo's constant-red CI was mistaken for a signal.
