-- Append-only, enforced by the database rather than by convention.
--
-- ② A proposal is not the corpus. The log keeps everything forever — that is the
-- property the whole overlay rests on, because `pending` means "differs from the
-- corpus", never "is in the log". A record that could be edited or removed would
-- make adoption unanswerable: you could no longer tell "this was decided and
-- promoted" from "this was decided, promoted, and then quietly unwritten".
--
-- Correction is another record. Later wins.

CREATE OR REPLACE FUNCTION spec.refuse_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'the log is append-only: % on %.% is refused',
        TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = '0A000',
            HINT = 'the record stays. Correct it with another record — later wins. '
                   'pending means "differs from the corpus", never "is in the log".';
END $$;

-- ⛔ A TRIGGER THAT RAISES, NEVER A RULE THAT SWALLOWS.
--
-- `CREATE RULE ... DO INSTEAD NOTHING` is the usual recipe and it is the
-- dishonest one: the UPDATE *succeeds*, affecting zero rows, and the caller
-- believes it worked. That is the same family of error as reporting a pass over
-- an empty population — an operation that examined nothing, reported success.
-- A raised exception is the honest refusal.
--
-- ⚠ FOR EACH STATEMENT, not FOR EACH ROW. A statement-level BEFORE trigger fires
-- even when zero rows match, so `DELETE FROM spec.proposal_log WHERE false` is
-- refused too. The INTENT is refused, not merely the rows.
CREATE TRIGGER refuse_update   BEFORE UPDATE   ON spec.proposal_log
  FOR EACH STATEMENT EXECUTE FUNCTION spec.refuse_mutation();
CREATE TRIGGER refuse_delete   BEFORE DELETE   ON spec.proposal_log
  FOR EACH STATEMENT EXECUTE FUNCTION spec.refuse_mutation();
CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON spec.proposal_log
  FOR EACH STATEMENT EXECUTE FUNCTION spec.refuse_mutation();

CREATE TRIGGER refuse_update   BEFORE UPDATE   ON spec.evaluation_log
  FOR EACH STATEMENT EXECUTE FUNCTION spec.refuse_mutation();
CREATE TRIGGER refuse_delete   BEFORE DELETE   ON spec.evaluation_log
  FOR EACH STATEMENT EXECUTE FUNCTION spec.refuse_mutation();
CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON spec.evaluation_log
  FOR EACH STATEMENT EXECUTE FUNCTION spec.refuse_mutation();

-- The append primitives.
--
-- ⛔ The advisory lock is `ProposalLog::append`'s in-process Mutex
-- (proposal.rs:797), relocated to where the log now lives.
--
-- It matters more here than it did there. `GENERATED AS IDENTITY` allocates seq
-- BEFORE commit, so two serverless invocations can take 41 and 42 and commit in
-- the other order. A replay landing in between would see 42, and then 41 — the
-- EARLIER proposal — would arrive and win on the next replay. "Later wins" would
-- depend on who fsynced first, which is not a property of the judgement anybody
-- made. One lock, on a write path that runs at human rate.
CREATE OR REPLACE FUNCTION spec.append_proposal(
    p_line spec.log_line, p_parent text, p_author text,
    p_author_email text, p_surface text, p_canonical text)
RETURNS TABLE (seq bigint, written_at timestamptz)
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('spec.proposal_log'));
    RETURN QUERY
        INSERT INTO spec.proposal_log
            (line, parent, author, author_email, surface, canonical)
        VALUES (p_line, p_parent, p_author, p_author_email, p_surface, p_canonical)
        RETURNING spec.proposal_log.seq, spec.proposal_log.written_at;
END $$;

CREATE OR REPLACE FUNCTION spec.append_evaluation(
    p_line spec.log_line, p_claim text, p_project text, p_implementation text,
    p_outcome text, p_population bigint, p_query_fingerprint text,
    p_author text, p_detail text)
RETURNS TABLE (seq bigint, written_at timestamptz)
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('spec.evaluation_log'));
    RETURN QUERY
        INSERT INTO spec.evaluation_log
            (line, claim, project, implementation, outcome, population,
             query_fingerprint, author, detail)
        VALUES (p_line, p_claim, p_project, p_implementation, p_outcome, p_population,
                p_query_fingerprint, p_author, p_detail)
        RETURNING spec.evaluation_log.seq, spec.evaluation_log.written_at;
END $$;
