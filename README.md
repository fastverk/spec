# fastverk/spec

This repository is the **spec / corpus spine vehicle**: Lean, crank, RDF /
readmodel, corpus gates, the grounding console, the Eve markup assistant, and
conformance / smoke. It is an explicit ship surface in the collapse story,
orthogonal to platform, desktop, plugin-shell, and contracts.

It is **not** lockstepped with those vehicles. A change that ships `spec`
0.8.4 does not bump `forge`, `fvkit`, or `fastverk_contracts`. Source repos
for those vehicles stay where they are; this tree does not subtree-import
them.

**Git repo ≠ Bazel module.** This git vehicle currently holds two Bazel
modules. Consumers keep writing whichever module they actually depend on:

```python
bazel_dep(name = "spec", version = "0.8.3")
```

The nested registry-consumer smoke is a second module
(`spec_smoke_consumer` 0.0.0) and is not a published product. Module names
and versions are **not** rewritten to a vehicle-wide number.

Published framework identity lives in the root
[`MODULE.bazel`](MODULE.bazel) (`module(name = "spec", version = "0.8.3")`).
See [LEDGER.md](LEDGER.md) for every include / absorb / exclude row.

## Layout

```
spec/
  README.md                 # this file — spine vehicle
  LEDGER.md                 # every include / optional / absorb / exclude row
  MODULE.bazel              # module(name = "spec", version = "0.8.3")
  tools/ledger-check.sh     # CI: LEDGER include dirs exist; excludes do not
  lean/                     # Lean spec libs + proof ratchet
  crank/                    # E(G)-descent harness
  rdf/                      # ontology, SPARQL gates, readmodel queries
  corpus/                   # flagship corpora + gate data
  grounding/                # grounding_verified + adversarial gate
  console/                  # hosted grounding / authoring console
  agent/                    # Eve markup assistant
  conformance/              # shared JSON cases
  smoke/consumer/           # module(name = "spec_smoke_consumer", version = "0.0.0")
  java/                     # Jena/RDF corpus toolkit
  services/                 # Rust spec plugin + materialized readmodel
```

This is native content, not a cluster of subtree-imported sibling repos.
Sibling vehicles are not deleted or archived by this work.

## Tags

The published module is the **root** `spec` module. Tags stay repo-root
`vX.Y.Z` and must match `module(version = ...)` in `MODULE.bazel`:

```
v0.8.3
```

Do not tag a vehicle-wide version that implies platform / desktop /
plugin-shell / contracts moved in lockstep. Do not rename `spec` to match
the git repo layout of those other vehicles.

The nested `spec_smoke_consumer` module is unpublished (`0.0.0`).

## How to cut a release

1. Change the spine. Leave other vehicles alone.
2. Bump **this** module's `module(version = ...)` in the root `MODULE.bazel`
   (and the matching [LEDGER.md](LEDGER.md) include rows). Do not rename
   `spec`. Do not bump `spec_smoke_consumer` into a published identity.
3. Merge to this repo's default branch.
4. Tag the merge commit `vX.Y.Z` and publish the registry entry from a
   bazel-registry checkout, as today.
5. Bump the pin in `smoke/consumer/MODULE.bazel` **after** the registry
   entry exists. That job is what proves the tag actually resolves.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) already gates proofs,
build, test, the registry-consumer smoke, and the console. This vehicle adds
one cheap job:

| Change | What runs |
| --- | --- |
| `LEDGER.md` / `README.md` / `tools/ledger-check.sh` | ledger check (plus the existing spine jobs) |
| anything else | existing bazel / console / consumer jobs, plus ledger check |

[`tools/ledger-check.sh`](tools/ledger-check.sh) fails CI if an include dir
is missing, if an exclude name exists as a top-level directory, or if the
documented `module(name)` / `module(version)` rows disagree with
`MODULE.bazel`.

## Provenance

Native. Not `git subtree add` from sibling fastverk repos. Do not squash
history to fake an import. Do not collapse platform / desktop / plugin-shell
/ contracts / tomato-bazel/rules into this tree.

[LEDGER.md](LEDGER.md) records, for every include, optional, absorb, and
exclude row: whether the tree is native, which Bazel module it belongs to,
and which other vehicle an exclude belongs to.

## What this repo is not

- Not a lockstep version for the constellation.
- Not a subtree-import vehicle of many source repos.
- Not [fastverk/platform](https://github.com/fastverk/platform) (gateway /
  adapter vehicle: forge, tracker, service-finder, wave).
- Not [fastverk/desktop](https://github.com/fastverk/desktop) (desktop /
  runtime vehicle: fvkit, fastverk-app).
- Not `fastverk/plugin-shell` (console plugins are a different vehicle).
- Not [fastverk/contracts](https://github.com/fastverk/contracts) (public
  protos; `fastverk_contracts`).
- Not [tomato-bazel/rules](https://github.com/tomato-bazel/rules) (rules_*
  modules this spine depends on).
- Not [fastverk/botnoc](https://github.com/fastverk/botnoc) (private shell /
  control plane).
- Not a rewrite of `module(name = "spec")` or `module(version = "0.8.3")`.
