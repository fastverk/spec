-- The two append-only logs, as tables.
--
-- On disk these were JSONL files appended under an in-process Mutex
-- (services/spec/src/proposal.rs:750-811). Serverless has no filesystem to
-- append to and no single process to hold the lock, so they move here — but the
-- shape does not change, because `tools/proposals/materialize.py` still reads
-- JSONL and promotion is what puts a judgement in front of the gates.
--
-- ⛔ TWO LOGS, NOT ONE. A proposal is a person's JUDGEMENT — what a word means,
-- what a requirement should say. An evaluation is a MEASUREMENT: a project ran a
-- query in its own environment and reported a count. Nobody is asked to agree
-- with a measurement. Replaying both from one table would make "who decided
-- this" and "what did it measure" the same question.

CREATE SCHEMA IF NOT EXISTS spec;

-- One character class, because it is the same hazard in three places.
--
-- Python's str.splitlines() splits on all of these; JSON does not, and
-- serde_json emits U+2028/U+2029/U+0085 RAW inside a string rather than
-- escaping them. A proposal carrying a LINE SEPARATOR — pasting from a PDF is
-- the usual way — therefore became two fragments in materialize.py, neither of
-- which parsed, and both were skipped silently: the record stayed in the log,
-- never promoted, and read as "pending, not yet adopted" in the console forever.
--
-- That reader is fixed (it splits on \n now). This domain is the belt: a line
-- that cannot round-trip through a line-oriented file must not enter a log whose
-- whole purpose is to be exported to one.
--
-- ⚠ Spelled with escapes, never literal characters: these are invisible, so a
-- source line containing them literally is a line nobody can review.
CREATE DOMAIN spec.log_line AS text
  CONSTRAINT is_exactly_one_line
  CHECK (VALUE !~ E'[\n\r\u000B\u000C\u001C\u001D\u001E\u0085\u2028\u2029]');

CREATE TABLE spec.proposal_log (
    -- The handle handed back to the caller. Replaces the JSONL byte offset,
    -- which has no meaning in a table; inventing one would be a fabricated
    -- address, and a fabricated address is strictly worse than an absent one.
    --
    -- GENERATED ALWAYS AS IDENTITY, not serial: an identity column needs no
    -- USAGE grant on its sequence, and a role holding USAGE could call setval()
    -- and make a future seq collide with a past one.
    seq          bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    -- clock_timestamp(), not now(): now() is transaction start and would be
    -- identical for two rows written in one transaction, which is a lie about
    -- order. Ordering is seq's job regardless; this is for humans.
    written_at   timestamptz NOT NULL DEFAULT clock_timestamp(),

    -- THE LOG LINE, verbatim — byte-identical to what ProposalLog::append would
    -- have written. Export is then `SELECT line ... ORDER BY seq`, with no
    -- re-serialization step that could reorder keys.
    line         spec.log_line NOT NULL,

    -- Derived from the line, for querying. The CHECK makes them unable to lie.
    parent       text NOT NULL,
    author       text NOT NULL,
    author_email text NOT NULL,
    surface      text NOT NULL,
    -- ⛔ Opaque. `canonical` is the canonical JSON of the proposal body AS A
    -- STRING, and it is the pre-image of a content address. jsonb would sort
    -- keys by length-then-bytes rather than lexicographically, collapse
    -- duplicates, and normalize numbers through numeric — so re-emitting from
    -- jsonb yields DIFFERENT bytes for the same proposal. canonical_json exists
    -- (proposal.rs:700-703) precisely so key order cannot depend on a build
    -- detail; storing jsonb would reintroduce that hazard at the storage layer.
    canonical    text NOT NULL,

    CONSTRAINT decomposition_matches_the_line CHECK (
        line::jsonb->>'parent'       IS NOT DISTINCT FROM parent       AND
        line::jsonb->>'author'       IS NOT DISTINCT FROM author       AND
        line::jsonb->>'author_email' IS NOT DISTINCT FROM author_email AND
        line::jsonb->>'surface'      IS NOT DISTINCT FROM surface      AND
        line::jsonb->>'canonical'    IS NOT DISTINCT FROM canonical
    ),
    -- ⑤ Nothing is attributed to nobody. http.rs:420-428 refuses a write with no
    -- principal; this is the same refusal at the one layer a hand-written INSERT
    -- cannot route around.
    CONSTRAINT author_is_named CHECK (length(btrim(author)) > 0),
    -- Every write names the read point its author was looking at. There is no
    -- default: a proposal made against a corpus you were not seeing is a
    -- different proposal.
    CONSTRAINT parent_is_named CHECK (length(btrim(parent)) > 0),
    CONSTRAINT surface_is_known CHECK (surface IN ('Meridian', 'Chat', 'Ingest', 'Agent'))
);

