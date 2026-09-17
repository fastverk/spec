# Posting a measurement from a consumer's CI

The consumer's half of RFC-004a. A project runs one `SELECT count(*)` where its
database is reachable and posts the number to the spec console under a
**machine credential**. Nothing of spec's model moves into the project: no
proto, no ontology, no term ids. One file, one POST.

```
project CI  ──POST /api/evaluation──▶  console  ──▶  spec.evaluation_log
  one SQL count   Bearer <machine token>             author: machine:<implementation>
```

## What crosses the wire, and what never does

| sent | never sent |
|---|---|
| `claim`, `implementation`, `project` | the SQL |
| the **count** (`population`) | any row the SQL selected |
| `query_fingerprint` — `sha256:` + the first 16 hex of the SHA-256 of the query text | the database URL, the credentials |
| `outcome`: `Examined` (count > 0), `Vacuous` (count = 0), or `CannotBeGrounded` (the check could not run) | `Passes` / `Fails` — a count is a measurement, and a pass is a judgment a `SELECT count(*)` did not make |

`post_evaluation.mjs` is incapable of producing `Passes` or `Fails`, and the
console refuses either from a machine credential anyway (422). It also refuses
a count reported for an implementation other than the one the credential was
issued for (403), `Examined` over zero records (422 — say `Vacuous`), and any
credential it did not issue (401). A refusal appends nothing.

## The credential

One token per implementation, minted by the console's operator
(`console/tools/mint-machine-token.mjs`, see `console/DEPLOY.md` → "Machine
credentials"), handed over out of band, and held in the project's CI as a
masked secret. It is accepted **only** by `POST /api/evaluation` — replayed
against `/api/proposal/op` it is a 401. It expires (90 days by default), and it
can be revoked by name without disturbing any other consumer.

## Try it without sending anything

```sh
node tools/evaluation/post_evaluation.mjs --dry-run \
  --claim auth-24 --implementation studio-nextjs --project studio \
  --population 1412 --sql "SELECT count(*) FROM team_memberships WHERE role = 'deployer'"
```

prints exactly the body that would be posted, and reads no token.

## GitHub Actions

```yaml
jobs:
  spec-population:
    runs-on: ubuntu-latest
    env:
      SPEC_CONSOLE_URL: ${{ vars.SPEC_CONSOLE_URL }}
      SPEC_EVALUATION_TOKEN: ${{ secrets.SPEC_EVALUATION_TOKEN }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      # The SQL is yours, run with your credentials, against your database.
      # Only the number leaves.
      - name: count
        run: echo "POP=$(psql "$DATABASE_URL" -X -A -t -c "$(cat checks/auth-24.sql)")" >> "$GITHUB_ENV"
        env: { DATABASE_URL: ${{ secrets.DATABASE_URL }} }
      - name: post
        run: |
          node tools/post_evaluation.mjs --claim auth-24 --implementation studio-nextjs \
            --project studio --population "$POP" --sql-file checks/auth-24.sql
```

## GitLab CI

```yaml
spec-population:
  image: node:22
  # Masked + protected CI/CD variables: SPEC_CONSOLE_URL, SPEC_EVALUATION_TOKEN, DATABASE_URL
  script:
    - apt-get update -qq && apt-get install -y -qq postgresql-client
    - POP=$(psql "$DATABASE_URL" -X -A -t -c "$(cat checks/auth-24.sql)")
    - node tools/post_evaluation.mjs --claim auth-24 --implementation studio-nextjs
        --project studio --population "$POP" --sql-file checks/auth-24.sql
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
```

Run it on a schedule and the count becomes a tripwire: a number that changes is
drift, and the log keeps every record, so the series is there to read.

## The refusals the job will meet

| | |
|---|---|
| `401 E_MACHINE_TOKEN_REJECTED` | not a token this console issued, expired, or revoked |
| `401 E_MACHINE_TOKENS_UNCONFIGURED` | the console has no `SPEC_MACHINE_TOKEN_SECRET` — an operator problem, not yours |
| `403 E_IMPLEMENTATION_MISMATCH` | the body's `implementation` is not the one the credential names |
| `422 E_VACUOUS_OR_MALFORMED` | `Examined` over zero (say `Vacuous`), a missing count, or a judgment from a machine |
| `503 E_WRITE_DISABLED` | the console is read-only; nothing can be appended |

Every one appends nothing. The script exits 1 on any of them and prints the body
the console returned.

## Tests

```sh
node --test tools/evaluation/post_evaluation.test.mjs
```
