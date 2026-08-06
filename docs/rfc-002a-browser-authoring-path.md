# RFC-002a — The path to spec authoring in the browser

**Status:** Draft · **Companion to:** [RFC-002](./rfc-002-authoring-plane.md) §8
**Date:** 2026-08-06 (revised)

> *RFC-002 §8 says what the authoring surfaces should be. This says what has to
> happen, in what order, for any of it to appear in a browser — and which parts are
> unblocked today versus gated on another repo.*
>
> **Revision note.** The first draft of this document had six of seven stages gated
> on somebody else: a botnoc PR, an upstream descriptor extension, a Lean toolchain,
> and a maven pinning fix. Five of those gates turned out not to exist. What follows
> is the corrected chain, with the reasons each gate dissolved — because the reasons
> generalise better than the result.

---

## 1. Three facts that reframe the sequencing

RFC-002 §8.1 originally concluded that the authoring surfaces should ship as
meridian `adhoc` handlers, because the declarative descriptor vocabulary has no
write primitive. Three facts say otherwise, and they were all findable by reading
files in this session's own working tree.

**Fact 1 — a declarative plugin reaches the browser with no shell change at all.**
`plugin-mycelium/ui/panels.textproto` states the property in its own header:

> *DECLARATIVE table panels (like forge/depot/tbzl): the shell decodes the bundle,
> builds a nav leaf per panel, and renders each table via `renderPanelInto` —
> populating rows from `populate.service/.method`, which the shell routes through
> `/api/gw/mycelium/*` via the `web_routes` in `/describe`. **No shell-side
> (main.js) code.***

**Fact 2 — most of the authoring read model is tabular.** The conflict board, the
empty envelopes, the frontier, per-discipline coverage, the claim list, and a
conflict's witness parties are all rows and columns. The genuinely non-tabular
surfaces are fewer than §8.2 implied: the constraint-bar axis, the per-op proposal
diff, the faceted lattice with a heat overlay, and the draft bar.

**Fact 3 — the declarative vocabulary already has a write primitive.** `main.js`
dispatches `body.case === 'form'` to `renderFormPanelInto`, which is a complete
declarative write path: fields from `FormField.kind`, `pattern` validation,
`bindings` → a flat request object, and a POST through the plugin's own
`web_routes`. RFC-002 §3.3 said this did not exist; §3.3 was measuring
`meridian_schemas` **0.5.0**, spec's pin, while botnoc — the repo whose shell does
the rendering — pins **0.19.0**.

Together: **the read side of browser authoring was already unblocked, most of the
value is on it, and the write side is a version bump rather than a negotiation.**
Seeing that two instruments are jointly infeasible by 27 MW is the product; drawing
it on an axis is presentation.

## 2. The chain, and what actually gates each link

```
  [A] compute the read model             ── DONE, verified (6 queries, 128 rows)
        │
  [B] serve it from the plugin           ── DONE. 6 GET routes + 3 POST + /readmodel;
        │                                   compiled and 32 tests green
  [C] declare the panels                 ── DONE, merged into the SHIPPED bundle
        │                                   (textproto + recompiled .binpb)
  [D] read model visible in browser      ── B + C, both done. Needs a deploy, not work.
        ╎
        ╎  ── everything above landed without touching another repo ──
        ╎
  [E] rich read surfaces (the axis)      ── DONE in botnoc: web/static/assets/spec.js
        │                                   + one ADHOC_HANDLERS entry (`spec_witness`)
  [F] the write path                     ── DONE, queue-side: closed op vocabulary,
        │                                   structural check, append-only log.
        │                                   The DOOR is not here — see §6.
  [G] write affordances in the browser   ── WRITTEN, not shipped. Gated on ONE thing:
                                            meridian_schemas 0.5.0 -> a FormPanel
                                            version in spec/MODULE.bazel.
```

The structural point that mattered: **D never depended on E, F, or G.** Earlier
framing made the browser story sound like one cross-repo negotiation. It was two
projects, and the first one was small.

## 3. [A] Compute it

