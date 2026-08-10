#!/usr/bin/env python3
"""AuthRequirements.md → the au: corpus.

## What this replaces

The only external normative document previously internalized here
(corpus/nav-sec-2a4.ttl) was researched by agents into JSON and then
HAND-TRANSCRIBED. That works once. It does not survive a document that changes —
and Studio's changed 674 lines across 19 commits in the week before this ran.

So this is a parser, not a transcription, and it records the source fingerprint
so drift between the corpus and the document is detectable rather than assumed
away.

## What it deliberately does NOT do

**It does not guess a rung above R0.** Every claim lands at R0 — captured, not
interpreted — because that is the honest posture for prose that has just been
read in. Promotion is evidence-driven (a conformance vector, a green theorem, a
resolving citation) and none of that exists at import time. An importer that
assigned R2 because the sentence "looked structured" would be inventing the very
thing the ladder exists to measure.

**Every modality here is machine-proposed, and none is confirmed.** Two thirds
of this document's rules state no modal verb at all — "A sponsor is owned by
exactly one platform" is a fact-shaped sentence carrying an obligation — and
even where a verb IS present it may belong to a different clause than the one
that governs (AUTH-2b's MUST_NOT comes from a "never" in its second sentence).
So the stall distinguishes the two cases, but neither claims a person agreed:
that is what promotion off R0 is for.

**It does not drop retired ids.** AUTH-37, 40 and 47 exist in no current
section: they were removed when the document was restructured. They are emitted
as tombstones, because an id hole is not an absence — a later import that
silently reused one would attach new meaning to an old reference.

## The stall is mandatory, and that is the ladder working

//rdf/lint/authoring:ladder-integrity.rq fails any claim at R0–R3 without an
au:stalledOn. So every imported claim must name what blocks it. That is not
bureaucracy: an unnamed stall cannot be assigned to anyone, and 66 claims that
all say "not formalized" with no reason is exactly the pile this system exists
to replace.

Usage:
    python3 tools/import/authreq_to_ttl.py \\
        --source /path/to/AuthRequirements.md \\
        --out corpus/studio
"""

import argparse
import hashlib
import pathlib
import re
import sys

# §4.x heading → (discipline slug, human label). The document's own structure;
# inventing a taxonomy here would be a second, competing one.
SECTIONS = {
    "4.1": ("identity", "organizations and identity"),
    "4.2": ("platforms", "platforms and sponsors"),
    "4.3": ("permissions", "permissions"),
    "4.4": ("teams", "teams and team roles"),
    "4.5": ("visibility", "visibility"),
    "4.6": ("grants", "grants"),
    "4.7": ("resellers", "resellers"),
    "4.8": ("savvi-access", "SAVVI access and staff operations"),
    "4.9": ("deploy", "environments and deployment"),
    "4.10": ("sponsor-orgs", "sponsor organizations"),
    "4.11": ("identity-mapping", "identity mapping and audit"),
    "4.12": ("tasks", "tasks, documents and attachments"),
    "4.13": ("directory", "users and organization directory"),
    "4.14": ("dev-access", "development access"),
}

RETIRED = ["AUTH-37", "AUTH-40", "AUTH-47"]

MODALITY_PATTERNS = [
    (re.compile(r"\b(MUST NOT|must never|may never|never|cannot|must not)\b", re.I), "MUST_NOT"),
    (re.compile(r"\b(MUST|are required to|is required to|requires)\b"), "MUST"),
    (re.compile(r"\b(SHOULD NOT)\b", re.I), "SHOULD_NOT"),
    (re.compile(r"\b(SHOULD)\b"), "SHOULD"),
    (re.compile(r"\b(MAY|may)\b"), "MAY"),
]


