#!/usr/bin/env python3
"""The corpus directory contains the corpus, and nothing else.

⛔ WHY THIS EXISTS, measured rather than imagined.

`tools/readmodel/emit_readmodel.py` decides what a project's corpus IS by
listing its directory:

    for fn in sorted(os.listdir(path)):
        if fn.endswith(".ttl"):
            srcs.append(...)

The gates decide by reading an `rdf_dataset`'s `srcs`. Those are two
descriptions of one thing, and for `corpus/ampere` they had come apart: two
derivation-test overlays sat beside the corpus as `fixtures-*.ttl`, each saying
in its own first line *"an overlay for the derivation test, NOT part of the
committed corpus"* — and the emitter loads what it finds.

⚠ **NOTHING SHIPPED WRONG, AND THE TENSE IS THE POINT.** The committed payloads
predate those fixtures, so the console has never served them. What was armed is
the NEXT regeneration — the routine step after any TTL change — and it would
have been silent. Found by running it, not by reading:

    INV-03   committed:  state "open",     outcome ""
             re-emitted: state "resolved", outcome "Narrow"

    a 65th claim, `mkt-quiet-hours`, carrying NO `au:rung` — planted precisely
    so `ladder-integrity.rq` could be shown to catch it — as an ordinary
    requirement, plus its witness row on INV-05.

    9 differing rows across 5 of the 8 payloads.

Both descriptions were internally consistent; only comparing them shows it.
`services/spec/readmodel/workorders.json` sharpens it: that payload IS derived by
the build from the dataset, so the next regeneration would have left one
directory holding payloads that describe two different corpora.

## What this compares, and why it is a filegroup rather than a parse

Two labels per project, both from the same BUILD file:

    :corpus_ttl   the dataset's srcs — what the gates say the corpus is
    :all_ttl      glob(["*.ttl"])    — what is actually in the directory

A glob is the load-bearing half: the strays this catches are by definition files
nobody listed, so a check built from lists alone could not see them. Comparing
labels rather than parsing Starlark also means the test sees exactly what Bazel
sees, and a file that is present but unstaged cannot slip through as "absent".

⚠ This does NOT check that the emitted payloads are FRESH. Re-emitting needs
rdflib, which no CI job here installs. It checks that the emitter and the gates
would be looking at the same files — the failure that had actually happened.
"""

import os
import sys
from collections import defaultdict


def main(argv):
    # Each argument is a runfiles path; the project is the directory under
    # corpus/. Which list a file belongs to is decided by the caller (the
    # py_test's args), so this script never guesses.
    if "--" not in argv:
        print("usage: corpus_is_the_corpus_test.py <corpus_ttl...> -- <all_ttl...>",
              file=sys.stderr)
        return 2
    split = argv.index("--")
    declared_paths, present_paths = argv[:split], argv[split + 1:]

    def by_project(paths):
        out = defaultdict(set)
        for p in paths:
            parts = p.replace(os.sep, "/").split("/")
            if "corpus" not in parts:
                print(f"  ✗ {p} is not under corpus/ — the args are wrong", file=sys.stderr)
                continue
            i = parts.index("corpus")
            project = parts[i + 1]
            out[project].add("/".join(parts[i + 2:]))
        return out

    declared, present = by_project(declared_paths), by_project(present_paths)

    # ⛔ An empty comparison passes. Assert the inputs before comparing them, or
    # a wiring mistake in the BUILD reads exactly like a clean corpus.
    if not declared or not present:
        print(f"FAIL — nothing to compare: {len(declared_paths)} declared, "
              f"{len(present_paths)} present. A test that examined nothing is not a pass.",
              file=sys.stderr)
        return 1

    failures = 0
    for project in sorted(set(declared) | set(present)):
        d, p = declared.get(project, set()), present.get(project, set())
        if not d or not p:
            print(f"FAIL  {project}: one side is empty (declared={len(d)}, present={len(p)})",
                  file=sys.stderr)
            failures += 1
            continue
        strays, missing = p - d, d - p
        if strays:
            failures += 1
            print(f"FAIL  corpus/{project}: {len(strays)} file(s) the emitter would load "
                  f"and no gate examines:", file=sys.stderr)
            for f in sorted(strays):
                print(f"        {f}", file=sys.stderr)
            print("      Either add them to the dataset or move them out of the corpus "
                  "directory. A fixture belongs in fixtures/.", file=sys.stderr)
        if missing:
            failures += 1
            print(f"FAIL  corpus/{project}: the dataset names {len(missing)} file(s) that "
                  f"are not there: {sorted(missing)}", file=sys.stderr)
        if not strays and not missing:
            print(f"ok    corpus/{project}: {len(d)} file(s), and the gates and the "
                  f"emitter agree on every one")

    if failures:
        print(f"\nFAIL — {failures} disagreement(s). The console would serve a corpus "
              f"the gates never ran over.", file=sys.stderr)
        return 1
    print(f"\nok    {len(declared)} project(s): the corpus directory is the corpus")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
