import { useEffect, useMemo, useState } from "react";
import {
  Alert, Box, Button, Card, CardContent, Chip, Divider, List, ListItemButton,
  Stack, TextField, Typography,
} from "@mui/material";
import {
  NoReadingProposed, corpusVersion, probe, submitOp,
  type Candidate, type OpKind, type ProbeResult, type Requirement, type Term,
} from "../api";
import { MONO, SERIF } from "../theme";
import { inlineMarkup } from "../ui";

/**
 * The grounding conversation.
 *
 * A person is asked ONE question — which set of records did you mean — and is
 * shown POPULATIONS rather than a schema. Someone who has never seen the data
 * model can still say which set is the one they meant; nobody can pick a column.
 *
 * Three states have to stay distinct, and collapsing any pair is the bug this
 * whole screen exists to prevent:
 *
 *   n > 0        a real population; the check would examine these
 *   0            the reading resolves and matches NOTHING — an invariant
 *                grounded here reports PASS forever having examined nothing
 *   unavailable  the project cannot express this reading at all; the check
 *                could never run
 *
 * ## The queue is the corpus, not a list someone typed
 *
 * Every term here came from //tools/import/decompose.py reading the author's own
 * `code spans` and **emphasis**. This pane used to carry a two-entry hard-coded
 * map, which made it a demo of grounding rather than the grounding of anything.
 * Ordering is by how many claims depend on the term, because that IS the
 * priority: `sponsor:edit` blocks eleven claims and `book team` blocks one.
 */
function countLabel(c: Candidate): string {
  if (!c.available) return "—";
  return c.count === null ? "—" : c.count.toLocaleString();
}

function severity(c: Candidate): "ok" | "empty" | "absent" {
  if (!c.available) return "absent";
  return c.count === 0 ? "empty" : "ok";
}

