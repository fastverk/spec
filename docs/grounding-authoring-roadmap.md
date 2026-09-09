# Grounding authoring — issue-ready roadmap

Companion roadmap for [#54](https://github.com/fastverk/spec/issues/54). Each
section below is scoped to become one GitHub issue.

## The boundary

Two systems are deliberately separate:

- The **decomposer** reads an author's backticks and emphasis and identifies the
  terms a requirement depends on. It never decides what a term means.
- The **project Probe adapter** evaluates candidate locators inside the
  project's environment. It can return counts, fingerprints, caveats, and
  transit-only examples without giving spec access to project data.

A locator remains opaque to spec. The console must not invent a SQL-like grammar
or imply that a visually assembled expression is valid unless the project
adapter supplied and accepted its structure.

## Dependency order

1. Shared composer over known bindings
2. Project catalog search contract
3. Probe candidate comparison
4. Binding evidence in the proposal vocabulary
5. Reference adapter and conformance kit
6. Deterministic catalog matcher
7. Grounding interviewer
8. Accessibility and interaction coverage

Items 1 and 8 are console-owned. Items 2–5 define the consumer boundary. Item 6
must precede item 7 so an agent is measured against the deterministic baseline.

---

## Issue: Shared visual grounding composer

### Goal

Replace duplicated free-text locator fields with one component that supports
search, reuse, exact-entry fallback, and future adapter candidates.

### Scope

- Add a shared `GroundingComposer`.
- Autocomplete from existing bindings in the selected project.
- Display which terms already use a locator.
- Keep free text as an explicit advanced fallback.
- Accept adapter candidates through a stable display type carrying optional
  count and caveat fields.
- Use the component from requirement and term grounding flows.

### Done means

- Both grounding entry points render the same component and submit the same
  `bindTerm` op as before.
- Choosing an existing binding requires no locator retyping.
- The component never parses or executes a locator.
- Empty, loading, read-only, and submission-error states remain distinguishable.

---

## Issue: Add project-owned catalog search for schema-backed autocomplete

### Goal

Let a person search recognizable project concepts instead of guessing textual
locators.

### Scope

- Define a `Suggest` contract separate from `Probe`.
- Request fields: term surface, requirement context, user query, and result
  limit.
- Response fields: human label, opaque locator, kind, safe description, and
  optional deprecation/caveat metadata.
- Keep customer rows out of this response; it is catalog metadata only.
- Proxy through the console so adapter credentials never reach the browser.

### Done means

- Search returns deterministic, ranked catalog entries from a fixture adapter.
- The console merges catalog entries with existing bindings and clearly labels
  their source.
- An unavailable adapter produces a named unavailable state, never an empty
  result.
- A zero-result search is visibly different from adapter failure.

---

## Issue: Compare candidate readings with Probe

### Goal

Turn “what does this point at?” into a choice between measured populations.

### Scope

- Send selected candidate locators to `POST /api/ground/probe`.
- Render count, query fingerprint, caveat, and transit-only display examples.
- Compare candidates side by side.
- Refuse to present count zero as a valid binding.
- Discard examples when the view closes; do not place them in proposal state,
  logs, telemetry, or durable agent storage.

### Done means

- A person can select a positive-population candidate and see exactly what will
  be proposed.
- Zero renders as `Vacuous` and cannot be submitted as `Examined`.
- 400 (no proposed reading), 502 (unreachable), 503 (unconfigured), zero, and a
  positive result each have distinct UI states.
- Conformance fixtures prove examples never enter persisted types.

---

## Issue: Carry measured binding evidence through the proposal door

### Goal

Make an adopted binding distinguishable from an unmeasured guess.

### Scope

- Add optional `locator`, `population`, and `query_fingerprint` fields to
  `bindTerm` in TypeScript and Rust.
- Preserve the closed 17-operation vocabulary.
- Include evidence in canonical proposal bytes and promoted TTL.
- Require server-observed Probe evidence for measured bindings; the browser or
  an agent may not type population or fingerprint values.

### Done means

- TypeScript and Rust accept and address identical proposal bytes.
- Replayers and materialization retain the evidence.
- A fabricated count or fingerprint is refused.
- Existing unmeasured bindings remain readable and are explicitly labeled
  unmeasured.

---

## Issue: Ship a Probe reference adapter and conformance kit

### Goal

Give each consumer a runnable implementation boundary rather than only a proto.

### Scope

- Fixture-backed `Suggest` and `Probe` handlers.
- Audience-scoped OIDC verification.
- Timeout, redaction, and safe-example guidance.
- Consumer-side conformance tests for positive, zero, unavailable, and malformed
  responses.
- Example deployment and environment configuration.

### Done means

- A consumer can implement the contract without granting spec database access.
- The reference adapter passes the same response fixtures as the console proxy.
- Authentication failure, adapter failure, and no-match are mechanically
  distinct.
- `/api/health` reports configured only when the integration is usable.

---

## Issue: Deterministic binding catalog before agent assistance

### Goal

Dispose of exact-match permission tokens and schema identifiers without an LLM.

### Scope

- Build a catalog from project-provided permission and schema identifiers.
- Exact matching only; no fuzzy semantic claims.
- Produce a reviewable batch of `bindTerm` proposals.
- Rank unmatched terms for manual work.

### Done means

- Every generated binding names its catalog source.
- A human can review the batch before it reaches the door.
- Re-running against the same inputs is byte-identical.
- The residual queue becomes the measured baseline for any grounding agent.

---

## Issue: Grounding interviewer for residual business language

### Goal

Ask focused questions only where catalog search and deterministic matching lose.

### Scope

- Read requirement context and suggest candidate locators.
- Probe before proposing.
- Park for human approval on every write.
- Keep examples out of model and durable workflow state.
- Expose no tools for requirement authoring, evaluation, or conflict resolution.

### Done means

- A probe returning zero cannot reach `bindTerm`.
- Population and fingerprint are copied server-side from Probe state, never
  model-authored.
- Click and conversational flows produce the same proposal address.
- Evaluation shows the interviewer beating ranked autocomplete on the residual
  queue; otherwise it is not shipped.

---

## Issue: Component and accessibility coverage for grounding

### Goal

Make the shared interaction safe to evolve.

### Scope

- Add DOM tests for autocomplete keyboard navigation and free-text fallback.
- Test busy, success, failure, read-only, and adapter-unavailable transitions.
- Test requirement and term entry points against the same behavior suite.
- Verify focus restoration, labels, announcements, and narrow layouts.

### Done means

- Keyboard-only users can search, inspect, select, and submit a locator.
- Screen readers announce candidate source, population, caveat, and disabled
  reason.
- No component maintains a second copy of proposal lifecycle state.
- CI catches drift between the two grounding entry points.
