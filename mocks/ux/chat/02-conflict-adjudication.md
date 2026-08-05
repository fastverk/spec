# Chat transcript 2 — adjudicating a cross-discipline conflict

**A MOCK.** See [`README.md`](./README.md).

**Scene.** INV-01 has been open for a day. Four disciplines, deficit 27 MW, nine
work orders held. The asset manager owns it. The second half of this transcript is
the part that matters most: **the model is wrong about a different conflict, and
the expert refutes it.**

---

**r.mensah (asset manager)** — INV-01. what are my actual options.

---

**spec** — Four instruments bound `q-sustained-discharge` over a four-hour window.
Sorted by whether you can breach them:

| bound | discipline | claim | defeasible? |
|---:|---|---|---|
| **≥ 82** | market | `amp:mkt-b-must-deliver` | **yes** — `amp:def-nonperformance`, charged per MWh short |
| ≤ 78 | thermal | `amp:warranty-derate-curve` | **no** — the protective function trips regardless of what any agreement says |
| ≤ 70 | fire-safety | `amp:ahj-derived-sustained-cap` | **no** — `amp:ahj-no-override` explicitly forecloses operational, economic *and* grid-emergency override |
| **≤ 55** | warranty | `amp:warranty-sustained-cap` | **yes** — `amp:def-warranty-ld`, coverage lapses for affected cells |

Two are hard walls. So the decision is only ever between the two priced ones: fall
short of the market commitment, or spend warranty life you don't have.

The binding upper bound is the **warranty** at 55, and the required lower bound is
the **market** at 82. Whatever you do, 55 is the ceiling — the fire and thermal
caps at 70 and 78 aren't binding right now, but they *would* be if the warranty
budget were healthy, so they can't be ignored in the fix either.

> `[The envelope is computed, not narrated. The defeasibility column is read from`
> `au:defeasible / au:defeatedBy, which is why "which can I breach" is answerable`
> `at all — this is what the six au:ComplianceStatus values exist to preserve.]`

---

**r.mensah** — what does each cost.

---

**spec** — I can give you the *structure* of the comparison. I don't hold the
prices, and I'd rather say so than produce a number that looks authoritative.

- **Fall short of the market commitment** → non-performance charge × (MWh short)
  × (assessment intervals remaining). The corpus has
  `amp:mkt-b-nonperformance-charge` as a MUST but no rate — the rate is in a
  settlement statement nobody has internalized.
- **Breach the warranty** → coverage lapses for affected cells. The corpus has no
  claim stating the affected-cell scope or the replacement cost.

Both are stalls, not opinions. Want me to open them as claims so the next person
inherits the comparison instead of redoing it?

---

**r.mensah** — yes. and i already know the answer — the non-performance exposure
over the remaining intervals is bigger than the cells we'd burn. re-offer at 55.

---

**spec** — That's `au:Narrow` on the market claim, not a waiver on anything. Preview:

```
spec__preview_proposal {
  "parent": "h:a71f0d92",
  "ops": [
    { "op": "amendNS", "target": "amp:mkt-b-must-deliver",
      "bound": { "kind": "LowerBound", "value": 55.0 } },
    { "op": "adjudicate", "conflict": "INV-01", "outcome": "Narrow",
      "decided_by": "p-asset-mgr",
      "rationale": "Re-offer the capacity commitment at 55 MW for the remainder of the delivery year. The fire and thermal caps are non-defeasible; both remaining options are priced; non-performance exposure over the remaining assessment intervals exceeds the value of the cells a warranty breach would void. Narrowing preferred to Exempt: a waiver would need renewal and would leave the empty envelope standing in the graph." },
    { "op": "assertNS", "modality": "MUST", "rung": "R1",
      "predicate": "The non-performance charge rate applicable to the committed capacity obligation SHALL be recorded from the settlement statement.",
      "stalled_on": "rate not internalized; source is a settlement statement outside the corpus" },
    { "op": "assertNS", "modality": "MUST", "rung": "R1",
      "predicate": "The affected-cell scope and replacement cost of a warranty throughput breach SHALL be recorded.",
      "stalled_on": "no claim states the affected-cell scope" }
  ],
  "confirm": false
}
```

Note what narrowing does **not** do: the 27 MW deficit doesn't disappear. It
becomes a known revenue reduction with your name on it. The conflict object stays
in the graph with its witness — the record of the decision is the deliverable.

