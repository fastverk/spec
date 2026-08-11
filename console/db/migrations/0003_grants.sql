-- Three roles, because the web tier must not be able to erase the log.
--
-- The triggers in 0002 refuse UPDATE and DELETE, but a role that can
-- `ALTER TABLE ... DISABLE TRIGGER` can undo that. So the console never connects
-- as a role that could.

CREATE ROLE spec_owner  NOLOGIN;   -- owns the schema; migrations only, held by CI
CREATE ROLE spec_app    LOGIN;     -- Vercel connects as this: INSERT + SELECT
CREATE ROLE spec_export LOGIN;     -- the promotion workflow: SELECT only

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