`tools/readmodel/emit_readmodel.py` runs six SPARQL queries over a corpus carrying
the `au:` vocabulary and emits one JSON file per route in the envelope
`services/spec/src/json.rs` already uses: `{"<rows_field>": [...],
"unreachable_repos": []}`.

Verified against `corpus/ampere` (2,080 triples), byte-identical across runs:

| route | rows_field | rows |
|---|---|---:|
| `conflicts` | `conflicts` | 12 |
| `envelopes` | `envelopes` | 2 |
| `frontier` | `stalls` | 5 |
| `disciplines` | `disciplines` | 12 |
| `claims` | `claims` | 64 |
| `witness` | `parties` | 33 |

Output lives in [`services/spec/readmodel/`](../services/spec/readmodel/) — the
directory the plugin serves, not a mocks folder, so there is one copy rather than
two that can disagree.

**The architectural decision this encodes: the build computes, the plugin serves.**
The alternative was a SPARQL engine in the Rust plugin, which means a new crate, a
second RDF implementation, and a second thing to keep in agreement with the Jena
gates. Instead the read model is generated the way the plugin already works — its
index is "a scan of the git-synced source tree at `$SPEC_SOURCE_ROOT`" — and there
stays exactly **one** SPARQL implementation of record.

The trade, stated plainly: the read model is as fresh as the last emit, not live.
For a corpus where claims change at review cadence rather than per-request that is
the right side of the trade. If it ever isn't, the fix is a rebuild trigger, not a
query engine in the BFF.

One column was added while building [E]: `quantity` on both the `conflicts` and
`witness` rows. Without it a witness row says "this claim binds at 55" with no way
to know 55 *of what*, which makes the constraint-bar axis — the screen the whole
read model exists for — impossible to draw. Row counts are unchanged (the join is
`OPTIONAL`); 21 of 33 witness rows and 7 of 12 conflicts carry one.

## 4. [B] Serve it — and how it got verified without Bazel

`services/spec/` gained:

- `src/readmodel.rs` — the payload loader, TTL-cached, with a missing or malformed
  payload degrading to zero rows plus a note in `unreachable_repos` (the plugin's
  existing partial-result channel) rather than an error;
- `src/routes.rs` — the `web_routes` contract as data, with no `axum` dependency, so
  it can be asserted against from both a startup check and a static one;
- `src/proposal.rs` — the closed op vocabulary and the append-only log (§6);
- six GET handlers, three POST handlers, and `GET /readmodel` (per-route row counts
  and availability — because "the corpus is clean" and "the payload never shipped"
  render identically in a panel);
- nine `LayoutService` nav leaves;
- three read-model MCP tools (`list_conflicts`, `list_empty_envelopes`, `frontier`),
  which are the grounding half of RFC-002 §9's chat loop: a model cannot ask "does
  this contradict anything" without them.

**§3.2 of the first draft said this was the one real blocker, because nobody could
build or test it.** That was true of Bazel and of `cargo` against this crate — the
private `fastverk-plugin-crates` git deps 401 here. It was not true of the code.
Three of the four new modules depend only on `serde_json` and `tracing`; `http.rs`
adds `axum` and `tokio`. A scratch crate that pulls those four from crates.io and
includes the real sources by `#[path]`, with 60 lines of stubs standing in for the
prost messages, the estate indexer, and `fastverk-mcp`, compiles all of it.

That found **three real defects** that review had not:

1. `routes_match_describe` compared *all* authoring routes against the six read
   routes and reported "8 declared, 6 served" on a correctly-wired plugin — it was
   counting the two POST writes. It would have logged an error at every boot.
2. `Checked` needed `Debug` for `expect_err`.
3. A doc-comment patch had silently dropped a `///`, which is a parse error that
   cascaded into two spurious "type annotations needed" errors in a different file.

