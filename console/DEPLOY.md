# Deploying the console

Vercel for the app, Neon for the two append-only logs, Google OAuth for identity
restricted to one Workspace domain.

There are three accounts to touch and one command to run. Nothing here needs the
grounding adapter, which stays deferred — the Grounding pane says so.

---

## 1. Neon — the logs

Create a project in the Neon console (free tier is fine; pick a region near your
users). Take the connection string it gives you — that is the **owner** role, and
it is for migrations only.

### Preferred: let CI do it

Migrations need the **owner** credential — the one role that can
`ALTER TABLE ... DISABLE TRIGGER` and delete. It should live in exactly one
place, behind a reviewer, and never on a laptop or in the web tier.

1. GitHub → Settings → **Environments** → new environment named
   `database-production`, and add yourself as a **required reviewer**. Without
   that the workflow runs unattended with the most powerful credential in the
   system.

   ⚠ Named for the stage rather than the vendor on purpose. Preview deployments
   get their own Neon branch, so `neon` would name both and tell a reviewer
   nothing about which log they are approving DDL against.
2. Add these secrets to that environment:
   - `NEON_OWNER_URL` — the connection string Neon gave you
   - `SPEC_APP_PASSWORD` — `openssl rand -base64 24` (optional; only used when
     you tick the box below)
3. Actions → **migrate** → Run workflow. Tick *"Also set spec_app's password"*
   on the first run.

It applies the migrations, optionally issues the app credential, and then
**re-proves that the door refuses** — every trigger, grant and CHECK exercised
against the live database, inside a transaction that is rolled back so
verification writes nothing into an append-only log.

It also runs automatically on any push to `main` that touches
`console/db/migrations/**`.

### Or by hand

```sh
cd console && pnpm install
DATABASE_URL='<neon OWNER url>' node db/migrate.mjs
node db/verify.mjs          # same proof, same rollback
```

Expected output:

```
  + 0001_schema.sql
  + 0002_append_only.sql
  + 0003_grants.sql

applied 3 migration(s)
```

That creates the two tables, the append-only triggers, three roles, and the
grants. Run it twice and it says `nothing to apply — the schema is current`. If
you edit a migration after it has been applied it refuses, with both hashes,
rather than silently leaving you with a different database than the file
describes.

### ⛔ Create the app role with SQL, NOT in the Neon console

This is the one Neon-specific trap, and it is load-bearing:

> A role created in the **Neon console** is granted `neon_superuser`.
> A role created with **SQL** is not.

A `neon_superuser` member can reach table ownership, and an owner can
`ALTER TABLE ... DISABLE TRIGGER` and then delete. So creating `spec_app` in the
console would hand the web tier exactly the power the append-only triggers exist
to deny it — and everything would appear to work, which is the problem.

The migration already created `spec_app` and `spec_export` with SQL. They exist
with no password, so neither can connect yet — the safe state. Give the app role
a password either through the workflow above (`SPEC_APP_PASSWORD`, which keeps it
out of your clipboard and your shell history) or by hand:

```sql
ALTER ROLE spec_app WITH PASSWORD '<generate one>';
```

Then build its URL by hand — these roles do not appear in the Neon console's
connection-string builder, which is the cost of not being `neon_superuser`:

```
postgres://spec_app:<password>@<your-neon-host>/<db>?sslmode=require
```

Take the host and database name from the owner URL; swap in the role and
password. **That** is what Vercel gets.

⛔ **Never give Vercel the owner URL.** The owner can disable the triggers and
delete. The web tier must not be able to erase an append-only log.

⚠ **Enable the Neon–Vercel integration so preview deployments get their own
branch.** This matters more here than usual: the log is unpurgeable by design, so
a preview writing to production leaves a permanent record nobody can remove.

### Checking it took

Verified against Neon (PostgreSQL 17.10), not just locally:

```sql
-- what exists, and who owns it
SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'spec';
--  proposal_log    | spec_owner
--  evaluation_log  | spec_owner

-- prove the log refuses to forget, as the app role
DELETE FROM spec.proposal_log;
-- ERROR: permission denied for table proposal_log
```

⚠ **Do not test the door against a database you intend to keep.** The log is
append-only by design, so verification writes cannot be removed — the only reset
is to drop the schema and re-apply. Use a Neon branch, or do it before the first
real proposal.

⚠ `seq` is **ordered, not contiguous**. A refused insert still consumes a
sequence value, so a rejected vacuous pass leaves a gap. A gap is evidence the
door did its job, never evidence a record was removed.

---

## 2. Google Cloud — identity

**APIs & Services → OAuth consent screen**
- User type: **Internal** (this is the real domain restriction — external would
  let any Google account reach the consent screen).
- App name: `spec console`. Scopes: just `openid`, `email`, `profile`.