function CandidateCard({
  c, onChoose, chosen, busy,
}: {
  c: Candidate;
  onChoose: () => void;
  chosen: boolean;
  busy: boolean;
}) {
  const s = severity(c);
  const border =
    s === "absent" ? "error.main" : s === "empty" ? "warning.main" : "divider";

  return (
    <Card variant="outlined" sx={{ borderColor: border, borderLeftWidth: 3 }}>
      <CardContent sx={{ pb: 2 }}>
        <Stack direction="row" spacing={2} alignItems="baseline">
          <Typography variant="h2" sx={{ fontSize: 15.5, fontWeight: 650 }}>
            {c.label}
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Typography
            sx={{
              fontFamily: MONO,
              fontSize: 22,
              fontWeight: 700,
              fontVariantNumeric: "tabular-nums",
              color:
                s === "absent" ? "error.main" : s === "empty" ? "warning.main" : "text.primary",
            }}
          >
            {countLabel(c)}
          </Typography>
        </Stack>

        {c.locator ? (
          <Typography sx={{ fontFamily: MONO, fontSize: 11.5, color: "text.secondary", mt: 0.5 }}>
            {c.locator}
          </Typography>
        ) : null}

        {/* The distinction the design turns on, stated in the UI rather than
            left for the reader to infer from a number. */}
        {s === "empty" ? (
          <Alert severity="warning" sx={{ mt: 1.5, py: 0.5 }}>
            <b>Matches nothing.</b> An invariant grounded here would examine no
            records and report success forever.
          </Alert>
        ) : null}
        {s === "absent" ? (
          <Alert severity="error" sx={{ mt: 1.5, py: 0.5 }}>
            <b>No referent.</b> This product cannot express this reading, so the
            check could never run — which is not the same as it passing.
          </Alert>
        ) : null}

        {c.caveat ? (
          <Typography variant="body2" sx={{ mt: 1.5, color: "text.secondary" }}>
            {c.caveat}
          </Typography>
        ) : null}

        {/* The decision. Grounding is the one step a machine is not qualified
            for, so the screen has to end in a person choosing — a reading you
            can read but not pick is a report, not a conversation. */}
        {c.available ? (
          <Box sx={{ mt: 2 }}>
            <Button
              size="small"
              variant={chosen ? "contained" : "outlined"}
              color={s === "empty" ? "warning" : "primary"}
              disabled={busy}
              onClick={onChoose}
            >
              {chosen ? "✓ This is the one" : "This is the one"}
            </Button>
            {s === "empty" ? (
              <Typography component="span" variant="body2"
                          sx={{ ml: 1.5, color: "warning.main" }}>
                choosing this grounds the term on an empty set
              </Typography>
            ) : null}
          </Box>
        ) : null}

        {c.examples.length ? (
          <>
            <Divider sx={{ my: 1.5 }} />
            <Stack spacing={0.5}>
              {c.examples.map((e, i) => (
                <Typography key={i} sx={{ fontFamily: MONO, fontSize: 11.5, color: "text.secondary" }}>
                  <Box component="span" sx={{ color: "text.primary", fontWeight: 600 }}>
                    {e.label}
                  </Box>
                  {" — "}
                  {e.detail}
                </Typography>
              ))}
            </Stack>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** A surface, the claims waiting on it, and whether anyone has bound it. */
type Hole = {
  surface: string;
  claims: string[];
  open: boolean;
  boundTo: string;
  alignsTo: string;
  retracted: boolean;
  pendingBy: string;
};

/**
 * ⛔ Terms cleared as "not a term" LEAVE the queue.
 *
 * That is the entire point of being able to reject one. `or`, `act` and
 * `rule, not rows` were extracted beside `sponsor:edit`, and a rejection that
 * left them in the list would clear nothing — the queue would stay noisy and
 * people would go back to ignoring it.
 */
function holesOf(terms: Term[]): Hole[] {
  const by = new Map<string, Hole>();
  const dropped = new Set(
    terms.filter((t) => t.retired || t.retracted).map((t) => t.surface),
  );
  for (const t of terms) {
    if (dropped.has(t.surface)) continue;
    const h = by.get(t.surface) ?? {
      surface: t.surface, claims: [], open: true, boundTo: "",
      alignsTo: "", retracted: false, pendingBy: "",
    };
    h.claims.push(t.requirement_id);
    if (!t.open) {
      h.open = false;
      h.boundTo = t.bound_to;
    }
    if (t.aligns_to) h.alignsTo = t.aligns_to;
    if (t.retracted) h.retracted = true;
    if (t.pending_by) h.pendingBy = t.pending_by;
    by.set(t.surface, h);
  }
  return [...by.values()].sort(
    (a, b) => b.claims.length - a.claims.length || a.surface.localeCompare(b.surface),
  );
}

/**
 * Surfaces that normalize to the same string.
 *
 * ⚠ Shown, never merged. The document writes `admin`, `org admin`, `org admins`,
 * `SAVVI admin` and `platform admin`; whether those are one term or five is a
 * judgement about the business, and a normalizer that quietly folded them would
 * ground four terms nobody looked at.
 */
function lookalikes(hole: Hole, all: Hole[]): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "").replace(/s$/, "");
  const k = norm(hole.surface);
  return all.filter((h) => h.surface !== hole.surface && norm(h.surface) === k).map((h) => h.surface);
}

export function Grounding({
  terms,
  requirements,
  project,
  initialSurface = "",
  onChanged,
}: {
  terms: Term[];
  requirements: Requirement[];
  project: string;
  initialSurface?: string;
  onChanged: () => void;
}) {
  const holes = useMemo(() => holesOf(terms), [terms]);
  const [selected, setSelected] = useState<string>(initialSurface);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [unproposed, setUnproposed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wrote, setWrote] = useState<string | null>(null);
  const [writeErr, setWriteErr] = useState<string | null>(null);
  const [ask, setAsk] = useState("");

  const hole = holes.find((h) => h.surface === selected) ?? holes[0];

  useEffect(() => setSelected(initialSurface), [initialSurface]);

  /**
   * Every act here is a PROPOSAL: appended to spec's log with its author and
   * shown as pending until promoted into the corpus. Nothing is edited in place,
   * so a wrong answer is withdrawable rather than baked in.
   */
  async function act(op: OpKind, fields: Record<string, string>, said: string) {
    setBusy(true);
    setWriteErr(null);
    setWrote(null);
    try {
      await submitOp(op, { project, ...fields }, corpusVersion());
      setWrote(said);
      onChanged();
    } catch (e) {
      setWriteErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!hole) return;
    let live = true;
    setResult(null);
    setError(null);
    setUnproposed(false);
    probe(hole.claims[0] ?? "", hole.surface)
      .then((r) => live && setResult(r))
      .catch((e) => {
        if (!live) return;
        if (e instanceof NoReadingProposed) setUnproposed(true);
        else setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [hole?.surface]);

  if (!hole) {
    return (
      <Box>
        <Typography variant="h1" sx={{ fontSize: 26, mb: 1 }}>Grounding</Typography>
        <Alert severity="info">
          <b>Nothing has been decomposed yet.</b> Grounding binds the terms a
          requirement depends on, and this project's requirements have not been
          broken into terms — so there is nothing here to point at. Run the
          decomposer over the corpus first.
        </Alert>
      </Box>
    );
  }

  const openCount = holes.filter((h) => h.open).length;
  const promise = requirements.find((r) => r.requirement_id === hole.claims[0])?.predicate ?? "";
  const alike = lookalikes(hole, holes);

  return (
    <Box>
      <Stack direction="row" spacing={2} alignItems="baseline" sx={{ mb: 0.5 }}>
        <Typography variant="h1" sx={{ fontSize: 26 }}>Grounding</Typography>
        <Chip
          size="small"
          color={openCount ? "warning" : "success"}
          label={`${openCount} of ${holes.length} terms unbound`}
        />
      </Stack>
      <Typography variant="body2" sx={{ color: "text.secondary", mb: 2.5, maxWidth: "72ch" }}>
        Each term below is a word the requirements lean on. Until someone says
        which records it points at, every claim depending on it is a sentence,
        not a control.
      </Typography>

      <Stack direction="row" spacing={3} alignItems="flex-start">
        <Box sx={{ width: 250, flexShrink: 0, maxHeight: "70vh", overflowY: "auto" }}>
          <List dense disablePadding>
            {holes.map((h) => (
              <ListItemButton
                key={h.surface}
                selected={h.surface === hole.surface}
                onClick={() => setSelected(h.surface)}
                sx={{ borderRadius: 1, mb: 0.25, alignItems: "baseline" }}
              >
                <Typography
                  sx={{
                    fontFamily: MONO, fontSize: 12, flex: 1,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    color: h.open ? "text.primary" : "success.main",
                  }}
                >
                  {h.surface}
                </Typography>
                <Typography
                  sx={{
                    fontFamily: MONO, fontSize: 11, color: "text.secondary",
                    fontVariantNumeric: "tabular-nums", ml: 1,
                  }}
                >
                  {h.claims.length}
                </Typography>
              </ListItemButton>
            ))}
          </List>
        </Box>

        <Box sx={{ flex: 1, minWidth: 0 }}>
          {/* ⚠ ONE of the claims, labelled as such. This used to render bare, so a
              term carrying eleven claims showed a single arbitrary sentence with
              nothing marking it as a sample — which reads as the term's
              definition rather than one place it is used. */}
          {promise ? (
            <>
              <Typography variant="body2" sx={{ color: "text.secondary", mb: 0.5 }}>
                {hole.claims.length === 1
                  ? "The claim that uses it:"
                  : `One of the ${hole.claims.length} claims that use it — ${(hole.claims[0] ?? "").toUpperCase()}:`}
              </Typography>
              <Typography sx={{ fontFamily: SERIF, fontSize: 19, lineHeight: 1.5, maxWidth: "58ch" }}>
                {inlineMarkup(promise)}
              </Typography>
            </>
          ) : null}

          <Stack direction="row" spacing={1} sx={{ mt: 1.5, mb: 3, flexWrap: "wrap", gap: 0.75 }}>
            {hole.claims.map((c) => (
              <Chip key={c} size="small" label={c.toUpperCase()} sx={{ fontFamily: MONO }} />
            ))}
          </Stack>

          <Typography variant="h2" sx={{ mb: 0.5 }}>
            Which records does{" "}
            <Box component="span" sx={{ fontFamily: MONO }}>{hole.surface}</Box>{" "}
            point at?
          </Typography>
          <Typography variant="body2" sx={{ color: "text.secondary", mb: 2, maxWidth: "64ch" }}>
            {hole.claims.length === 1
              ? "One claim depends on this term."
              : `${hole.claims.length} claims depend on this term, so a wrong answer here is wrong ${hole.claims.length} times.`}
          </Typography>

          {alike.length ? (
            <Alert severity="info" sx={{ mb: 2 }}>
              <b>The document also writes {alike.map((s) => `“${s}”`).join(", ")}.</b>{" "}
              These were kept separate on purpose — if they mean the same thing,
              that is your call to make, not the importer's.
              <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: "wrap", gap: 1 }}>
                {alike.map((other) => (
                  <Button key={other} size="small" variant="outlined" disabled={busy}
                          onClick={() =>
                            act("alignTerm", { term: hole.surface, aligns_to: other },
                                `${hole.surface} is the same term as ${other}`)}>
                    Same as {other}
                  </Button>
                ))}
              </Stack>
            </Alert>
          ) : null}

          {/* ⛔ The escape hatch, and the queue is unusable without it. Terms are
              read off the author's markup, and that is machine work that can be
              wrong: `or`, `act` and `rule, not rows` landed in this queue beside
              `sponsor:edit`. With no way to say "this is not a term", the only
              options were to bind it to something false or leave it blocking its
              claims forever. */}
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 2.5, flexWrap: "wrap", gap: 1 }}>
            <TextField
              size="small" value={ask} onChange={(e) => setAsk(e.target.value)}
              placeholder="Why is this not a term? (optional)"
              sx={{ minWidth: 300 }}
            />
            <Button size="small" color="inherit" variant="outlined" disabled={busy}
                    onClick={() => {
                      act("retractTerm", { term: hole.surface, reason: ask },
                          `${hole.surface} is not a term`);
                      setAsk("");
                    }}>
              Not a term
            </Button>
          </Stack>

          {wrote ? (
            <Alert severity="success" sx={{ mb: 2 }}>
              <b>Recorded.</b> {wrote} — proposed under your name and waiting to be
              adopted into the corpus. Nothing was edited in place.
            </Alert>
          ) : null}
          {writeErr ? (
            <Alert severity="error" sx={{ mb: 2 }}>
              <b>Not recorded.</b> {writeErr}
            </Alert>
          ) : null}
          {hole.pendingBy ? (
            <Alert severity="info" sx={{ mb: 2 }}>
              <b>Proposed by {hole.pendingBy}, not yet adopted.</b>{" "}
              {hole.retracted
                ? "Marked as not a term."
                : hole.boundTo
                  ? `Bound to ${hole.boundTo}.`
                  : hole.alignsTo
                    ? `Aligned to ${hole.alignsTo}.`
                    : ""}
            </Alert>
          ) : null}

          {unproposed ? (
            <Alert severity="warning">
              <b>No reading has been proposed for this term.</b> The product
              answered, and its answer was that nothing in its referent registry
              claims to speak for <code>{hole.surface}</code>. That is an open
              hole, not a failure — someone who knows the data model has to
              propose what this term could point at before anyone can choose.
            </Alert>
          ) : null}

          {error ? (
            <Alert severity="info">
              <b>No grounding adapter is answering.</b> {error}
              <br />
              The product answers this question in its own environment — spec
              never queries a product database — so with the adapter down there
              is nothing to show. That is a missing answer, not an empty one.
            </Alert>
          ) : null}

          {!result && !error && !unproposed ? (
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              asking {hole.surface}…
            </Typography>
          ) : null}

          <Stack spacing={1.5}>
            {result?.candidates.map((c) => (
              <CandidateCard
                key={c.locator || c.label}
                c={c}
                busy={busy}
                chosen={hole.boundTo === c.locator}
                onChoose={() =>
                  act("bindTerm", { term: hole.surface, definition: c.locator },
                      `${hole.surface} now means “${c.label}”`)
                }
              />
            ))}
          </Stack>

          {result ? (
            <Typography variant="body2" sx={{ color: "text.secondary", mt: 2.5, maxWidth: "64ch" }}>
              Choosing binds{" "}
              <Box component="span" sx={{ fontFamily: MONO }}>{hole.surface}</Box>{" "}
              for all {hole.claims.length} claim{hole.claims.length === 1 ? "" : "s"}, as a
              proposal recorded under your name.
            </Typography>
          ) : null}
        </Box>
      </Stack>
    </Box>
  );
}
