# Chat transcript 3 — fanning out an agent fleet, and the good failure

**A MOCK.** See [`README.md`](./README.md).

**Scene.** INV-01 is resolved and three work orders released. An architect fans out
over the now-coherent slice. One agent hits an obligation it cannot satisfy — and
the interesting part is what it does instead of guessing.

---

**d.okafor (architect)** — dispatch the released orders.

---

**spec** — Three are dispatchable. One isn't, and one has an open prompt.

```
spec__list_work_orders { "state": "all" }

order    scope                        obl  disciplines bound                       state
wo-041   thermal management ctrl       37  thermal fire market warranty cyber      READY
wo-042   bid envelope calculator       54  market thermal warranty fire settlement READY
wo-046   AGC telemetry path            29  controls cyber market                   HELD · INV-03
wo-051   NERC CIP evidence collector   88  cyber settlement                        RUNNING · 3 agents
wo-052   revenue-meter reconciliation  41  settlement finance market               RUNNING · 2 agents
wo-057   ITC domestic-content ledger   33  tax accounting procurement              PROMPT OPEN
```

`wo-046` is held because `INV-03` is still open — the cyber inspection floor at
180 ms against the 150 ms control budget, deficit 30 ms. Both claims are
non-defeasible, so it can't be adjudicated commercially; the fix is architectural.
The dispatch gate is `conflict_holds = ∅`, so it will not dispatch and I can't
override that from here.

> `[HELD is computed, not labelled. An order whose obligation closure touches an`
> `open conflict cannot dispatch — RFC-002 §10 mechanism 3.]`

---

**d.okafor** — what does wo-041 actually get handed.

---

**spec** —

```
spec__get_work_order { "order_id": "wo-041" }

scope             thermal management controller
as_of             h:c40a7b58          ← a bitemporal cursor, not "latest"
obligations       37, closure over the scope lattice across ALL disciplines:
                    thermal      6   incl. amp:warranty-derate-curve  (≤78 MW @45°C)
                    fire-safety  9   incl. amp:ahj-soc-cap, amp:ahj-cell-temp-limit
                    market       7   incl. amp:ctl-derate-publication
                    warranty     5   incl. amp:warranty-throughput-budget
                    cyber        6   incl. amp:cip-inspect-control-traffic
                    software     4   incl. amp:ctl-setpoint-clamp
non-binding       2 claims at R3 supplied as CONTEXT ONLY, explicitly marked:
                    amp:cip-cert-rotation      (stalled: no reconnect semantics)
                    amp:ctl-mode-arbitration   (stalled: priority undocumented)
glossary          aligned slice — q-soc-bms is DISJOINT from q-soc-telemetered
                  and q-soc-market-model; do not substitute
forbidden         src/bid/**, src/settle/**, src/compliance/**
write_capability  src/thermal/**  ·  spec: assertNS at R0 only
acceptance        6 decidable checks
conflict_holds    ∅
```

The point of the closure: an agent building the thermal controller is handed the
**fire-safety, market, warranty and cyber** obligations that bind its scope — not
just the thermal ones. It cannot plead ignorance of a cross-discipline requirement,
because the requirement is in its packet in one aligned vocabulary.

The two R3 claims arrive marked non-binding, and satisfaction evidence may only
reference R4+. That's the mechanism that stops half-formalized spec leaking into
implementation as if it were settled.

---

**d.okafor** — dispatch 041 and 042.

---

**spec** —

```
spec__dispatch { "orders": ["wo-041", "wo-042"], "confirm": true }

→ scope-disjointness checked pairwise against running orders: PASS
    wo-041 src/thermal/**  ∩  wo-051 src/compliance/**  = ∅
    wo-041 src/thermal/**  ∩  wo-052 src/settle/**      = ∅
    wo-042 src/bid/**      ∩  ...                       = ∅
→ dispatched: wo-041 (2 agents), wo-042 (3 agents), all pinned to as_of h:c40a7b58
```

---

## The good failure

**spec** — `wo-057` raised a `HumanPrompt`. Agent `a-7714`:

> Obligation `amp:tax-domestic-content` is unsatisfiable as written. It requires
> domestic content ≥ 45 % of eligible project cost, and requires that claimed cost
> be substantiated by supplier certifications per `amp:tax-cost-substantiation`.
> That claim is at **R3**, `stalledOn: "no claim in the corpus states which party
> is obligated to produce supplier certifications; the obligation has no subject."`
>
> The procurement records are not in my scope (`src/itc/**`), and no claim tells me
> who supplies them. I have not marked the obligation met. I have not widened my
> scope. Stopping.

