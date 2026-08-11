# Deploying the console

Vercel for the app, Neon for the two append-only logs, Google OAuth for identity
restricted to one Workspace domain.

There are three accounts to touch and one command to run. Nothing here needs the
grounding adapter, which stays deferred — the Grounding pane says so.

---

## 1. Neon — the logs

Create a project (free tier is fine; pick a region near your users).

Neon gives you a connection string for the **owner** role. That one is for
migrations only. Keep it out of Vercel.

```sh
cd console
DATABASE_URL='<neon OWNER url>' node db/migrate.mjs
```

That applies three migrations: the two tables, the append-only triggers, and the
role grants. It is idempotent, and it refuses to re-run a migration whose
contents changed since it was applied.

Then take the **`spec_app`** credential — `INSERT` and `SELECT` only — and use
that as the app's `DATABASE_URL`. In the Neon console: Roles → `spec_app` → set a
password, then build the URL with that role.

⛔ **Do not give Vercel the owner URL.** The owner is exactly the role that can
`ALTER TABLE ... DISABLE TRIGGER` and delete. Putting it in the web tier hands
the web tier the power to erase an append-only log — which is the one thing the
whole design is arranged to prevent.

⚠ **Enable the Neon–Vercel integration so preview deployments get their own
branch.** This matters more here than usual: the log is unpurgeable by design, so
a preview writing to production leaves a permanent record nobody can remove.

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

⚠ **`GOOGLE_REDIRECT_URI` is per-environment.** A preview deployment has a
different hostname, so either add its URL to the Google client too, or accept
that sign-in only works on the production domain. Do not set it to a wildcard;
Google does not accept one, and neither should you.

⛔ **Never set `SPEC_AUTHOR` on Vercel.** It is the local dev shim. The code
already refuses it when `NODE_ENV=production` or when a real provider is
configured, but it should not be there to be refused.

Deploy.

---

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

⚠ Not yet automated, and `logs/*.jsonl` is not yet committed. Until it is,
nothing checks that `corpus/studio/proposals.ttl` corresponds to any log — a
hand-edited one passes every gate in the repo. See RFC-003 §8.

---

## The container alternative

`console/Dockerfile` builds the same app for Cloud Run or anything else that runs
a container. Build context is the **repo root**, not `console/`:

```sh
docker build -f console/Dockerfile -t spec-console .
```

Everything above applies unchanged except the hosting step; `PORT` is injected by
the platform.
