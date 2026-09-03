# Ledger

Provenance for every native spine include, every absorb, and every explicit
exclude. This file is the source of truth for what belongs in this git vehicle.

This vehicle's primary content is **native** to
[`fastverk/spec`](https://github.com/fastverk/spec). It is **not** a
subtree-import vehicle of sibling fastverk repos. Do not `git subtree add`
platform, desktop, plugin-shell, contracts, tomato-bazel/rules, or their
module directories into this tree.

**Git repo ≠ Bazel module.** This git repo may contain more than one Bazel
module. Importing or grouping a tree does not rename `module(name=...)` and
does not rewrite `module(version=...)`. Consumers keep `bazel_dep` on the
names and versions declared in each `MODULE.bazel`.

Modules in this git vehicle today:

| Path | `module(name)` | `module(version)` | Notes |
| --- | --- | --- | --- |
| `./MODULE.bazel` (repo root) | `spec` | `0.8.3` | published framework (`registry.tbzl.dev` `spec`); do not rename |
| `smoke/consumer/MODULE.bazel` | `spec_smoke_consumer` | `0.0.0` | in-repo registry-consumer smoke only; not a published product; do not rename |

Status (same vocabulary as other vehicles):

- `imported` — present in this tree. For this vehicle that means **native**,
  not subtree-imported from a sibling repo, unless a row says otherwise.
- `pending` — listed for a follow-up PR; not in the tree. Do not pretend
  these are present.
- `absorb` — must not appear as a module directory here; residue belongs with
  another included area.
- `excluded` — must not appear as a top-level directory here. Those names
  belong to other vehicles.

## Includes (native spec / corpus spine)

Present in this repository. Not lockstepped with
[`fastverk/platform`](https://github.com/fastverk/platform),
[`fastverk/desktop`](https://github.com/fastverk/desktop),
[`fastverk/plugin-shell`](https://github.com/fastverk/plugin-shell),
[`fastverk/contracts`](https://github.com/fastverk/contracts), or
[`tomato-bazel/rules`](https://github.com/tomato-bazel/rules).

| Dir | Status | Source | SHA | `module(name)` | `module(version)` | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| lean | imported | native (`fastverk/spec`) | native | spec | 0.8.3 | Lean spec libs (`Spec.Kernel`, grounding write-door, compaction, authoring); `//lean:audit_proofs_test` is the sorry/axiom ratchet |
| crank | imported | native (`fastverk/spec`) | native | spec | 0.8.3 | E(G)-descent harness (RFC-001b); belongs here, not on the platform vehicle |
| rdf | imported | native (`fastverk/spec`) | native | spec | 0.8.3 | RDF ontology, SPARQL gates, authoring lint, `rdf/readmodel` queries |
| corpus | imported | native (`fastverk/spec`) | native | spec | 0.8.3 | flagship corpora + gate data; the corpus directory is the corpus |
| grounding | imported | native (`fastverk/spec`) | native | spec | 0.8.3 | `grounding_verified` + adversarial gate; `:provenBy` must resolve to a sorry-free Lean theorem |
| console | imported | native (`fastverk/spec`) | native | spec | 0.8.3 | hosted grounding / authoring console (Next.js); not the desktop or plugin-shell vehicles |
| agent | imported | native (`fastverk/spec`) | native | spec | 0.8.3 | Eve markup assistant (`preview_decomposition` / `read_corpus` / `propose_requirement`); not the private `fastverk/agents` fleet |
| conformance | imported | native (`fastverk/spec`) | native | spec | 0.8.3 | shared JSON cases every implementation executes |
| smoke | imported | native (`fastverk/spec`) | native | spec_smoke_consumer | 0.0.0 | nested Bazel module at `smoke/consumer`; pins published `spec` from the registry |
| java | imported | native (`fastverk/spec`) | native | spec | 0.8.3 | Jena/RDF corpus toolkit (`kg.Loader`, gates, `kg.edit`) |
| services | imported | native (`fastverk/spec`) | native | spec | 0.8.3 | Rust spec plugin + materialized readmodel payloads |

Also native (not a separate vehicle; not subtree-imported): `proto/`, `tools/`,
`docs/`, `examples/`, `graph/`, `deck/`, `paper/`, `impact/`, `deploy/`,
`mocks/`, `logs/`. Those stay here as product / docs / deploy surface for
this spine.

## Optional later

Not queued. This vehicle does **not** take subtree imports from sibling
fastverk repos. Later work on the spine lands as native commits here.

## Absorb

Never create these as a module directory in this vehicle. Residue belongs
with an included area.

None. No residue from another vehicle's imported module belongs here.

## Follow-up (not this PR)

- [ ] Keep publishing `spec` from this repo's root tags (`vX.Y.Z` matching
      `module(version)`). Do not invent a lockstep vehicle-wide version that
      also bumps platform / desktop / plugin-shell / contracts.
- [ ] Do not subtree-import sibling vehicles into this tree.
- [ ] Do not rename `spec` or `spec_smoke_consumer`.

## Follow-up import checklist

This vehicle does not subtree-import sibling repos. Native spine dirs above
are already in the tree.

- [x] lean
- [x] crank
- [x] rdf
- [x] corpus
- [x] grounding
- [x] console
- [x] agent
- [x] conformance
- [x] smoke
- [x] java
- [x] services

## Excludes

Do not create these directories. Do not import them into this vehicle.
They belong to other ship surfaces.

### Other vehicles

| Name | Status | Why excluded |
| --- | --- | --- |
| platform | excluded | [fastverk/platform](https://github.com/fastverk/platform) is the gateway/adapter vehicle |
| desktop | excluded | [fastverk/desktop](https://github.com/fastverk/desktop) is the desktop/runtime vehicle |
| plugin-shell | excluded | [fastverk/plugin-shell](https://github.com/fastverk/plugin-shell) is the console-plugin vehicle |
| contracts | excluded | [fastverk/contracts](https://github.com/fastverk/contracts) is the public-proto vehicle (`fastverk_contracts`) |
| rules | excluded | [tomato-bazel/rules](https://github.com/tomato-bazel/rules) is the rules_* vehicle; this repo `bazel_dep`s those modules, it does not own them |

### Platform cluster (forge / tracker / wave / service-finder)

| Name | Status | Why excluded |
| --- | --- | --- |
| forge | excluded | [fastverk/forge](https://github.com/fastverk/forge) — platform vehicle, not this repo |
| tracker | excluded | [fastverk/tracker](https://github.com/fastverk/tracker) — platform vehicle, not this repo |
| service-finder | excluded | [fastverk/service-finder](https://github.com/fastverk/service-finder) — platform vehicle, not this repo |
| wave | excluded | [fastverk/wave](https://github.com/fastverk/wave) — platform vehicle, not this repo |
| geetch | excluded | forge.v1 adapter; platform vehicle (pending there), not this repo |

### Desktop cluster (fvkit / fastverk-app)

| Name | Status | Why excluded |
| --- | --- | --- |
| fvkit | excluded | [fastverk/fvkit](https://github.com/fastverk/fvkit) — desktop/runtime vehicle, not this repo |
| fastverk-app | excluded | [fastverk/fastverk-app](https://github.com/fastverk/fastverk-app) — macOS app; desktop vehicle |

### Control plane / plugins

| Name | Status | Why excluded |
| --- | --- | --- |
| botnoc | excluded | botnoc shell / control plane; out of this vehicle |
| agents | excluded | private agent fleet (`fastverk/agents`); this vehicle's Eve assistant is native `agent/` |
| plugins | excluded | plugin collection; plugin-shell vehicle, not this repo |
| plugin-planning | excluded | absorb into `wave` on the platform vehicle; not this repo |

### Engines

| Name | Status | Why excluded |
| --- | --- | --- |
| mycelium | excluded | engine; consumes this spine, is not imported into it |
| polyglot | excluded | engine; not this vehicle |
| agora | excluded | engine; not this vehicle |

## Import method

Do **not** subtree-import sibling fastverk repos into `fastverk/spec`.

```sh
# not this vehicle
git subtree add --prefix=<dir> https://github.com/fastverk/<dir>.git main
```

Native spine changes land as ordinary commits on this repo. After any
`MODULE.bazel` version bump, update the matching include row (`spec` /
`spec_smoke_consumer`) rather than renaming the module.