def esc(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')


def one_line(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def modality_of(text: str):
    """Return (modality, confirmed). Order matters: MUST NOT before MUST."""
    for pat, mod in MODALITY_PATTERNS:
        if pat.search(text):
            return mod, True
    return "MUST", False


def parse(md: str):
    """Yield (auth_id, section_key, text) in document order."""
    section = None
    current = None
    buf: list[str] = []

    for raw in md.splitlines():
        m = re.match(r"^#{2,4}\s+(4\.\d+(?:\.\d+)?)\s", raw)
        if m:
            key = m.group(1)
            # 4.5.1 / 4.5.2 roll up to their parent section
            section = key if key in SECTIONS else key.rsplit(".", 1)[0]
            continue

        m = re.match(r"^-\s+\*\*(AUTH-\d+[a-z]?)\*\*\s*(.*)$", raw)
        if m:
            if current:
                yield current[0], current[1], " ".join(buf)
            current = (m.group(1), section)
            buf = [m.group(2)]
            continue

        if current is not None:
            # A new top-level bullet or heading ends the current claim.
            if re.match(r"^-\s+\*\*", raw) or raw.startswith("#"):
                yield current[0], current[1], " ".join(buf)
                current, buf = None, []
            elif raw.startswith("  ") or raw.strip() == "":
                buf.append(raw.strip())
            else:
                yield current[0], current[1], " ".join(buf)
                current, buf = None, []

    if current:
        yield current[0], current[1], " ".join(buf)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--source", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    md = pathlib.Path(args.source).read_text(encoding="utf-8")
    digest = hashlib.sha256(md.encode()).hexdigest()[:16]

    claims = [(cid, sec, one_line(txt)) for cid, sec, txt in parse(md) if txt.strip()]
    if not claims:
        sys.exit("authreq_to_ttl: parsed zero claims — the document shape changed")

    seen_sections = sorted({s for _, s, _ in claims if s}, key=lambda k: [int(p) for p in k.split(".")])
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    # ── disciplines ─────────────────────────────────────────────────────────
    d = ["""# disciplines.ttl — GENERATED by tools/import/authreq_to_ttl.py.
#
# The document's own §4.x sections, used verbatim as disciplines. A conflict is
# interesting exactly when its parties differ here, so inventing a taxonomy
# would produce cross-discipline conflicts that are artifacts of the importer.

@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix au:   <https://aion.savvi.io/ontology/authoring#> .
@prefix st:   <https://aion.savvi.io/corpus/studio#> .
"""]
    for key in seen_sections:
        slug, label = SECTIONS.get(key, (key.replace(".", "-"), key))
        d.append(f'st:{slug} a au:Discipline ; rdfs:label "{esc(label)}" .')
    (out / "disciplines.ttl").write_text("\n".join(d) + "\n")

    # ── corpus ──────────────────────────────────────────────────────────────
    n_unconfirmed = 0
    c = [f"""# corpus.ttl — GENERATED by tools/import/authreq_to_ttl.py. Do not hand-edit.
#
# SAVVI Studio's authorization requirements, as claims.
#
# Source: AuthRequirements.md
# Fingerprint: sha256:{digest}
#   Re-run the importer if this stops matching the document. The previous
#   internalized document in this repo was hand-transcribed, which cannot
#   survive a source that changes — and this one changed 674 lines in the week
#   before it was first imported.
#
# ⚠ EVERY claim here is at au:R0, and none carries rfc:provenBy. That is the
# honest posture for prose that has just been read in, not a defect: nothing has
# been decomposed, no term has been grounded, and no theorem exists. The dark
# fraction for this corpus is 100%, and it should be, on day one.
#
# Retired ids ({', '.join(RETIRED)}) are TOMBSTONED rather than omitted. An id
# hole is not an absence, and a later import that reused one would attach new
# meaning to an existing reference.

@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
@prefix rfc:     <https://aion.savvi.io/ontology/rfc#> .
@prefix au:      <https://aion.savvi.io/ontology/authoring#> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix st:      <https://aion.savvi.io/corpus/studio#> .

# ⚠ NOT typed rfc:Document. The framework's DocumentShape requires an rfcId
# matching RFC-NNNN, and this is a product requirements document, not an RFC.
# Minting a fake number to satisfy a shape would invent an identity that then
# has to be maintained, so the source is recorded as plain provenance instead.
# That the framework assumes RFC-numbered documents is a genericity gap worth
# closing upstream — see the note in corpus/studio/BUILD.bazel.
st:studio-authz
    rdfs:label "Authentication & Authorization Requirements" ;
    dcterms:identifier "AuthRequirements.md" ;
    dcterms:source "gitlab.savvifi.com/platform/studio-nextjs" .
"""]

    for cid, sec, text in claims:
        slug = cid.lower()
        mod, confirmed = modality_of(text)
        if not confirmed:
            n_unconfirmed += 1
        disc = SECTIONS.get(sec, ("unassigned", ""))[0] if sec else "unassigned"
        stall = (
            "modality-unstated: the text states no modal verb, so rfc:MUST is a placeholder awaiting a person"
            if not confirmed
            else "not-decomposed: modality was pattern-matched from the claim text and nobody has confirmed it; no terms grounded, so nothing can be checked yet"
        )
        c.append(
            f"""
st:{slug} a rfc:NormativeStatement ;
    rfc:modality rfc:{mod} ;
    rfc:predicate "{esc(text)}" ;
    rdfs:label "{cid}" ;
    au:discipline st:{disc} ;
    au:rung au:R0 ;
    au:stalledOn "{esc(stall)}" ."""
        )

    for cid in RETIRED:
        c.append(
            f"""
st:{cid.lower()} a rfc:NormativeStatement ;
    rfc:modality rfc:MUST ;
    rfc:predicate "RETIRED — this identifier was removed when the document was restructured. Tombstoned so it is never reused." ;
    rdfs:label "{cid}" ;
    au:discipline st:unassigned ;
    au:rung au:R0 ;
    au:demotedBy st:retirement ;
    au:stalledOn "retired: the id no longer appears in any section of the source document" ."""
        )

    c.append(
        """
st:retirement a au:Proposal ;
    au:proposalId "p:studio-authz-retirements" ;
    au:surface au:Ingest ;
    au:intent "Tombstone identifiers dropped in the document restructure." ;
    au:verdict au:Admitted .

st:unassigned a au:Discipline ; rdfs:label "unassigned" ."""
    )
    (out / "corpus.ttl").write_text("\n".join(c) + "\n")

    print(f"claims:            {len(claims)}")
    print(f"retired tombstones:{len(RETIRED):>3}")
    print(f"disciplines:       {len(seen_sections)}")
    print(f"modality unstated: {n_unconfirmed}  (rfc:MUST is a placeholder there)")
    print(f"modality matched:  {len(claims) - n_unconfirmed}  (pattern-matched, still unconfirmed)")
    print(f"source fingerprint sha256:{digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
