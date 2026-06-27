# RFC-002 — the crank, lifted: one contract across agora, spec, ratio

**Status:** Accepted (implemented) · **Companions:** [RFC-001](./rfc-001-unified-spec-graph.md)
(the spine), [RFC-001b](./rfc-001b-crystallization-math.md) (the math),
[compaction](./compaction.md), [phase-0](./phase-0-materialization.md)

## The question

A crank is `predict → project → gate → measure`. The **predict** step is an agent
fleet (agora); **project/gate/measure** is deterministic (spec). Three repos touch
it — agora (the fleet), spec (the substrate), ratio (a product corpus). Do we
copy the crank into each, or lift it?

## The answer: lift, don't copy

The crank decomposes into a **generic engine** plus three thin specializations.
The engine lives in `spec` — the spine everything already depends on — so the
fleet and any corpus bind to **one contract**, not three.

| Layer | Home | Artifact |
|---|---|---|
| **Contract** (predict ⇄ project) | **spec** | `//crank/proto:crank_proto` — `CrankPredictor` gRPC service + `PredictRequest/Response`, `GraphDelta`, `Term/Triple`, `EnergySnapshot`, `Provenance`. Package `fastverk.crank.v1` — domain-neutral. |
| **Corrector** (project) | **spec** | `Spec.Compaction` (Lean-proven: `E(P G) ≤ E(G)`, idempotent) + the SPARQL passes in `//corpus` (transitive reduction, symmetry). |
| **Gate** | **spec** | `spec_corpus_gates` (SHACL + 4 consistency invariants) + the semantic lints. |
| **Measure** | **spec** | the energy SPARQL (`//corpus:eg_measure`, `:compaction_measure`) + `//crank:record_eg` (the E(G) series). |
| **Predict** (the fleet) | **agora** | implements `CrankPredictor` via its `Bidder` endpoints — in-process or RunPod serverless. The crank contract mirrors `agora.v1` (`Term/Triple/Provenance`), so a bidder adapts with a thin shim. |
| **Corpus** (an input) | **ratio** (and others) | its spec graph is *one* thing the engine cranks. Not special. |

Why the contract lives in **spec**, not agora: the dependency DAG is
`agora → spec ← ratio` (RFC-001). agora depends on spec, so a contract spec can
import sits in spec (or below); putting it in agora would invert the DAG.

## The loop, contract-bound

```
            ┌── predict ──────────────┐      ┌── project ──┐ ┌─ gate ─┐ ┌ measure ┐
 frontier → │ agora fleet (Bidder/    │ Pre- │ Spec.Comp-  │ │ spec_  │ │ eg_     │ → E(G) series
   + τ      │ RunPod) implements      │ dict │ action +    │ │ corpus │ │ measure │   (//crank:
            │ CrankPredictor.Predict  │ Resp │ SPARQL      │ │ _gates │ │         │    record_eg)
            └── returns GraphDelta ───┘ →    └─ never ↑E ──┘ └ reject └─────────┘
```

The corrector can only lower `E(G)` (proven), so an over-eager predictor cannot
corrupt the graph — the worst case is a rejected delta.

## Proof it is bound, not narrated

A worked crank with a **mock fleet worker** (`//crank`):
- `deltas/crank-003.delta.textproto` — a real `fastverk.crank.v1.PredictResponse`
  (validated with `protoc --encode`), attacking the under-specified ai-insights
  leaf (RFC-0914, U).
- **project/gate**: `//crank:crank_003_gates_*` pass — the predicted delta is
  admitted (SHACL + consistency green).
- **measure**: `//crank:crank_003_measure` — claims 19 → 21, RFC-0914 densified
  1 → 3. The frontier shrank without breaking the graph.

Swapping the mock for the real fleet is a transport change only — and that
transport is now wired (gRPC, both ends; see below).

## The transport is wired (gRPC, both ends)