The HTTP tests boot the real router on an ephemeral port and issue real HTTP/1.1
over a socket. `tower::ServiceExt::oneshot` would have been the idiomatic client,
but `tower` is not a dependency and adding one means re-pinning the crate universe;
`tokio::io::AsyncReadExt` is behind the `io-util` feature this crate does not
enable. So the client is a blocking `std::net::TcpStream` on `spawn_blocking`, which
needs nothing new and exercises the same route table.

**32 tests pass.** The write path is covered end to end: refused without a
principal, 503 with no log configured, 422 with nothing appended on a malformed op,
202 with exactly one line appended on a good one.

Writing those tests also surfaced a defect in the tests themselves worth recording:
they originally configured the server through `std::env::set_var`, and Rust runs
`#[test]`s in parallel threads of **one** process, so each test raced every other on
the same keys. Two failed nondeterministically. The fix was `ReadModel::new` and
`ProposalLog::new` — env parsing separated from construction, which is a better API
independent of the tests.

## 5. [C] and [D] — the panels, and the one thing that would have silently failed

The six panels are in `services/spec/ui/panels.textproto`, **merged into the
shipped bundle** rather than added as a second one. That is not a style choice.
`main.js`'s `fetchPluginPanels` does:

```js
loadPanelBundleFrom(`${base}/panels.binpb`)
```

— a single hard-coded path. It never reads `manifest.panels[].bundle_path`. A second
`meridian_panel_bundle`, which is what the first draft of §3.2 proposed, **would
never have been discovered**, and the failure mode is an empty nav section with no
error anywhere.

`services/spec/ui/panels.binpb` is committed *and* generated — which is a standing
staleness hazard, because the first person to edit the textproto without a working
Bazel leaves the two disagreeing and nothing says so. So the regeneration is a repo
tool: `tools/readmodel/compile_panels.py`.

Without `protoc` or the uiview schema, its field numbers were read off the committed
bundle by decoding it on the wire (`panels`=2; `panel_id`=1, `title`=2, `table`=3;
`populate`=1, `rows_field`=2, `item_noun`=3, `placeholder`=4, `columns`=5;
`header`=1, `field_path`=2, `pref_width`=**4** — the kind of thing that is obvious
from the bytes and invisible from the textproto). Hand-rolled protobuf is only
trustworthy if it is checked, so the tool checks itself on every run, before it is
allowed to write anything:

1. **Round-trip** — decode the committed bundle and re-encode it; the result must be
   byte-identical. A codec that cannot reproduce protoc's own output on real data has
   no business producing a replacement.
2. **Agreement** — compile the textproto, decode the result, and compare panel ids,
   populate pairs, `rows_field`s and column `field_path`s against what the textproto
   says. This catches a textproto the parser *misread*, which round-tripping cannot.

Without `--write` it verifies and reports staleness with a non-zero exit, so it works
as a gate as well as a generator. It refuses outright on a non-`table` panel rather
than guess a field number it has no evidence for — which is also why the `form`
panels of [G] cannot be compiled here even setting the version bump aside.

`bazel build //services/spec/ui:panels` remains the real compiler and the source of
truth. This is the thing that keeps the committed copy honest between builds.

### 5.1 The wiring check

The authoring plane is described in **seven** places — the emitter's route table,
the emitted payloads, the emitted `/describe` fragment, `readmodel.rs`'s `ROUTES`,
`routes.rs`'s declarations, `http.rs`'s axum registrations, the panel textproto, the
nav leaves, the compiled bundle, and the form descriptors. Every pair is connected
by **a string**, so nothing in the type system connects them and nothing in the
compiler catches a rename.

`tools/readmodel/check_wiring.py` catches it: **146 checks, standard library only,
no Bazel and no toolchain.** Each section has a demonstrated negative control — a
`rows_field` typo in Rust, a stale compiled bundle, a missing nav leaf, a form field
nothing binds, an op outside the closed vocabulary, a submit pointing at an
undeclared route. All six perturbations were injected, caught, and reverted.

## 6. [F] The write path — what it is, and the line it does not cross

RFC-002 puts `Door.admit` in Lean, taking `{parents, ops}` and **not** provenance.
That door is not in the plugin and was not simulated there. What the plugin does is
the queue side:

