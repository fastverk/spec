# Revision-bound evidence for consumer specifications

Status: implementation proposal, November 23, 2026. No release or deployment.

Scope owns authoring and navigation. Spec owns reusable check execution and
assessment. Consumer repositories own normative requirements, formal models,
implementation, tests, and their corpus. Spec receives locators, revisions,
counts, and hashes; customer rows remain in the consumer environment.

A durable requirement ID is not its current text or file hash. Preserve existing
RFC IDs and IRIs, retire rather than reuse IDs, and record aliases explicitly.
Each obligation binds its source bytes. Existing `spec.v1.Invariant`, `Check`,
`Outcome`, and `Population` retain their meanings. Evidence is an additive
protobuf contract, not a replacement for grounding or the authoring ladder.

An assessment has six independent dimensions: approval, grounding,
implementation, test, proof, and production acceptance. A test cannot establish
approval or proof. A typechecked model cannot establish implementation
conformance. Every unspecified dimension remains missing. A CLI may gate a
specified subset, but must still report the complete readiness state.

Each executable check has one owner, command argument vector, working repository,
input set, and toolchain fingerprint. Scope delegates to a clean, pinned Spec
checkout; it does not interpret SPARQL, Lean, or test assertions. SPARQL checks
continue to use Bazel's Jena ARQ path. Producer checks return a typed observation
with an explicit outcome and examined population. Zero population, unresolved
terms, skipped execution, malformed output, and missing input are never passes.
The executor captures receipts; it does not synthesize a verdict from prose or
LLM output. Review dimensions cannot be executed as tests.

Receipts bind the requirement, check definition, command, evaluator, source,
implementation, toolchain, and observation artifact. Exact revision bindings
become stale on a changed commit. Content bindings are explicit and allow an
unchanged model's evidence to survive unrelated implementation changes. Both
policies detect dirty file edits. Locators must resolve within named checkouts.
This is integrity and reproducibility, not a signature or a claim of independent
review. Evidence from an untrusted producer is not made trustworthy by hashing.

The first consumer pilot is installer audit journal preservation: live-to-archive
cleanup preserves stable event identity and the complete Resource envelope.
It connects RFC-0041 to Graph and Gnomon checks and authenticated Note acceptance.
A planted envelope mutation must fail, source drift must stale the receipt, and
an ungrounded obligation must remain unresolved. Existing implementation evidence
may be cited as historical evidence; only a new evaluator-recorded execution or explicit human review creates a new
receipt. The pilot does not establish full RFC-0041 or issue #14 conformance.

The consumer then inventories all RFCs and product surfaces, preserving missing
models and unresolved readiness dimensions. Generated views are derivatives;
producer protobufs, authored RFCs, and formal models retain their authority.
Repositories remain independently versioned. Consumers record exact accepted
revision tuples; this work does not upgrade published Spec pins or publish a
new module version.

## Invocation

The additive contract is `proto/spec/v1/evidence.proto`; existing Invariant and
Outcome fields remain wire compatible. Use protobuf JSON for manifests, producer
observations, append-only ledgers, and reports. Unknown JSON fields are refused.
A receipt's observation hash covers canonical protobuf bytes; the separate raw
stdout hash identifies the original observation artifact.

```sh
bazel --nohome_rc run //tools/evidence:evaluate -- run \
  --manifest /consumer/spec/evidence/manifest.json \
  --receipts /consumer/artifacts/evidence-ledger.json \
  --checkout consumer=/consumer/runtime --check installer-audit
```

Use `assess` to re-evaluate existing receipts without running producer commands.
All named inputs must resolve within their checkout. Exact revision inputs also
require a clean checkout; content inputs deliberately bind only the listed
files. Input completeness is a reviewed consumer responsibility. Toolchain files
must be included in those inputs as well as named by `toolchain_id`.

Exit zero means the explicit selected check set passed. `ready` still reports
all six dimensions across the entire inventory. Empty selections, unknown
checks, empty inventories, malformed schemas, and unresolved input locators are
errors. Review dimensions have no executable promotion path; approval,
confirmed grounding, and production acceptance require the explicit human
review entry below. That entry is attributed provenance with integrity checks,
not identity authentication or a cryptographic attestation. A producer's positive
observation is trusted as that producer's verdict, not independently proved by
this tool.

## Validation without publication

Use `[no-deploy]` in the pushed commit and merge commit message for a
validation-only integration. The console's Ignored Build Step returns success
for that marker, so Vercel skips its build. The image job honors the same marker.
Manual `ci.yml` dispatches leave `publish_image` false by default. Other future
pushes retain automatic deployment/publication behavior. No database migration
paths are touched by this integration. Verify skipped jobs and deployment records
explicitly; a green source gate is not production acceptance.

## Explicit review entries

The actual consumer replay caught a grounding check incorrectly declared as a
runnable test. `run` continues to refuse approval, grounding and production
acceptance dimensions. A test cannot supply a human decision.

Use `review-plan --check ID` to propose one typed `EvidenceReviewDecision` with
the complete definition and source bindings. It leaves the human origin,
verdict, reviewer, actual review time, source, statement and reviewed population
unset. It runs no predicate and appends no receipt. Supply those fields from an
actual explicit human decision, then use `review --check ID --decision FILE`.
The decision and ledger use the existing protobuf JSON convention. The receipt
is issued by the same evaluator; consumers must not construct it themselves.

Review is separate from executing implementation, tests or proofs and never
runs the check's command. A missing/unspecified decision, empty reviewed scope,
missing person/source/words, unzoned/future time, changed definition or source,
or substituted dimension is refused before append. All prior receipt bytes are
retained. An identical decision ID is idempotent; conflicting reuse is refused.
Rejection is a nonpassing review outcome. Assessment independently checks the
structured review and its exact observation/source correspondence, so a flat
CURRENT receipt cannot manufacture a review or replace a proof.

Review provenance is an attributed declaration with integrity checks, not
cryptographic authentication of the person's identity. The reviewed population
is the scope the person actually reviewed, not an executed measurement or
customer rows. This facility does not infer approval from a source flag, a
passing test, or a plan, and does not establish full specification readiness.