- **bindings** — `//crank/proto:crank_java_proto` (messages) +
  `//crank/proto:crank_java_grpc` (`java_grpc_library` → `CrankPredictorGrpc`,
  via grpc-java 1.82.0 on the same protobuf 33.4 pin, so it is wire-compatible).
- **orchestrator** — `//crank/orchestrator` runs `predict → project → gate →
  measure`, τ↓, dialing only the `CrankPredictor` interface. The gRPC layer
  (`//crank/orchestrator:grpc_transport`) adds `GrpcPredictor` (the blocking
  stub as that interface) + `CrankPredictorService` (the server base over any
  `CrankPredictor`); the loop library itself has **zero** transport deps.
- **proof (hermetic)** — `//crank/orchestrator:grpc_round_trip` runs the whole
  loop over an in-process gRPC channel (real `PredictRequest`/`PredictResponse`
  marshalling each crank); E(G) descends −4 → −8 → −12.
- **fleet** — `agora` `crates/agora_crank` is the `CrankPredictor` *server*: a
  tonic service whose predict step is `agora_core::vickrey` over a worker fleet,
  mapping the winning tool's `agora.v1.Graph` → `crank.v1.GraphDelta`. It is
  runnable (`cargo run -p agora_crank --bin crank-server`) and proven over real
  TCP (`tests/wire.rs`). See agora `docs/crank-bidder-shim.md`.
- **proof (cross-language, live)** — `//crank/orchestrator:grpc_dial` (a netty
  client) dialing a running `crank-server` cranks **Java ⇄ Rust over real TCP**;
  the frontier converges and E(G) descends −5 → −9 → −13. This is the whole
  contract end to end: a JVM orchestrator predicting via a Rust fleet server.

## What each repo owns

- **spec**: the engine + contract + orchestrator + gRPC transport (above).
- **agora**: `agora_crank` — the `CrankPredictor` adapter over its `Bidder`
  fleet (`agora.v1.Graph`/`Provenance`; propose→Jena-validate→repair).
- **ratio**: keep its corpus current; it is a consumer, nothing more.

## Next (to a live fleet)

1. ~~Point the orchestrator's channel at an `agora_crank` endpoint.~~ **Done** —
   `grpc_dial` dials a live `crank-server` over netty; cranks Java ⇄ Rust. The
   only swap left is the address (loopback → RunPod), no code change.
2. ~~Bind `CrankWorker::execute` to a real propose→validate→repair.~~ **Done** —
   agora `RepairingWorker` validates each proposal with agora's own
   `agora_bgp::well_formed` and repairs until it passes (`repair_iters` is the
   real round count). The only swap left is the *proposer* (deterministic →
   Claude/RunPod LLM bidder); the validate→repair scaffold is real.
3. ~~Replace the loop's toy energy/gate with the Jena SPARQL `//corpus`
   targets.~~ **Done** — `JenaEnergy` measures E(G) with ARQ SPARQL over a Jena
   model of the crank graph (the eg-measure / compaction-measure patterns), and
   `JenaGate` rejects unsound deltas (a `dependsOn` cycle) via SPARQL.
   `//crank/orchestrator:jena_energy_check` proves the real E(G) descends.

And the loop now runs against the **full materialized ratio corpus**:
`//crank/orchestrator:corpus_crank` loads `ratio-corpus.ttl` (19 claims, 17
ungrounded, L=17, R=4, S=15), grounds an ungrounded claim per crank, and the
real ARQ-SPARQL E(G) descends −9 → −11 → −13 → −15 → −17 → −19 with the dependsOn
DAG kept acyclic by `JenaGate`.

The contract, both wire ends, the deterministic+gated loop with real SPARQL
measurement over the real corpus, and a real validate→repair fleet worker are
all in place. The single remaining piece is the live **LLM proposer** (the
Claude/RunPod bidder that creatively proposes the grounding) replacing the
deterministic stand-in — everything it plugs into is built and verified.