**APIs & Services → Credentials → Create credentials → OAuth client ID**
- Type: **Web application**
- Authorized redirect URIs — add both:

```
https://<your-vercel-domain>/api/auth/callback
http://localhost:5175/api/auth/callback          # only if you want local sign-in
```

⚠ The redirect URI must match `GOOGLE_REDIRECT_URI` **exactly** — scheme, host,
port, path, no trailing slash. A mismatch fails at Google with
`redirect_uri_mismatch` before it ever reaches the console.

Copy the client ID and secret.

---

## 3. Vercel — the app

Import the repository. Because the console is a subdirectory that imports the
read model from above it:

- **Root Directory**: `console`
- ⛔ **Uncheck "Include files outside the root directory"?** No — leave it
  INCLUDED. `lib/corpus.ts` imports `../../services/spec/readmodel/*.json`, and
  without those files the build fails at `frozenReadPoint()` rather than serving
  a corpus it does not have.
- Framework preset: Next.js (detected). Build and install commands come from
  `vercel.json`.

### Environment variables

Set these for **Production** and **Preview**:

| variable | value |
|---|---|
| `DATABASE_URL` | the Neon **`spec_app`** URL (not the owner) |
| `GOOGLE_CLIENT_ID` | from step 2 |
| `GOOGLE_CLIENT_SECRET` | from step 2 |
| `GOOGLE_REDIRECT_URI` | `https://<your-domain>/api/auth/callback` |
| `GOOGLE_ALLOWED_DOMAIN` | `savvifi.com` |
| `SESSION_SECRET` | `openssl rand -hex 32` |

Optional:

| variable | effect |
|---|---|
| `GROUNDING_ADAPTER_URL` | the project's adapter. Unset ⇒ Grounding says no adapter is answering |
| `SPEC_KERNEL_SUBS` | CSV of `google:<id>` subs holding kernel capability. Empty means nobody |
| `SPEC_MACHINE_TOKEN_SECRET` | `openssl rand -hex 32`, **different from `SESSION_SECRET`**. Lets a consumer's CI post counts under a machine credential — "Machine credentials" below. Unset ⇒ every bearer token is refused |
| `SPEC_MACHINE_TOKEN_REVOKED` | CSV of `jti`s to refuse. Revokes one machine token by name without rotating the secret |

⚠ **`GOOGLE_REDIRECT_URI` is per-environment.** A preview deployment has a
different hostname, so either add its URL to the Google client too, or accept
that sign-in only works on the production domain. Do not set it to a wildcard;
Google does not accept one, and neither should you.

⛔ **Never set `SPEC_AUTHOR` on Vercel.** It is the local dev shim. The code
already refuses it when `NODE_ENV=production` or when a real provider is
configured, but it should not be there to be refused.

Deploy.

---

### Machine credentials

A consumer project's CI has no session cookie. It posts counts under a
**machine credential** instead — a token accepted only by `POST /api/evaluation`,
naming the implementation it was issued for, and useless for anything else
(RFC-004a §4). Each is an HS256 JWT signed with `SPEC_MACHINE_TOKEN_SECRET`.

**Mint one** on a laptop, with the secret pulled from the deployment — never from
a route, because a route that mints is a route that can be asked to:

```sh
cd console
vercel env pull .env.production.local --environment production     # or paste the secret
SPEC_MACHINE_TOKEN_SECRET="$(grep '^SPEC_MACHINE_TOKEN_SECRET=' .env.production.local | cut -d= -f2- | tr -d '"')" \
  node tools/mint-machine-token.mjs --implementation studio-nextjs --days 90
# stderr: {"sub":"machine:studio-nextjs","jti":"…","exp":…,"expires":"…"}   ← RECORD THE jti
# stdout: the token                                                          ← the consumer's secret
```

Hand the token to the consumer out of band. On GitLab, a masked + protected
CI/CD variable `SPEC_EVALUATION_TOKEN`; on GitHub, a repository secret. Keep
the `jti` beside the implementation name somewhere you will find it again. The
consumer's side is `tools/evaluation/README.md`.

**Revoke one** — add its `jti` to `SPEC_MACHINE_TOKEN_REVOKED` (CSV), redeploy.
Every other consumer's token keeps working.

**Rotate the secret** — change `SPEC_MACHINE_TOKEN_SECRET`, redeploy, re-mint
for every consumer, redistribute. Every outstanding token dies at once; with
one consumer that is a two-minute window, and it is the honest price of a
symmetric secret.

**Prove it**, once, against production — with the consumer's real count, not a
placeholder, because the log is permanent:

