"""The row shapers — one SPARQL result row to one payload row.

⛔ ONE IMPLEMENTATION, TWO CALLERS, and that is the entire reason this file
exists as a file.

`tools/readmodel/emit_readmodel.py` runs these questions under **rdflib**;
`tools/readmodel/assemble.py` runs them under **ARQ**, the engine of record
(RFC-005 §3), from inside the build. While both paths exist, any difference
between their payloads must be attributable to the ENGINE and to nothing else —
so the shaping cannot be written twice. A second copy would make every diff
ambiguous exactly when the diff is the thing being read.

## What a shaper may assume about `r`

Attribute access per SELECT variable, returning **typed Python values**:

    unbound          None          — NOT "" ; the two are different facts and
                                      several shapers turn on the difference
    an IRI           str           — the full IRI; call `local()` for the tail
    xsd:boolean      bool
    xsd:integer      int
    xsd:decimal/double  float
    anything else    str

⚠ The `None`/`""` distinction is load-bearing in four places and each says so
where it matters: an unbound `au:boundTo` is an OPEN HOLE, not a term bound to
nothing; an unevaluated claim shows `—` and not `0`; an absent `au:defeasible`
is unknown and not false; an absent bound value is not zero.

⚠ And the typing is load-bearing once: `str(bool(r.defeasible)).lower()`. Given
the STRING `"false"` — which is what a TSV cell decodes to if the datatype is
dropped — `bool("false")` is **True**, and every non-defeasible claim in the
corpus would silently flip to defeasible. rdflib returns a real bool; so does
`assemble.py`'s decoder, deliberately, and that is why it is a decoder rather
than a `split("\t")`.
"""

def local(term):
    """Local name of an IRI, for stable short ids in the payload."""
    if term is None:
        return None
    s = str(term)
    for sep in ("#", "/"):
        if sep in s:
            s = s.rsplit(sep, 1)[-1]
    return s


def shape_conflict(r):
    return {
        "id": local(r.conflict),
        "kind": local(r.kind) or "",
        "quantity": local(r.quantity) or "",
        # ⛔ SORTED, because GROUP_CONCAT's order is UNSPECIFIED in SPARQL 1.1 and
        # the two engines genuinely differ: ARQ and rdflib concatenate the same
        # three disciplines in different orders for INV-19. Neither is wrong, and
        # a payload whose field order depends on which engine ran is a payload
        # that cannot be compared — or diffed in review. Sorting here makes the
        # row deterministic without asking the query for something SPARQL cannot
        # portably express.
        "disciplines": " x ".join(sorted(
            p for p in str(r.disciplines or "").split(" x ") if p)),
        "party_count": int(r.partyCount or 0),
        "blocked_orders": int(r.blockedOrders or 0),
        "owner": local(r.owner) or "",
        # State is derived, not stored: a conflict with no au:Resolution is open.
        # RFC-002 §7 keeps UNRESOLVED a measure rather than a gate, so "open" is a
        # legitimate steady state and the board must be able to show it.
        "state": "resolved" if r.resolution else "open",
        "outcome": local(r.outcome) or "",
    }


def shape_envelope(r):
    return {
        "quantity": local(r.quantity),
        "unit": str(r.unit or ""),
        "greatest_lower": float(r.greatestLower),
        "least_upper": float(r.leastUpper),
        "deficit": float(r.deficit),
        "disciplines": int(r.disciplines or 0),
        # An infeasibility with no au:Conflict naming it is what
        # envelope-unrecorded.rq gates on. Surfacing the flag here means the board
        # shows the gate's subject, not just its verdict.
        "recorded": bool(int(r.recorded or 0) > 0),
    }


def shape_stall(r):
    return {
        "claim_id": local(r.claim),
        "rung": local(r.rung),
        "discipline": str(r.discipline or ""),
        "stalled_on": str(r.stalledOn or ""),
        "dependent_count": int(r.dependents or 0),
    }


def shape_discipline(r):
    claims = int(r.claims or 0)
    typed = int(r.typedClaims or 0)
    dark = int(r.darkClaims or 0)
    return {
        "discipline": str(r.discipline or ""),
        "steward": local(r.steward) or "",
        "claim_count": claims,
        "typed_count": typed,
        "non_defeasible_count": int(r.nonDefeasible or 0),
        "dark_count": dark,
        # Percentages precomputed so the table descriptor needs no client-side
        # arithmetic — meridian columns render a field, they do not compute.
        "dark_pct": round(100.0 * dark / claims, 1) if claims else 0.0,
        # The leading indicator: a discipline with a low typed ratio cannot
        # participate in envelope detection at all, so its conflicts are
        # invisible rather than absent.
        "typed_pct": round(100.0 * typed / claims, 1) if claims else 0.0,
    }


def shape_claim(r):
    return {
        "claim_id": local(r.claim),
        "discipline": str(r.discipline or ""),
        "modality": local(r.modality) or "",
        "rung": local(r.rung) or "",
        "quantity": local(r.quantity) or "",
        "instrument": str(r.instrument or ""),
        "defeasible": "" if r.defeasible is None else str(bool(r.defeasible)).lower(),
        "predicate": str(r.predicate or ""),
    }


def shape_witness_party(r):
    return {
        "conflict_id": local(r.conflict),
        "quantity": local(r.quantity) or "",
        "unit": str(r.unit or ""),
        "claim_id": local(r.party),
        "discipline": str(r.discipline or ""),
        "modality": local(r.modality) or "",
        "bound_kind": local(r.boundKind) or "",
        "bound_value": None if r.boundValue is None else float(r.boundValue),
        "guard": str(r.guard or ""),
        # The column that makes the witness actionable rather than merely
        # alarming: a non-defeasible bound cannot be traded away at any price.
        "defeasible": "" if r.defeasible is None else str(bool(r.defeasible)).lower(),
    }


def shape_requirement(r):
    evaluated = r.outcome is not None or r.population is not None
    return {
        "requirement_id": local(r.claim),
        # The sentence itself. Without it the generated document can only list
        # identifiers, which is not a document anyone would read.
        "predicate": str(r.predicate or ""),
        "discipline": str(r.discipline or ""),
        "modality": local(r.modality) or "",
        "rung": local(r.rung) or "",
        # Which implementation answered. Empty when nothing has.
        "implementation": str(r.impl or ""),
        # ⛔ "—" and 0 are DIFFERENT and the distinction is the point: 0 means a
        # check ran and examined nothing (vacuous); "—" means no check has ever
        # run. Rendering both as 0 is how a requirement ends up looking guarded.
        "population": "—" if r.population is None else str(int(r.population)),
        "outcome": local(r.outcome) or ("NOT-EVALUATED" if not evaluated else ""),
        "blocked_on": str(r.stall or ""),
    }


def shape_term(r):
    return {
        "requirement_id": local(r.claim),
        "term_id": local(r.term),
        "surface": str(r.surface or ""),
        # Whether the author marked it, or a machine inferred it. Not equally
        # trustworthy, so not collapsed.
        "term_source": str(r.source or ""),
        "bound_to": "" if r.bound is None else str(r.bound),
        "open": r.bound is None,
        # Cleared as not-a-term by a person, and adopted into the corpus.
        "retired": r.demoted is not None,
    }
