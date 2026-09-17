-- Three roles, because the web tier must not be able to erase the log.
--
-- The triggers in 0002 refuse UPDATE and DELETE, but a role that can
-- `ALTER TABLE ... DISABLE TRIGGER` can undo that. So the console never connects
-- as a role that could.

-- ⚠ ON NEON, CREATE THESE WITH SQL — never in the Neon console.
--
-- A role created in the Neon console is granted `neon_superuser`. A role created
-- with SQL is not. That difference is the whole privilege separation here: a
-- `neon_superuser` member can reach table ownership, and an owner can
-- `ALTER TABLE ... DISABLE TRIGGER` and then delete. Creating the app role in the
-- console would hand the web tier exactly the power 0002 exists to deny it.
--
-- The cost is that these roles do not appear in the Neon console's UI and you
-- build their connection strings by hand. That is the correct trade.
--
-- Idempotent, because a migration that half-applied and then refuses to be
-- retried is a worse failure than one that can be run twice.
DO $$ BEGIN
    -- owns the schema; migrations only, held by CI or a laptop
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'spec_owner') THEN
        CREATE ROLE spec_owner NOLOGIN;
    END IF;
    -- the app connects as this: INSERT + SELECT, nothing else
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'spec_app') THEN
        CREATE ROLE spec_app LOGIN;
    END IF;
    -- the promotion workflow: SELECT only
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'spec_export') THEN
        CREATE ROLE spec_export LOGIN;
    END IF;
END $$;

-- ⛔ NO PASSWORDS HERE, deliberately. A credential in a migration is a credential
-- in git, in the ledger's sha256, and in every clone. Set them once, separately:
--
--     ALTER ROLE spec_app    WITH PASSWORD '...';
--     ALTER ROLE spec_export WITH PASSWORD '...';
--
-- Until then both roles exist and neither can connect, which is the safe state.

-- ⚠ PostgreSQL 16+ requires membership in a role WITH SET to hand it ownership,
-- and ADMIN alone is not enough.
--
-- A CREATEROLE role is auto-granted ADMIN on roles it creates, which is why this
-- looks unnecessary and is not: on Neon, `neondb_owner` creates `spec_owner`
-- three lines up and then cannot give it anything —
--
--     ERROR: must be able to SET ROLE "spec_owner"   (42501)
--
-- Measured against Neon (PostgreSQL 17.10), not inferred. It does not reproduce
-- as a local superuser, which is exactly the shape of bug that reaches a
-- deployment: the environment that finds it is the one you cannot test in.
DO $$ BEGIN
    EXECUTE format('GRANT spec_owner TO %I WITH SET TRUE', current_user);
END $$;

ALTER SCHEMA spec                OWNER TO spec_owner;
ALTER TABLE  spec.proposal_log   OWNER TO spec_owner;
ALTER TABLE  spec.evaluation_log OWNER TO spec_owner;

REVOKE ALL ON SCHEMA spec              FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA spec FROM PUBLIC;

GRANT USAGE ON SCHEMA spec TO spec_app, spec_export;

-- ⛔ INSERT and SELECT. Never UPDATE, never DELETE, never TRUNCATE.
--
-- ⚠ TRUNCATE is a SEPARATE privilege and is NOT implied by DELETE. Revoking
-- DELETE and leaving TRUNCATE reachable is the classic mistake here, and it is
-- the one that empties the whole log in a single statement. It is simply never
-- granted below — along with REFERENCES, which would let a foreign key make a
-- record undeletable-but-also-unwritable.
GRANT INSERT, SELECT ON spec.proposal_log, spec.evaluation_log TO spec_app;
GRANT SELECT          ON spec.proposal_log, spec.evaluation_log TO spec_export;

GRANT EXECUTE ON FUNCTION
    spec.append_proposal(spec.log_line, text, text, text, text, text) TO spec_app;
GRANT EXECUTE ON FUNCTION
    spec.append_evaluation(spec.log_line, text, text, text, text, bigint, text, text, text)
    TO spec_app;

-- ⚠ THE RESIDUAL HOLE, STATED PLAINLY.
--
-- Whoever holds spec_owner — or Neon's neon_superuser — can disable the triggers
-- and delete. No arrangement inside Postgres closes that; a database cannot
-- defend against its own owner.
--
-- It is closed OUTSIDE Postgres, by committing the exported JSONL snapshot to
-- git (see console/db/README.md and the promotion workflow). A row can vanish
-- from a table without trace; a line cannot vanish from a reviewed diff. That
-- committed snapshot is the second copy, and it is why the export is part of the
-- design rather than a convenience.