CREATE TABLE spec.evaluation_log (
    seq          bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    written_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
    line         spec.log_line NOT NULL,

    claim             text   NOT NULL,
    project           text   NOT NULL DEFAULT '',
    implementation    text   NOT NULL,
    outcome           text   NOT NULL,
    -- NULL is meaningful and is NOT zero: NULL is "nothing ran", zero is "it ran
    -- and examined nothing". Collapsing them is how a requirement ends up
    -- looking guarded.
    population        bigint,
    query_fingerprint text   NOT NULL DEFAULT '',
    -- The email here, the sub in proposal_log. Deliberately different fields:
    -- overlay.rs:94-100 prefers author_email and falls back to author.
    author            text   NOT NULL,
    detail            text   NOT NULL DEFAULT '',

    CONSTRAINT decomposition_matches_the_line CHECK (
        line::jsonb->>'claim'          IS NOT DISTINCT FROM claim          AND
        line::jsonb->>'implementation' IS NOT DISTINCT FROM implementation AND
        line::jsonb->>'outcome'        IS NOT DISTINCT FROM outcome        AND
        line::jsonb->>'author'         IS NOT DISTINCT FROM author         AND
        (line::jsonb->'population' = 'null'::jsonb) IS NOT DISTINCT FROM (population IS NULL)
    ),
    CONSTRAINT claim_is_named          CHECK (length(btrim(claim)) > 0),
    -- The same claim can pass in one product and be ungroundable in another, and
    -- an unattributed count cannot tell you which.
    CONSTRAINT implementation_is_named CHECK (length(btrim(implementation)) > 0),
    CONSTRAINT author_is_named         CHECK (length(btrim(author)) > 0),
    -- The vocabulary is closed. There is deliberately no Unknown.
    CONSTRAINT outcome_is_an_au_outcome CHECK (
        outcome IN ('Passes', 'Fails', 'Examined', 'Vacuous', 'CannotBeGrounded')),
    CONSTRAINT population_is_not_negative CHECK (population IS NULL OR population >= 0),

    -- ⛔ ③ ZERO IS AN EXCEPTION, NEVER A PASS — the fourth independent refusal,
    -- and the only one that survives a hand-written INSERT.
    --
    -- The door refuses it (console/lib/evaluation.ts, services/spec/src/
    -- evaluation.rs:102-113). materialize.py drops it rather than promoting it.
    -- vacuous-invariant.rq fails the build for any TTL carrying it. All three are
    -- reachable only through a code path somebody chose to run. This one is the
    -- table itself.
    --
    -- `Examined` is in the refused set on purpose: its whole content is "there
    -- were records to look at", and over zero there were not. An Examined over
    -- zero is the same lie in a quieter voice.
    CONSTRAINT zero_is_an_exception_never_a_pass CHECK (
        outcome NOT IN ('Passes', 'Fails', 'Examined')
        OR (population IS NOT NULL AND population > 0))
);

-- ⚠ Deliberately NO unique constraint on `line`. Binding a term to the same
-- reading twice is a fact, not a duplicate, and "later wins" depends on the
-- second record existing. Debounce in the client; never in the schema.

CREATE INDEX proposal_log_parent    ON spec.proposal_log (parent);
CREATE INDEX evaluation_log_claim   ON spec.evaluation_log (claim, implementation);