This is the failure mode you want. It did not guess a party, did not reach outside
`src/itc/**`, and did not silently record the obligation as satisfied — which is
what an agent handed a prose spec would have done, because prose has no way to say
"this obligation has no subject."

Three ways forward:

1. **Author the missing claim** — state who is obligated to produce supplier
   certifications. Amends the spec, recomputes the closure, resumes `a-7714` from
   its checkpoint.
2. **Reassign scope** — extend the order to cover procurement records.
3. **Mark out of scope** — records the decision and the exposure.

---

**d.okafor** — (1). the EPC contractor produces them under the supply agreement.

---

**spec** —

```
spec__preview_proposal {
  "parent": "h:c40a7b58",
  "ops": [
    { "op": "assertNS", "modality": "MUST",
      "predicate": "The EPC contractor MUST produce supplier certifications and procurement records substantiating claimed eligible project cost, under the supply agreement.",
      "discipline": "d-taxfinance",
      "scope": { "jurisdiction": "contract", "issuing_body": "epc-contractor",
                 "instrument": "supply-agreement" } },
    { "op": "promote", "target": "amp:tax-cost-substantiation", "to": "R4",
      "evidence": "subject supplied by the new claim; obligation now has a party" }
  ],
  "confirm": false
}
```

| | |
|---|---|
| **who** | the EPC contractor |
| **must** | produce supplier certifications and procurement records substantiating claimed eligible project cost |
| **because** | supply agreement (contract scope) |
| **effect** | `amp:tax-cost-substantiation` promotes R3 → **R4**, so it becomes bindable and `a-7714` can cite it |

One flag: I'm asserting a **contract obligation** on a third party from a
conversation. If the supply agreement doesn't actually say this, the claim is
wrong and the tax position rests on it. Worth having the tax counsel confirm before
it goes to R4 — I can stage the promote separately if you'd rather.

---

**d.okafor** — stage the promote. assert the claim now, counsel confirms the promote.

---

**spec** —

```
spec__apply_proposal { "pid": "p:d17c93e0", "confirm": true }

→ ADMITTED · 1 op  (the assertNS)
→ QUEUED   · 1 op  (the promote → p-tax-counsel, capability: discipline-steward(tax))
→ amp:tax-cost-substantiation remains R3 — still non-binding
→ wo-057 stays PROMPT OPEN: a-7714's obligation is still unsatisfiable, correctly
→ a-7714 checkpoint retained; resumes automatically when the promote lands
```

Partial admission, which is normal: one proposal, one op admitted and one queued
to the principal who holds capability.

---

**d.okafor** — can i reproduce exactly what 041's agents saw?

---

**spec** —

```
spec__replay { "order_id": "wo-041" }

→ as_of h:c40a7b58 — obligation closure recomputed at that cursor: 37 obligations,
  byte-identical to the dispatched packet
→ proposal chain to that head: p:...bootstrap → p:4c1d8ab3 → p:8b02fe17 → h:c40a7b58
```

Replay is by proposal id against a pinned cursor, so it reproduces regardless of
what has been authored since — and regardless of the fact that a chat turn
composed two of those proposals. Recorded ops replay; models don't.

---

## What this transcript is arguing

The fanout claim is not "agents can't break invariants." It's four specific
mechanisms, each with a visible consequence above:

| Mechanism | Where it shows |
|---|---|
| obligation **closure**, not document handoff | `wo-041` gets 37 obligations across 6 disciplines for a thermal module |
| only **R4+** binds | two R3 claims arrive marked non-binding; evidence may not cite them |
| dispatch gated on the **conflict graph** | `wo-046` HELD by `INV-03`, not overridable from chat |
| agents write **R0 only** | `a-7714` reports; it cannot promote, and the promote it needed went to counsel |

And the honest one, from RFC-002 §7.1: **"an agent cannot promote a claim" is
currently a code property, not a theorem.** The natural mechanism — Aion's proved
row-level permission machinery — is unavailable because `spec` is *upstream* of
`aion` (§3.1). Until an equivalent exists in `spec`, the door enforces capability
in ordinary Rust and Java. Filed as §13 item 1, the largest open gap in the plan,
and it bites exactly here.

The other thing worth noticing: the model **flags that it is asserting a contract
obligation on a third party from a conversation**, and offers to stage the promote.
An authoring plane that lets a chat turn quietly create a binding claim about
someone else's contractual duties is worse than a Word document, because the Word
document doesn't get handed to eight agents as ground truth.
