#!/usr/bin/env python3
"""The proposal log → the corpus. The step that makes a proposal real.

## Why this is a separate act, and not something the service does

Writing through the portal appends to an append-only log and the service
overlays that log on what you see, marked PENDING. Nothing is edited in place.
This tool is the promotion: it turns admitted proposals into TTL that lands in
the corpus, which is what the gates run over and what CI checks.

Keeping the two apart is the whole discipline:

  the log      who proposed what, when, against which read point — never rewritten
  the corpus   what the project currently commits to — generated, gated, reviewed

If the service wrote straight to the corpus there would be no reviewable step
between "someone clicked a button" and "the specification changed", and the
gates would be checking a document nobody read.

## What it will not do

**Invent a rung.** A bound term does NOT promote its claims to R3. R3 means
*every* term in a claim resolves; binding one of nine terms in AUTH-31 moves
nothing, and a promotion computed from a partial binding would report progress
that does not exist. Rungs stay where the evidence puts them; this tool records
bindings and lets `ladder-integrity` see what follows.

**Resolve a conflict between two authors.** Later record wins, per the log's
order, and both remain in the log. If that is wrong, the answer is a third
proposal, not an edit here.

Usage:
    python3 tools/proposals/materialize.py \\
        --log /tmp/spec-proposals.jsonl --corpus corpus/studio --project studio
    python3 tools/proposals/materialize.py ... --check    # exit 1 if stale
"""

import argparse
import json
import pathlib
import re
import sys