```sh
curl -sS -X POST https://<your-domain>/api/evaluation \
  -H "authorization: Bearer $SPEC_EVALUATION_TOKEN" -H 'content-type: application/json' \
  -d '{"claim":"auth-24","implementation":"studio-nextjs","outcome":"Examined","population":1412,"project":"studio","query_fingerprint":"sha256:b05e76b22a0cc44b"}'
# 202 {"recorded":true,…,"author":"machine:studio-nextjs"}

curl -sS -X POST https://<your-domain>/api/proposal/op \
  -H "authorization: Bearer $SPEC_EVALUATION_TOKEN" -H 'content-type: application/json' \
  -d '{"parent":"corpus:x","op":"assertNS","subject":"x","text":"x","discipline":"x","rung":"R0"}'
# 401 E_NO_PRINCIPAL — at the op door the credential is not a principal at all

curl -sS https://<your-domain>/api/health | grep -o '"machine_credentials":{[^}]*}'
# {"configured":true,"revoked":0}
```

and, with the SELECT-only credential:

```sql
SELECT seq, written_at, claim, implementation, outcome, population, query_fingerprint, author
  FROM spec.evaluation_log WHERE author LIKE 'machine:%' ORDER BY seq DESC LIMIT 5;
SELECT count(*) FROM spec.proposal_log WHERE author LIKE 'machine:%';   -- 0, always
```

⛔ **Never reuse `SESSION_SECRET`.** The code treats an equal value as
unconfigured and refuses every bearer token, because a session secret that can
mint a machine token collapses the boundary between a person who may author and
a machine that may only report.

## 4. Check it

```sh
curl https://<your-domain>/api/health
```

`/api/health` is deliberately open — an operator must be able to ask what a
deployment is serving without holding an account. You should see:

```json
{
  "corpus_version": "corpus:0e06b2f9fd1047a1",
  "rows": { "requirements": 133, "terms": 107, ... },
  "log_backend": "neon",
  "write_enabled": true,
  "principal": "absent",
  "grounding_adapter": "unset"
}
```

`log_backend: "neon"` is the one to read. If it says `"none"`, `DATABASE_URL` did
not reach the deployment and the console is read-only — it will say so in every
pane rather than letting the buttons appear to work.

Then open the site. You should be redirected to `/signin`, sign in with a
`savvifi.com` account, and land on Overview.

### What to try

1. **Overview** — 69 requirements for Studio, 60 terms, 0 pinned down.
2. **Requirements** → search `auth-24` → open it. Two terms, neither pinned down.
3. Record the finding the console exists for:

```sh
curl -X POST https://<your-domain>/api/evaluation \
  -H 'content-type: application/json' -b 'spec_session=<your cookie>' \
  -d '{"claim":"auth-24","implementation":"studio-nextjs","outcome":"Passes","population":0}'
# 422 — examined 0 records but reports Passes. An invariant that examined nothing
#       succeeds trivially; record it as Vacuous, which is what it is
```

Change `Passes` to `Vacuous` and it is accepted. Reload AUTH-24 and it reads
**Examines nothing**.

4. **Grounding** → pick `deploy:*` → record a reading. It goes pending under your
   name, against the read point in the sidebar.
5. **Proposals** → your decision, waiting to be adopted.

---

## 5. Promotion

The console never edits the corpus. To adopt what is waiting, export with the
SELECT-only credential and run the existing tools:

```sh
psql "$NEON_EXPORT_URL" -X -A -t -q --no-psqlrc -v ON_ERROR_STOP=1 \
  -c "SELECT line FROM spec.proposal_log ORDER BY seq"   > logs/proposals.jsonl
psql "$NEON_EXPORT_URL" -X -A -t -q --no-psqlrc -v ON_ERROR_STOP=1 \
  -c "SELECT line FROM spec.evaluation_log ORDER BY seq" > logs/evaluations.jsonl

python3 tools/proposals/materialize.py \
    --log logs/proposals.jsonl --evaluations logs/evaluations.jsonl \
    --corpus corpus/studio --project studio
python3 tools/readmodel/emit_readmodel.py
bazel test //corpus/... //rdf/... //conformance/...
```

The diff that produces — appended log lines, regenerated `proposals.ttl`,
regenerated payloads, a new `corpus_version` — is the reviewable step between
"someone clicked a button" and "the specification changed". Merging it and
redeploying is what advances the read point the console serves.

Commit `logs/*.jsonl` alongside the regenerated TTL and payloads.
`//corpus/studio:proposals_ttl_matches_the_log` re-materializes from the
committed log and fails if the TTL does not match, so the two cannot drift apart
— and a promotion that forgets the log is caught rather than merged.

⚠ The export itself is not automated yet: the psql above is run by hand. See
RFC-003 §8 for the workflow that should run it.

---

## The container alternative

`console/Dockerfile` builds the same app for Cloud Run or anything else that runs
a container. Build context is the **repo root**, not `console/`:

```sh
docker build -f console/Dockerfile -t spec-console .
```

Everything above applies unchanged except the hosting step; `PORT` is injected by
the platform.