- check every op against the **closed 16-constructor vocabulary** and its *local*
  decidable preconditions;
- append the canonical bytes to an append-only log (`$SPEC_PROPOSAL_LOG`; **unset
  disables the write path entirely**, which is the right default for a BFF whose
  other three tables are a scan of someone else's source tree);
- return the per-op verdict split.

Three enforcement decisions are worth naming because each rules out a specific
silent failure:

- **An unknown field is a rejection, not a dropped key.** A typo'd `bound_vlaue`
  would otherwise become an unbounded claim that passes every gate.
- **`declQuantity` requires all six referent fields.** Dimension alone is
  insufficient — MW and MVAr share a dimension, "capacity" is five disjoint
  concepts. Over `corpus/ampere`, `metering & settlement` reads **0.0% typed**, and
  it is the discipline that fixes the referent for every energy quantity there.
- **An agent principal may only `assertNS` at R0.** RFC-002 §7.1 is honest that this
  is a code property rather than a theorem. `proposal.rs` is that code, in one
  place, which is the most the claim can currently mean.

Capability shortfall yields `QUEUED`, not `REJECTED`: §5 makes partial admission
normal, so a proposal mixing author-capability and kernel-capability ops splits
rather than failing whole. `declarePrecedence` fails **closed** — an empty
`$SPEC_KERNEL_SUBS` means nobody holds kernel capability — deliberately unlike
`pluginCallerIsAdmin`'s fail-open, because that one hides a nav item and this one
changes every discipline's lattice.

**No content address is computed.** `Proposal.id` is a hash over
`(parent, author, ops)`; this crate has no hash primitive and cannot acquire one
without re-pinning the crate universe, which needs a `cargo` that can reach the
private git deps. Rather than mint a plausible-looking identifier from
`DefaultHasher` — neither stable across releases nor collision-resistant, and its
own docs say so — the response returns the exact canonical bytes the address will be
taken over, plus `"address": null` and `"address_computed_by"`. **A fabricated
address is strictly worse than an absent one:** it would be indistinguishable from a
real one at every downstream callsite.

The canonicalizer is written out rather than delegated to `serde_json::to_string`,
whose key order depends on whether `preserve_order` is enabled somewhere in the
dependency graph — a build-configuration detail that must not be able to change a
content address.

Likewise `verdict-preview` returns its own `limits` array: structural only, does not
evaluate the coherence gates, does not verify `parent` names a real read point, no
address. A route with that name that quietly under-delivers is worse than one that
states its scope.

This is the write-side reading of the same decision the read model encodes: **the
build adjudicates, the plugin queues.** The first draft of this document said "P1
should not be written in an environment that cannot build Lean." That still holds —
and the reason the queue side *could* be written is that it makes no claim the Lean
door will make.

## 7. [G] What remains, and it is one line

`mocks/ux/panels.authoring-form.textproto` carries four declarative write
affordances — `assertNS`, `adjudicate`, `narrowGuard`, `bindTerm` — each composing
exactly one op and submitting through `SubmitOp`. They are internally checked (bound
fields match declared fields, ops are in the closed vocabulary, submits name a
declared POST route) and they are **not** in the shipped bundle.

The single prerequisite:

```
spec/MODULE.bazel:  meridian_schemas 0.5.0 -> a version carrying FormPanel
                    meridian_web     0.5.0 -> the matching bundle rule
```

`meridian_panel_bundle` compiles the textproto against
`@meridian_schemas//proto:uiview_proto` **at spec's pin**. A `form { }` block under
0.5.0 is a textproto parse failure, which fails the panel-bundle target, which fails
the plugin build for everyone. Shipping it unbuilt is exactly the §12.1 hazard, so
it waits for somebody with a working Bazel — one bump, one build.

The routes those forms submit to are already live and already tested, including the
property that matters: **a form's string values and an API client's real JSON types
produce identical canonical bytes**, so click- and API-authored changes are the same
change. That is §9.1's equal-citizen guarantee on the write side, tested rather than
hoped for.

## 8. [E] The axis — the one surface a table cannot carry

`botnoc/web/static/assets/spec.js` + one `ADHOC_HANDLERS` entry (`spec_witness`).
It draws several disciplines' bounds on one axis with the empty intersection
shaded:

```
≥ 82  market microstructure     capacity commitment          defeasible
≤ 78  electrochemistry          OEM derate at 45 °C          NON-defeasible
≤ 70  fire & life safety        SOC window ÷ 4h              NON-defeasible
≤ 55  insurance & warranty      throughput budget spent      defeasible   ← binds
──────────────────────────────────────────────────────────────────────────
      intersection [82, 55] = ∅         deficit 27 MW, 5 disciplines
```

Every failure degrades to a pointer at the `Envelopes` table, because the **finding**
lives there and is complete without this panel: a fetch that fails, a payload with
no rows, a conflict whose parties carry no numeric bound. And an *unstated*
defeasibility renders as "unstated" rather than as either value — the corpus not
saying is not the same as the corpus saying no.

**Sequencing:** botnoc must ship the handler *before* spec declares an adhoc panel
naming it, or the panel renders "No adhoc handler for spec_witness". So the botnoc
change lands first and is inert until spec's bundle references it.

## 9. The critical path, in one list

1. **Fix issue #19** — pin `maven_install.json` so `//java/...` fetches without an
   ambient JDK, and `fastverk/build` becomes a signal again. Everything below is
   ordinary once it is; nothing below is validated while it isn't.
2. **Exercise the P0 wiring** — `bazel test //rdf/lint/authoring/... //corpus/ampere/...`.
   Four constructs remain unvalidated (RFC-002 §12.1).
3. **Build `services/spec`** — the code compiles and its tests pass under a scratch
   crate, but not against the real crate universe, and `panels.textproto` has not
   been through `meridian_panel_bundle` (the committed `.binpb` was produced by a
   round-trip-validated encoder, which is evidence, not a build).
4. **Wire `emit_readmodel.py` and `compile_panels.py` into the build** so the read model refreshes with the
   corpus instead of being refreshed by hand. This needs `rules_python`, which is not
   currently a `bazel_dep` — the honest reason it is step 4 and not step 1.
   `check_wiring.py` is the interim guard and needs no toolchain.
5. **Bump `meridian_schemas`** past `FormPanel` and move
   `panels.authoring-form.textproto` into the shipped bundle. This is [G].
6. **Ask upstream** for the three small things (§3.3): a `context` binding source,
   a `decimal` field kind, a parameterised `populate`.

Steps 1–3 are not spec-authoring work. They are the difference between building on
evidence and building blind.

## 10. What is verified, and what merely exists

| | evidence |
|---|---|
| The six SPARQL queries and their 128 rows | executed under rdflib 7.6; byte-identical across runs |
| `readmodel.rs` / `routes.rs` / `proposal.rs` / `http.rs` | **compiled by rustc 1.94.1; 32 tests pass**, including the router over real HTTP |
| The seven descriptions agreeing | **146 checks**, six negative controls injected and caught |
| `panels.binpb` | `compile_panels.py`: codec round-trips protoc's own output byte-for-byte, then the compiled bytes are checked structurally against the textproto. Staleness detection has a negative control |
| `panels.textproto` (9 panels) | parses; every populate pair and rows_field cross-checked |
| `botnoc/.../spec.js` | parses as an ES module; exports resolve. **Not rendered in a browser.** |
| `mocks/ux/panels.authoring-form.textproto` | internally consistent. **Never compiled** — needs the version bump |
| The Bazel wiring from RFC-002 P0 | **still never exercised.** Issue #19 |
| `Door.admit`, the content address, the gate verdict | **do not exist.** RFC-002 P1, and correctly not attempted here |

The distinction that line-by-line table exists to preserve: "the compiler accepted
it and the tests pass" and "it ran in production" are different claims, and in a
repo whose CI has been a constant red, conflating them is how §12.1 happened.