def esc(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')


def slug(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s[:60] or "term"


def read_log(path: pathlib.Path, project: str):
    """Ops in log order, scoped to one project.

    A record whose canonical body will not parse is SKIPPED. The log is
    append-only and one bad line must not hide the good ones written after it.
    """
    ops = []
    if not path.exists():
        return ops
    # ⛔ split("\n"), never splitlines(). Python splits on U+2028, U+2029 and
    # U+0085 as well as \n; JSON does not, and serde_json emits all three RAW
    # inside a string rather than escaping them. So a proposal whose text carried
    # a LINE SEPARATOR — paste from a PDF is the usual way — became two fragments
    # here, neither of which parsed, and both were skipped by the except below.
    # The record stayed in the log, never promoted, and read as "pending, not yet
    # adopted" in the console forever, with no error anywhere. Measured, not
    # inferred: one such line splits into 2 pieces and 0 of them json.loads().
    for line in path.read_text(encoding="utf-8").split("\n"):
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
            body = json.loads(rec["canonical"])
        except Exception:
            continue
        author = rec.get("author_email") or rec.get("author") or ""
        for op in body.get("ops", []):
            # An op with no project applies everywhere; the portal always sends one.
            if op.get("project") and op["project"] != project:
                continue
            ops.append((op, author, rec.get("parent", "")))
    return ops


def read_evaluations(path: pathlib.Path, project: str):
    """Latest measurement per (claim, implementation).

    ⛔ A vacuous pass is DROPPED here as well as refused at the door. This tool
    can be pointed at any file, including one hand-edited, and promoting an
    evaluation that examined zero records while claiming a result would write
    the exact defect //rdf/lint/authoring:vacuous-invariant.rq exists to catch —
    into the corpus that gate runs over.
    """
    out = {}
    if not path.exists():
        return out
    # Same reason as read_log above: splitlines() would break a record carrying
    # U+2028/U+2029/U+0085 into unparseable fragments and drop it silently.
    for line in path.read_text(encoding="utf-8").split("\n"):
        if not line.strip():
            continue
        try:
            r = json.loads(line)
        except Exception:
            continue
        if r.get("project") and r["project"] != project:
            continue
        claim, imp = r.get("claim", ""), r.get("implementation", "")
        pop, outcome = r.get("population"), r.get("outcome", "")
        if not claim or outcome not in ("Passes", "Fails", "Examined", "Vacuous", "CannotBeGrounded"):
            continue
        if outcome in ("Passes", "Fails", "Examined") and (pop is None or pop == 0):
            print(f"  DROPPED {claim}: {outcome} over {pop} records is not a result", file=sys.stderr)
            continue
        out[(claim, imp)] = r
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--log", required=True)
    ap.add_argument("--evaluations", help="the evaluation log (measurements, not judgements)")
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--project", required=True)
    ap.add_argument("--check", action="store_true",
                    help="exit 1 if the corpus does not already match the log")
    args = ap.parse_args()

    ops = read_log(pathlib.Path(args.log), args.project)
    evals = read_evaluations(pathlib.Path(args.evaluations), args.project) if args.evaluations else {}

    bound, aligned, retracted_terms = {}, {}, {}
    amended, retracted_ns, asserted = {}, {}, {}
    authors = {}

    for op, author, _parent in ops:
        kind = op.get("op", "")
        if kind == "bindTerm":
            bound[op["term"]] = op.get("definition", "")
        elif kind == "alignTerm":
            aligned[op["term"]] = op.get("aligns_to", "")
        elif kind == "retractTerm":
            retracted_terms[op["term"]] = op.get("reason", "")
        elif kind == "amendNS":
            amended.setdefault(op["subject"], {}).update(
                {k: v for k, v in op.items() if k in ("text", "discipline", "modality") and v}
            )
        elif kind == "retractNS":
            retracted_ns[op["subject"]] = True
        elif kind == "assertNS":
            asserted[op["subject"]] = op
        else:
            continue
        authors[op.get("term") or op.get("subject") or ""] = author

    lines = ["""# proposals.ttl — GENERATED by tools/proposals/materialize.py.
# Do not hand-edit; edit by making another proposal.
#
# Admitted proposals from the authoring log, as corpus statements. Every one
# carries au:promotedBy so ladder-integrity can see that a person — named here —
# is responsible for it, not the importer.
#
# ⛔ A bound term does NOT promote its claims. R3 means every term in a claim
# resolves; binding one of AUTH-31's nine moves nothing. Rungs stay where the
# evidence puts them.

@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix rfc:  <https://aion.savvi.io/ontology/rfc#> .
@prefix au:   <https://aion.savvi.io/ontology/authoring#> .
@prefix st:   <https://aion.savvi.io/corpus/PROJECT#> .

st:authoring a au:Proposal ;
    au:proposalId "p:PROJECT-authoring-log" ;
    au:surface au:Meridian ;
    au:intent "Bindings, alignments and amendments made by people in the console." ;
    au:verdict au:Admitted .
""".replace("PROJECT", args.project)]

    for term, definition in sorted(bound.items()):
        lines.append(
            f'\nst:term-{slug(term)}\n'
            f'    au:boundTo "{esc(definition)}" ;\n'
            f'    au:promotedBy st:authoring ;\n'
            f'    rdfs:comment "bound by {esc(authors.get(term, ""))}" .'
        )
    for term, other in sorted(aligned.items()):
        lines.append(
            f'\nst:term-{slug(term)}\n'
            f'    au:alignsTo st:term-{slug(other)} ;\n'
            f'    au:promotedBy st:authoring .'
        )
    for term, why in sorted(retracted_terms.items()):
        lines.append(
            f'\nst:term-{slug(term)}\n'
            f'    au:demotedBy st:authoring ;\n'
            f'    rdfs:comment "not a term: {esc(why or "no reason given")}" .'
        )
    for subject, fields in sorted(amended.items()):
        body = [f'\nst:{subject}']
        if "text" in fields:
            body.append(f'    rfc:predicate "{esc(fields["text"])}" ;')
        if "modality" in fields:
            body.append(f'    rfc:modality rfc:{fields["modality"]} ;')
        if "discipline" in fields:
            body.append(f'    au:discipline st:{fields["discipline"]} ;')
        body.append('    au:promotedBy st:authoring .')
        lines.append("\n".join(body))
    for subject in sorted(retracted_ns):
        lines.append(
            f'\nst:{subject}\n'
            f'    au:demotedBy st:authoring ;\n'
            f'    au:stalledOn "withdrawn: an author proposed removing this requirement" .'
        )
    for subject, op in sorted(asserted.items()):
        lines.append(
            f'\nst:{subject} a rfc:NormativeStatement ;\n'
            f'    rfc:modality rfc:{op.get("modality", "MUST")} ;\n'
            f'    rfc:predicate "{esc(op.get("text", ""))}" ;\n'
            f'    rdfs:label "{esc(subject.upper())}" ;\n'
            f'    au:discipline st:{op.get("discipline", "unassigned")} ;\n'
            f'    au:rung au:R0 ;\n'
            f'    au:promotedBy st:authoring ;\n'
            f'    au:stalledOn "not-decomposed: newly written, nothing has broken it into terms yet" .'
        )

    for (claim, imp), r in sorted(evals.items()):
        pop = r.get("population")
        ev = f"st:eval-{slug(claim)}-{slug(imp)}"
        body = [
            f'\nst:{claim} au:evaluatedBy {ev} .',
            f'\n{ev} a au:Evaluation ;',
            f'    au:implementation "{esc(imp)}" ;',
            f'    au:outcomeOf au:{r["outcome"]} ;',
        ]
        # A missing population is only legal for CannotBeGrounded — the check
        # never ran, so there is nothing to have counted. Emitting au:population
        # anyway would invent a measurement.
        if pop is not None:
            body.append(f'    au:population {int(pop)} ;')
        if r.get("query_fingerprint"):
            body.append(f'    au:queryFingerprint "{esc(r["query_fingerprint"])}" ;')
        body.append(f'    rdfs:comment "recorded by {esc(r.get("author", ""))}" .')
        lines.append("\n".join(body))

    out = pathlib.Path(args.corpus) / "proposals.ttl"
    text = "\n".join(lines) + "\n"

    if args.check:
        current = out.read_text(encoding="utf-8") if out.exists() else ""
        if current != text:
            print(
                f"STALE — {out} does not match {args.log}.\n"
                f"  Re-run without --check to promote the log into the corpus.",
                file=sys.stderr,
            )
            return 1
        print(f"up to date: {out}")
        return 0

    out.write_text(text)
    print(f"ops read:          {len(ops)}")
    print(f"terms bound:       {len(bound)}")
    print(f"terms aligned:     {len(aligned)}")
    print(f"terms retracted:   {len(retracted_terms)}")
    print(f"claims amended:    {len(amended)}")
    print(f"claims withdrawn:  {len(retracted_ns)}")
    print(f"claims written:    {len(asserted)}")
    print(f"evaluations:       {len(evals)}")
    print(f"-> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