**Not** offering you `au:Exempt`, and here's why: a waiver on a non-defeasible
fire condition is the move this system exists to make expensive.
`conflict-hygiene.rq` would flag it on expiry, and an unbounded one is
indistinguishable from having quietly dropped the requirement.

---

**r.mensah** — confirm.

---

**spec** —

```
spec__apply_proposal { "pid": "p:8b02fe17", "confirm": true }

→ ADMITTED · 4 ops · INV-01 resolved (Narrow)
→ empty-envelope.rq over q-sustained-discharge: 0 rows  ← envelope non-empty, [55, 55]
→ released: wo-041, wo-042, wo-046  (conflict_holds now empty)
→ 2 new R1 claims on the frontier, both naming their blocker
```

---

## The second half — the model is wrong

**r.mensah** — while you're here, what's INV-10.

---

**spec** — Station power. `amp:mkt-a-station-power-netting` (market, MUST) requires
netting auxiliary load against delivered energy at the meter;
`amp:acct-gross-vs-net` (accounting, MUST) requires net presentation of amounts
collected on behalf of another party. Both constrain `q-station-power`, they're in
different disciplines, and neither cites the other — so the co-constraint detector
surfaced them and I opened a conflict.

---

**r.mensah** — that's not a conflict. get the controller on it, but I'll tell you
now — those are about different things. the tariff says how station load is
*settled*. the standard says how the resulting cash flow is *presented*. netting
at the meter and net presentation aren't in tension, they point the same way.

---

**spec** — You're right, and I want to be precise about what I got wrong, because
it isn't the detector.

`cross-discipline-coconstraint.rq` correctly reported that two claims from
different disciplines constrain `q-station-power` with no mutual citation. That
finding is true. **The error is mine**: I inferred incompatibility from a shared
quantity. Sharing a quantity makes a pair a *candidate*, not a conflict.

There's also a real defect underneath, which your explanation exposes:
`q-station-power` is doing two jobs — a physical power flow at the MV bus, and a
settlement line item. Those are different referents and should be two quantities
with an `au:viaModel` between them. Had they been, the pair would never have been
generated.

```
spec__preview_proposal {
  "parent": "h:c40a7b58",
  "ops": [
    { "op": "adjudicate", "conflict": "INV-10", "outcome": "Refute",
      "decided_by": "p-controller",
      "rationale": "Not a conflict. The tariff governs how station load is SETTLED (netted at the meter); the accounting standard governs how the resulting cash flow is PRESENTED. Compatible and in fact aligned. The co-constraint detector was correct to surface the pair; the inference that touching the same quantity implies incompatibility is the error, and it is the assistant's to correct, not the detector's to suppress." },
    { "op": "assertNS", "modality": "MUST", "rung": "R1",
      "predicate": "Station auxiliary load SHALL be represented as two distinct quantities — a physical power flow at the collector bus and a settlement line item — related by a named conversion model.",
      "stalled_on": "needs the settlement convention confirmed before the model can be named" }
  ],
  "confirm": false
}
```

`au:Refute` records the correction **together with the detector that produced the
false positive**, so the mechanism is what improves. It does not suppress the
query or add an exception.

---

**r.mensah** — confirm. and the controller should still see it.

---

**spec** — Applied, and routed to `p-controller` for concurrence — the refutation
is recorded under their principal since accounting presentation is their
discipline, not yours. If they disagree, the conflict reopens with both positions
recorded.

---

## What this transcript is arguing

The first half is the easy case: a real conflict, a defensible decision, recorded
as a formal expiring object with a named decision-maker.

**The second half is the load-bearing one.** A spec system a domain expert cannot
correct is worthless, and the failure mode to worry about is not "the model misses
a conflict" — it's "the model asserts a conflict confidently, the expert can't
overrule it, and everyone learns to ignore the board."

Four properties are on trial there:

1. The model **accepts the correction** without arguing.
2. It **localizes the error correctly** — the detector was right, the inference
   was wrong. Suppressing the query would have been the tempting fix and the
   wrong one.
3. It **finds the real defect** the expert's reasoning exposed (one quantity doing
   two jobs) and files it rather than just closing the ticket.
4. The refutation is **recorded under the principal with authority** — the
   controller, not the asset manager who happened to be in the chat.

Also worth noting: the model **declines to produce the cost numbers**. It gives
the structure of the comparison and opens two stalls instead of inventing a rate.
That is the behaviour that makes the rest of its output trustworthy.
