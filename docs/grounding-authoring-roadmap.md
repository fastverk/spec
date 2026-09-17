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
2. Installable project connector bootstrap
3. Declarative adapter model
4. Visual adapter authoring studio
5. Project catalog search contract
6. Probe candidate comparison
7. Binding evidence in the proposal vocabulary
8. Reference adapter and conformance kit
9. Deterministic catalog matcher
10. Grounding interviewer
11. Accessibility and interaction coverage

Items 1, 4, and 11 are console-owned. Items 2–3 and 5–8 define the consumer
boundary. Item 9 must precede item 10 so an agent is measured against the
deterministic baseline.

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

## Issue: Ship an installable project connector bootstrap

### Goal

Replace “build and host a grounding adapter” with a standard runtime a project
can install in its own trust boundary. The bootstrap provides connectivity and
catalog introspection; the project still authors what the adapter means in the
visual studio below.

### Scope

- Publish a small connector runtime for a serverless function or container.
- Read a versioned `.spec/grounding.yaml` adapter model from the project
  repository.
- Keep database credentials and query execution entirely inside the project.
- Expose health, catalog suggestion, and Probe routes.
- Authenticate console calls with audience-scoped OIDC rather than a copied
  long-lived token.
- Provide framework presets for Next.js, Node, and a standalone container.

### Done means

- A sample project can install the connector without importing spec's ontology
  or protobuf model.
- The connector starts from one manifest and project-owned environment
  credentials.
- No customer row, SQL statement, or database credential is stored by spec.
- The same conformance suite runs against every preset.

---

## Issue: Define the declarative grounding adapter model

### Goal

Make the adapter a reviewable project artifact rather than custom endpoint code.
The model says what project concepts exist and how to measure them; a standard
runtime supplies the HTTP behavior.

### Model

- **Data source references:** names and driver kinds only. Credentials stay in
  project environment variables and never enter the model.
- **Resources:** project-recognizable entities backed by allowlisted tables,
  views, API collections, or permission catalogs.
- **Fields:** label, type, sensitivity, searchability, and whether a field may
  appear in transit-only examples.
- **Relationships:** allowlisted joins between resources, with cardinality made
  explicit.
- **Referents:** stable IDs with human labels and a typed expression tree over
  resources, fields, relationships, operators, and parameters.
- **Suggestion metadata:** aliases, descriptions, owner, deprecation state, and
  business vocabulary used by catalog search.
- **Probe policy:** count ceiling, timeout, example limit, and redaction rules.

### Expression constraints

- Store a typed AST, never free-form SQL.
- Permit only driver-supported operators.
- Parameterize every value.
- Require explicit joins from the relationship allowlist.
- Compile and execute only inside the project connector.
- Give every compiled query a reproducible fingerprint.

### Done means

- JSON Schema validates the complete adapter model.
- Invalid fields, joins, operators, and secret literals are refused before
  deployment.
- Postgres and static-catalog fixtures compile the same referent AST
  deterministically.
- The model contains no credential, customer row, or executable free-form query.
- Model diffs are understandable in an ordinary project pull request.

---

## Issue: Visual grounding adapter authoring studio

### Goal

Let a project owner define what the adapter is and does without writing code,
SQL, protobuf, or environment-variable plumbing.

### User flow

1. Choose a connected project data source.
2. Import its schema metadata and select the resources the adapter may see.
3. Rename technical resources and fields into recognizable project language.
4. Mark sensitive fields and choose the small subset safe for transient
   examples.
5. Define relationships by selecting source field, target resource, and target
   field.
6. Create a named referent with a visual condition builder:
   **Resource → relationship → field → operator → parameter/value**.
7. Preview the generated human-readable meaning, candidate count, fingerprint,
   and redacted examples.
8. Save a draft, test every referent, then create a project-side manifest PR.

### Component model

- `DataSourcePicker`
- `ResourceCatalog`
- `FieldPolicyEditor`
- `RelationshipBuilder`
- `ReferentBuilder`
- `ConditionGroup` with nested AND/OR groups
- `ProbePreview`
- `AdapterReadinessChecklist`

The same typed expression editor should be used when a grounding author creates
an ad hoc candidate. The adapter studio saves reusable named referents; the
grounding composer selects or specializes them.

### Done means

- A user can author a multi-condition referent with one allowlisted relationship
  using only pointer or keyboard controls.
- Field and operator choices are type-aware and autocomplete from imported
  catalog metadata.
- Every edit can be previewed without persisting customer rows.
- Saving creates a deterministic `.spec/grounding.yaml` change in the project
  repository.
- Reopening the model reconstructs the visual form byte-for-byte.
- Advanced users may inspect the manifest but never need to edit it manually.

---

## Issue: Point-and-click project data connection and authoring wizard

### Goal

Let a project owner install the runtime and open the adapter authoring studio
using recognizable product language rather than an environment variable named
`GROUNDING_ADAPTER_URL`.

### User flow

1. Open **Settings → Connect project data**.
2. Choose the project repository and connector preset.
3. Choose a project-owned data source.
4. Open the adapter studio to select resources, describe relationships, and
   author named referents.
5. Review the privacy boundary: metadata, counts, fingerprints, and optional
   transit-only examples.
6. Click **Create connector PR**.
7. After that PR deploys, click **Test connection** and see each capability
   verified separately.

### Scope

- Add connection states: not connected, installing, deployed, authenticated,
  catalog ready, Probe ready, and degraded.
- Generate the connector bootstrap and empty adapter model from wizard choices.
- Launch the visual authoring studio against catalog metadata returned by the
  project-side connector.
- Use a GitHub App to open the project-side PR; the console never writes project
  code directly.
- Verify health, OIDC audience, Suggest, positive Probe, zero handling, and
  example redaction.
- Store non-secret connection metadata per console deployment; keep project
  credentials project-side.
- Retain an advanced “connect an existing endpoint” path for teams that already
  run an adapter.

### Done means

- A project owner completes setup without writing an adapter or manually copying
  a secret.
- Every wizard step is resumable and names the next blocked action.
- “Connected” means the signed Probe handshake succeeded, not merely that a URL
  exists.
- Removing the generated project manifest disables the connector without
  leaving a credential behind in spec.

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
