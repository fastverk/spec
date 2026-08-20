-- The door: a proposal gets a name, and the decision that let it in is recorded.
--
-- Until this migration a proposal had no identity. The console answered
-- `"address": null` with `address_computed_by: "the door, in the build"` beside
-- it, and there was no door in the build — so RFC-002 §5's `Proposal.id` did not
-- exist anywhere, `spec replay <id>` (§12 P1) had nothing to take, and §9.1's
-- equal-citizen gate ("a click and a chat that author the same change produce
-- the same id") was unfalsifiable rather than merely unproven.
--
-- Two columns, both derived from the line, both unable to lie about it.
--
--   address   sha256:<64 hex> over canonicalJson({author, ops, parent}).
--             ⛔ THREE FIELDS. `surface` and `intent` are stored in `canonical`
--             and deliberately excluded from the pre-image: RFC-002 §4.1 has the
--             door take `{parents, ops}` and NOT provenance, so the same change
--             from two surfaces is one proposal with two provenance records.
--             Hashing the stored line would give them different names and
--             quietly invert §9.1.
--   verdict   au:Verdict — what the door decided about the proposal as a whole.
--             Admitted (every op well-formed and in capability) or Queued (some
--             op out of capability; partial admission is normal, §5). Never
--             Rejected: a rejected proposal is not appended at all, so the value
--             cannot occur here — and `console/lib/overlay.ts` and
--             `tools/proposals/materialize.py` both refuse to replay a record
--             that carries it, because a decision nothing downstream honours is
--             decoration.
--
-- ⚠ WHAT THIS VERDICT IS NOT. It is not the gate set. RFC-002 §7.1 counts "every
-- named gate returns zero rows after application" as part of admission, and that
-- is a GROUP BY … HAVING over the post-admission graph — Jena, the whole corpus,
-- the ontology. None of that exists in a serverless function. The gate verdict
-- is the BUILD's, on the promotion PR, where //corpus/... and //rdf/... already
-- run. Two verdicts, neither reported as the other.
--
-- ⚠ NULLABLE, and only for one reason: rows written before this migration have
-- no address and no verdict. They are still nameable — the address is
-- recomputable from `canonical`, which is what tools/proposals/replay.py does —
-- but inventing one here would be writing a derived value as though it had been
-- decided at the time. The paired CHECK below makes "pre-door" a whole state
-- rather than a per-column accident.

ALTER TABLE spec.proposal_log ADD COLUMN address text;
ALTER TABLE spec.proposal_log ADD COLUMN verdict text;

-- The shape, lower-case hex, exactly 64 of them. Mirrors ADDRESS_PATTERN in
-- console/lib/address.ts. `~` is case-sensitive: an upper-case digest is a
-- DIFFERENT string that names the same bytes, and two spellings of one address
-- is the whole reason to pin the spelling.
ALTER TABLE spec.proposal_log ADD CONSTRAINT address_is_a_content_address
    CHECK (address IS NULL OR address ~ '^sha256:[0-9a-f]{64}$');

ALTER TABLE spec.proposal_log ADD CONSTRAINT verdict_is_an_au_verdict
    CHECK (verdict IS NULL OR verdict IN ('Admitted', 'Queued'));

-- Half a door is not a door. Either the record was written by one and carries
-- both, or it predates one and carries neither.
ALTER TABLE spec.proposal_log ADD CONSTRAINT the_door_wrote_both_or_neither
    CHECK ((address IS NULL) = (verdict IS NULL));

-- The same arrangement as decomposition_matches_the_line (0001): the columns are
-- for querying, the line is the record, and a CHECK makes the columns unable to
-- disagree with it. `->>` on a missing key is NULL, so IS NOT DISTINCT FROM is
-- what makes a pre-door row pass rather than an OR chain that would also pass a
-- row whose line said something else.
ALTER TABLE spec.proposal_log ADD CONSTRAINT door_decision_matches_the_line
    CHECK (
        line::jsonb->>'address' IS NOT DISTINCT FROM address AND
        line::jsonb->>'verdict' IS NOT DISTINCT FROM verdict
    );

-- ⚠ NOT UNIQUE, and that is the design.
--
-- Two identical proposals from the same author against the same read point have
-- the same address BY CONSTRUCTION — that is what content-addressing means — and
-- both belong in the log. A unique index would turn "I clicked twice" into a
-- 500, and worse, would turn the second author's independent agreement into an
-- error. Deduplication is a READ-side question (later wins), and 0001 already
-- refuses to make `line` unique for the same reason.
CREATE INDEX proposal_log_address ON spec.proposal_log (address);

-- ── the append primitive, with the door's two outputs ────────────────────────
--
-- CREATE first, DROP second: a different argument list is a different function,
-- so the two coexist for the length of this migration and never for longer. One
-- overload is the invariant — two would let a caller append a record with no
-- address by picking the older signature, which is exactly the hole this closes.
CREATE OR REPLACE FUNCTION spec.append_proposal(
    p_line spec.log_line, p_parent text, p_author text,
    p_author_email text, p_surface text, p_canonical text,
    p_address text, p_verdict text)
RETURNS TABLE (seq bigint, written_at timestamptz)
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
    -- Refused here as well as by the CHECKs, because the CHECK permits NULL for
    -- the pre-door rows and this path is never one of them. A door that can be
    -- called without deciding anything is not a door.
    IF p_address IS NULL OR p_verdict IS NULL THEN
        RAISE EXCEPTION 'the door decides: append_proposal needs an address and a verdict'
          USING ERRCODE = '22004',
                HINT = 'compute them with console/lib/address.ts; NULL is reserved for '
                       'records written before migration 0004 and cannot be created now.';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('spec.proposal_log'));
    RETURN QUERY
        INSERT INTO spec.proposal_log
            (line, parent, author, author_email, surface, canonical, address, verdict)
        VALUES (p_line, p_parent, p_author, p_author_email, p_surface, p_canonical,
                p_address, p_verdict)
        RETURNING spec.proposal_log.seq, spec.proposal_log.written_at;
END $$;

DROP FUNCTION spec.append_proposal(spec.log_line, text, text, text, text, text);

-- DROP took the grant with it.
GRANT EXECUTE ON FUNCTION
    spec.append_proposal(spec.log_line, text, text, text, text, text, text, text) TO spec_app;

-- ── a machine reports, never judges — now in the schema too ──────────────────
--
-- RFC-004a §4. `console/lib/evaluation.ts`, `services/spec/src/evaluation.rs` and
-- `conformance/check_conformance.py` all refuse a `Passes` or a `Fails` from a
-- `machine:` author; #48 landed that and filed the database half as a follow-up
-- because it needed a migration. This is it.
--
-- It is not redundant with the door. It is the same refusal at the one layer a
-- hand-written INSERT cannot route around — the layer that also holds ③ (zero is
-- an exception, never a pass), and for the same reason: an append-only log keeps
-- a bad row forever, so the last place to catch one is the place it lands.
--
-- ⚠ `NOT LIKE` with no ESCAPE clause: the pattern is a literal prefix and a
-- wildcard, and `machine:` contains no `%` or `_` to be confused about.
ALTER TABLE spec.evaluation_log ADD CONSTRAINT a_machine_reports_never_judges
    CHECK (author NOT LIKE 'machine:%' OR outcome NOT IN ('Passes', 'Fails'));
