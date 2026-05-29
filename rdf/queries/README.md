# Aion RFC KG — Query Catalog

SPARQL queries against the loaded knowledge graph at `http://localhost:3030/rfcs/sparql`.

## Running

From the `kg/` directory:

```sh
# Run by file path
make q FILE=queries/stats/corpus-stats.rq

# Or directly
curl -fsS -G http://localhost:3030/rfcs/sparql \
  --data-urlencode "query@queries/stats/corpus-stats.rq" \
  -H 'Accept: text/csv'
```

## Categories

### `stats/` — high-level corpus counts

| File | Question |
|---|---|
| `corpus-stats.rq` | Documents, sections, normative rules, terms, diagnostics |
| `modality-breakdown.rq` | Count of MUST / SHOULD / MAY / etc. across the corpus |
| `severity-breakdown.rq` | Diagnostic codes by severity (Error / Warning / Fatal / ...) |

### `structure/` — document structure and dependency graph

| File | Question |
|---|---|
| `rules-per-rfc.rq` | Top RFCs by normative-rule density |
| `diagnostic-ranges.rq` | Which RFC owns which `MNN` range; how many codes are actually used |
| `dependency-graph.rq` | All cross-RFC edges (depends/extends/refines/closes/supersedes) |
| `dependency-roots.rq` | RFCs that nothing depends on (foundational specs) |
| `transitive-closure.rq` | All upstream RFCs of a target (parameterized by `rfcid:RFC-NNNN`) |

### `consistency/` — defect detectors

| File | Question |
|---|---|
| `diagnostic-collisions.rq` | Diagnostic codes claimed by multiple RFCs (real defects) |
| `dangling-references.rq` | Cross-references to non-existent RFCs |
| `circular-deps.rq` | Cycles in the dependsOn DAG (should always be empty) |
| `inverse-edges.rq` | Asymmetric `extendedBy` / `extends` edges |

### `domain/` — Phase 2 semantic content

| File | Question |
|---|---|
| `entity-by-type.rq` | Domain-entity inventory (declarations, fields, types, etc.) |
| `multi-rfc-entities.rq` | Entities defined or asserted by multiple RFCs |
| `declaration-kinds.rq` | All declaration kinds, by class |
| `modules.rq` | All modules and the PG schemas they own |
| `predicates.rq` | All graph predicates declared, with ltree paths |
| `capabilities.rq` | All capabilities and their scopes |

### `analysis/` — research-style queries

| File | Question |
|---|---|
| `must-rules-mentioning.rq` | All MUST rules mentioning a search term (parameterized) |
| `entity-impact.rq` | For an entity FQN: where it's defined, asserted, cited |

### `governance/` — decisions and invariants

| File | Question |
|---|---|
| `kp-decisions.rq` | All KP decisions referenced or closed |
| `invariants-by-rfc.rq` | Invariants per RFC with enforcement mode |

### `claims/` — Phase 3 prose-derived assertions (4,193 claims across 20 kinds)

**Inventory:**

| File | Question |
|---|---|
| `claims-by-kind.rq` | Distribution of claims across the 20 claim kinds |
| `predicate-vocabulary.rq` | Top claim predicates (the verb-phrase ontology that emerged from the corpus) |
| `claim-density.rq` | Top sections by claim count — load-bearing constraint hotspots |
| `section-claim-summary.rq` | Per-section breakdown of claim kinds (normative vs descriptive sections) |

**By kind:**

| File | Question |
|---|---|
| `enforcement-claims.rq` | What is enforced, where (sample) |
| `enforcement-by-phase.rq` | Phase distribution (compile-time / runtime / RLS / DB-trigger / ...) |
| `reservation-claims.rq` | What is reserved for whom (capabilities, access boundaries) |
| `exclusions.rq` | All MUST NOT / forbidden / incompatible assertions |
| `type-assignments.rq` | Every "X has type Y" claim across the corpus |
| `lifecycle-transitions.rq` | All Lifecycle claims — state machines embedded in the spec |

**Cross-cutting / consistency:**

| File | Question |
|---|---|
| `claims-about-entity.rq` | Everything the corpus says about a specific entity (parameterized) |
| `cross-rfc-claims.rq` | Entities cited by multiple RFCs (load-bearing concepts) |
| `contradictions.rq` | Explicit `:contradicts` links between claims (defect detector) |
| `implicit-conflicts.rq` | Same (subject, predicate) with divergent values across RFCs |
| `rule-supporting-claims.rq` | Phase-3 claims linked to specific Phase-1 normative rules |
| `orphan-claims.rq` | Claims whose subject FQN has no Phase-2 entity (QA / extractor health) |

## Conventions

- All queries start with the standard prefix block (or no prefixes when SPARQL defaults suffice).
- Queries are kept short and focused. Composite questions are split across multiple `.rq` files.
- Parameterized queries (e.g., `transitive-closure.rq`, `must-rules-mentioning.rq`) use `BIND(...)` clauses near the top — edit the bind to change the parameter.
- File names use kebab-case; categories are folders.

## Adding a query

1. Pick the closest category folder (or create a new one).
2. Name the file by the question it answers, in kebab-case.
3. Start with a comment line describing the question.
4. Use the prefix block from `_prefixes.rq`.
5. Add an entry to this README.
