import { useEffect, useMemo, useState } from "react";
import {
  Alert, Box, Button, Chip, Drawer, IconButton, InputAdornment, MenuItem, Paper,
  Select, Stack, TextField, Typography,
} from "@mui/material";
import type { OpKind, Requirement, Term } from "../api";
import { corpusVersion, evaluate, measurement, recordEvaluation, stateOf, submitOp } from "../api";
import { PaneHead, StateChip } from "../ui";
import { MONO, SERIF } from "../theme";

/**
 * The requirements list.
 *
 * ## What this pane got wrong, and why it mattered
 *
 * It used to be a six-column table of ID / area / modality / state / examined /
 * blocked-on — and NOT the requirement. You could not read a single sentence
 * this product commits to without leaving for the Document pane. A
 * specification list whose one job is showing the specification was showing
 * everything except it.
 *
 * Three of those columns were also pure noise: `state` read "In question" on
 * all 69 rows, `examined` read "—" on all 69, and `modality` is a property of
 * one claim rather than something you scan a list by. A column that is constant
 * down its whole length costs width and returns nothing; they moved into the
 * detail panel where they answer a question someone actually asked.
 *
 * ⚠ Sorting is NATURAL, not lexicographic. `AUTH-1, AUTH-10, AUTH-11 … AUTH-2`
 * is what string ordering gives you, and it makes the list feel broken in a way
 * people work around rather than report.
 */

/** AUTH-2 before AUTH-10, and AUTH-2A after AUTH-2. */
function naturalKey(id: string): [number, string] {
  const m = /^[a-z]+-(\d+)([a-z]*)$/i.exec(id);
  return m ? [Number(m[1]), (m[2] ?? "").toLowerCase()] : [Number.MAX_SAFE_INTEGER, id];
}

function compareIds(a: string, b: string): number {
  const [an, as_] = naturalKey(a);
  const [bn, bs] = naturalKey(b);
  return an - bn || as_.localeCompare(bs);
}

/**
 * The blocker, in words a product owner can act on.
 *
 * The corpus stores machine slugs (`unbound-terms`, `modality-unstated`) because
 * gates key on them. Showing them raw asks the reader to learn the ladder's
 * vocabulary before they can learn what is wrong with their own requirement.
 */
const BLOCKERS: Record<string, { label: string; hint: string }> = {
  "unbound-terms": {
    label: "Terms not yet pinned down",
    hint: "This names some terms, but nobody has said which records they point at.",
  },
  "modality-unstated": {
    label: "Doesn't say must or may",
    hint: "The sentence states no obligation, so “must” is a guess nobody has confirmed.",
  },
  "not-decomposed": {
    label: "Not broken into terms",
    hint: "Nothing in the wording was marked as a term, so there is nothing yet to pin down.",
  },
  retired: {
    label: "Retired",
    hint: "This identifier was removed when the document was restructured. It is kept so nobody reuses it.",
  },
};

function blockerOf(r: Requirement) {
  const key = r.blocked_on.split(":")[0] ?? "";
  return BLOCKERS[key] ?? { label: key || "—", hint: r.blocked_on };
}

const isRetired = (r: Requirement) => r.blocked_on.startsWith("retired");

/** Strip the author's markup so a list row reads as a sentence. */
function plain(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`(.+?)`/g, "$1");
}

function Detail({
  req, terms, areas, onClose, onGround, onChanged,
}: {
  req: Requirement | null;
  terms: Term[];
  areas: string[];
  onClose: () => void;
  onGround: (surface: string) => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [modality, setModality] = useState("");
  const [area, setArea] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [checked, setChecked] = useState<string | null>(null);
  // ⛔ `retractNS` REQUIRES a reason and always did — "retract never deletes; it
  // demotes", and a demotion with no stated ground is indistinguishable from a
  // mistake. Withdraw used to submit `{subject}` alone, so every click 422'd with
  // "`retractNS` requires `reason`" and nothing was ever appended. The fix is to
  // ask for the ground, not to make the vocabulary accept its absence.
  const [withdrawing, setWithdrawing] = useState(false);
  const [why, setWhy] = useState("");

  useEffect(() => {
    if (!req) return;
    setEditing(false);
    setErr(null);
    setSaved(false);
    setText(req.predicate);
    setModality(req.modality);
    setArea(req.discipline);
    setChecked(null);
    setWithdrawing(false);
    setWhy("");
  }, [req?.requirement_id]);

  if (!req) return null;
  const mine = terms.filter((t) => t.requirement_id === req.requirement_id);
  const blocker = blockerOf(req);
  // Only a BOUND term has a referent to measure. An unbound one has nothing to
  // point a query at, which is why grounding comes first.
  const bound = mine.filter((t) => !t.open && t.bound_to);

  /**
   * Ask the project what this check would examine, and record the answer.
   *
   * ⚠ The result is a POPULATION, not a verdict. Nothing here decides whether
   * the requirement holds — that needs the predicate half, which does not exist
   * yet. What it does establish is whether a check would examine anything at
   * all, which is what decides if a future pass would mean anything.
   */
  async function check(referent: string) {
    setBusy(true);
    setErr(null);
    setChecked(null);
    try {
      const r = await evaluate(req!.requirement_id, referent);
      await recordEvaluation(r, req!.project);
      setChecked(
        r.outcome === "VACUOUS"
          ? "It would examine NO records. A pass here would mean nothing."
          : r.outcome === "CANNOT_BE_GROUNDED"
            ? "This product has no referent for that reading — the check could never run."
            : `It would examine ${r.population?.count.toLocaleString()} records.`,
      );
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Amendments are PROPOSALS, never in-place edits. The corpus is generated from
   * a source document and checked by gates; letting a screen overwrite it would
   * make the document and the corpus disagree with no record of who chose what.
   */
  async function save(op: OpKind, fields: Record<string, string>) {
    setBusy(true);
    setErr(null);
    try {
      await submitOp(op, fields, corpusVersion());
      setSaved(true);
      setEditing(false);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer anchor="right" open onClose={onClose}
            slotProps={{ paper: { sx: { width: { xs: "100%", sm: 560 }, p: 3 } } }}>
      <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 2 }}>
        <Typography sx={{ fontFamily: MONO, fontWeight: 700, fontSize: 15 }}>
          {req.requirement_id.toUpperCase()}
        </Typography>
        <StateChip state={stateOf(req)} />
        <Box sx={{ flex: 1 }} />
        <IconButton size="small" onClick={onClose} aria-label="Close">✕</IconButton>
      </Stack>

      {req.pending ? (
        <Alert severity="info" sx={{ mb: 2 }}>
          <b>Proposed by {req.pending_by}, not yet adopted.</b>{" "}
          {req.retracted ? "Withdrawal proposed." : "Shown with the change applied."}
        </Alert>
      ) : null}
      {saved ? (
        <Alert severity="success" sx={{ mb: 2 }}>
          <b>Recorded</b> as a proposal under your name. Nothing was edited in place.
        </Alert>
      ) : null}
      {err ? <Alert severity="error" sx={{ mb: 2 }}><b>Not recorded.</b> {err}</Alert> : null}

      {editing ? (
        <Stack spacing={2} sx={{ mb: 3 }}>
          <TextField
            multiline minRows={4} value={text} onChange={(e) => setText(e.target.value)}
            label="What this requirement says"
            helperText="Mark the words that carry weight with `backticks` or **bold** — that is what decomposition reads to find terms."
          />
          <Stack direction="row" spacing={2}>
            <Select size="small" value={modality} onChange={(e) => setModality(String(e.target.value))}
                    sx={{ minWidth: 150, fontFamily: MONO, fontSize: 13 }}>
              {["MUST", "MUST_NOT", "SHOULD", "SHOULD_NOT", "MAY"].map((m) => (
                <MenuItem key={m} value={m} sx={{ fontFamily: MONO, fontSize: 13 }}>{m}</MenuItem>
              ))}
            </Select>
            <Select size="small" value={area} onChange={(e) => setArea(String(e.target.value))}
                    sx={{ minWidth: 220, fontSize: 13 }}>
              {areas.map((a) => <MenuItem key={a} value={a} sx={{ fontSize: 13 }}>{a}</MenuItem>)}
            </Select>
          </Stack>
          <Stack direction="row" spacing={1}>
            <Button variant="contained" disabled={busy || !text.trim()}
                    onClick={() => save("amendNS", {
                      subject: req.requirement_id, text,
                      modality, discipline: area,
                    })}>
              Propose this change
            </Button>
            <Button color="inherit" disabled={busy} onClick={() => setEditing(false)}>Cancel</Button>
          </Stack>
        </Stack>
      ) : (
        <>
          <Typography sx={{ fontFamily: SERIF, fontSize: 17, lineHeight: 1.55, mb: 2.5 }}>
            {plain(req.predicate)}
          </Typography>

          <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: "wrap", gap: 0.75 }}>
            <Chip size="small" variant="outlined" label={req.discipline} />
            <Chip size="small" variant="outlined" label={req.modality.replace("_", " ")}
                  sx={{ fontFamily: MONO }} />
          </Stack>

          <Stack direction="row" spacing={1} sx={{ mb: withdrawing ? 1.5 : 3 }}>
            <Button size="small" variant="outlined" onClick={() => setEditing(true)}>
              Reword
            </Button>
            <Button size="small" color="inherit" variant="outlined"
                    disabled={busy || req.retracted || withdrawing}
                    onClick={() => setWithdrawing(true)}>
              {req.retracted ? "Withdrawal proposed" : "Withdraw"}
            </Button>
          </Stack>

          {withdrawing ? (
            <Stack spacing={1.5} sx={{ mb: 3 }}>
              <TextField
                size="small" multiline minRows={2} value={why} autoFocus
                onChange={(e) => setWhy(e.target.value)}
                label="Why is this being withdrawn?"
                helperText="Withdrawal demotes a requirement, it does not delete it. The ground is recorded with it."
              />
              <Stack direction="row" spacing={1}>
                <Button size="small" variant="contained" disabled={busy || !why.trim()}
                        onClick={() => save("retractNS", {
                          subject: req.requirement_id, reason: why.trim(),
                        })}>
                  Propose withdrawal
                </Button>
                <Button size="small" color="inherit" disabled={busy}
                        onClick={() => { setWithdrawing(false); setWhy(""); }}>
                  Cancel
                </Button>
              </Stack>
            </Stack>
          ) : null}
        </>
      )}

      <Typography variant="h2" sx={{ fontSize: 13, mb: 0.5 }}>What's holding it up</Typography>
      <Typography variant="body2" sx={{ color: "text.secondary", mb: 3 }}>
        <b>{blocker.label}.</b> {blocker.hint}
      </Typography>

      {/* The check. Offered only once something is bound, because until then
          there is no referent to point a query at. */}
      {bound.length ? (
        <Box sx={{ mb: 3 }}>
          <Typography variant="h2" sx={{ fontSize: 13, mb: 0.5 }}>
            What would this examine?
          </Typography>
          <Typography variant="body2" sx={{ color: "text.secondary", mb: 1 }}>
            The product runs the query in its own environment and returns a count.
            No records leave it.
          </Typography>
          <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
            {bound.map((t) => (
              <Button key={t.term_id} size="small" variant="outlined" disabled={busy}
                      onClick={() => check(t.bound_to)}>
                Check via {t.surface}
              </Button>
            ))}
          </Stack>
          {checked ? (
            <Alert severity={checked.startsWith("It would examine NO") ? "warning"
                             : checked.startsWith("This product has no") ? "error" : "success"}
                   sx={{ mt: 1.5 }}>
              {checked}
            </Alert>
          ) : null}
          {req.population !== "—" ? (
            <Typography variant="body2" sx={{ color: "text.secondary", mt: 1.5 }}>
              Last measured: <b>{req.population}</b> records · {req.outcome}
              {req.evaluation_pending ? ` · by ${req.evaluated_by}, not yet adopted` : ""}
            </Typography>
          ) : null}
        </Box>
      ) : null}

      <Typography variant="h2" sx={{ fontSize: 13, mb: 1 }}>
        Terms it depends on {mine.length ? `(${mine.length})` : ""}
      </Typography>
      {mine.length ? (
        <Stack spacing={0.75}>
          {mine.map((t) => (
            <Chip
              key={t.term_id}
              label={t.surface}
              onClick={() => onGround(t.surface)}
              sx={{ fontFamily: MONO, fontSize: 12, justifyContent: "flex-start" }}
              variant={t.open ? "outlined" : "filled"}
              color={t.open ? "default" : "success"}
            />
          ))}
          <Typography variant="body2" sx={{ color: "text.secondary", mt: 1 }}>
            Pick one to say which records it points at.
          </Typography>
        </Stack>
      ) : (
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          None yet. Nothing in this wording was marked as a term, so there is
          nothing to pin down — mark the words that carry weight in the source
          document and re-import.
        </Typography>
      )}
    </Drawer>
  );
}

/**
 * Writing a requirement that does not come from the source document.
 *
 * ⚠ The id is the author's to choose and is checked against what exists. spec
 * would otherwise accept an assertNS over a live id, and the overlay drops it
 * rather than shadowing the original — a silent no-op is the worst outcome, so
 * the collision is caught here where it can be explained.
 */
function NewRequirement({
  open, project, areas, existing, onClose, onChanged,
}: {
  open: boolean;
  project: string;
  areas: string[];
  existing: Set<string>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [id, setId] = useState("");
  const [text, setText] = useState("");
  const [modality, setModality] = useState("MUST");
  const [area, setArea] = useState(areas[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!open) return null;
  const clash = existing.has(id.trim().toLowerCase());

  async function write() {
    setBusy(true);
    setErr(null);
    try {
      await submitOp("assertNS", {
        subject: id.trim().toLowerCase(),
        text: text.trim(),
        discipline: area,
        modality,
        // R0 is the only honest rung for a sentence that has just been written:
        // nothing has decomposed it, nothing has grounded it, nothing checks it.
        rung: "R0",
        project,
      }, corpusVersion());
      onChanged();
      onClose();
      setId("");
      setText("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer anchor="right" open onClose={onClose}
            slotProps={{ paper: { sx: { width: { xs: "100%", sm: 560 }, p: 3 } } }}>
      <Stack direction="row" alignItems="center" sx={{ mb: 2 }}>
        <Typography variant="h2" sx={{ fontSize: 16, flex: 1 }}>New requirement</Typography>
        <IconButton size="small" onClick={onClose} aria-label="Close">✕</IconButton>
      </Stack>

      {err ? <Alert severity="error" sx={{ mb: 2 }}><b>Not recorded.</b> {err}</Alert> : null}

      <Stack spacing={2}>
        <TextField size="small" label="Identifier" value={id} placeholder="auth-68"
                   onChange={(e) => setId(e.target.value)}
                   error={clash}
                   helperText={clash ? "That identifier already exists — pick another." : "Lower case, e.g. auth-68."} />
        <TextField multiline minRows={4} label="What it commits to" value={text}
                   onChange={(e) => setText(e.target.value)}
                   helperText="Mark the words that carry weight with `backticks` or **bold** — decomposition reads those to find terms." />
        <Stack direction="row" spacing={2}>
          <Select size="small" value={modality} onChange={(e) => setModality(String(e.target.value))}
                  sx={{ minWidth: 150, fontFamily: MONO, fontSize: 13 }}>
            {["MUST", "MUST_NOT", "SHOULD", "SHOULD_NOT", "MAY"].map((m) => (
              <MenuItem key={m} value={m} sx={{ fontFamily: MONO, fontSize: 13 }}>{m}</MenuItem>
            ))}
          </Select>
          <Select size="small" value={area} onChange={(e) => setArea(String(e.target.value))}
                  sx={{ minWidth: 220, fontSize: 13 }}>
            {areas.map((a) => <MenuItem key={a} value={a} sx={{ fontSize: 13 }}>{a}</MenuItem>)}
          </Select>
        </Stack>
        <Box>
          <Button variant="contained" disabled={busy || clash || !id.trim() || !text.trim()}
                  onClick={write}>
            Propose it
          </Button>
        </Box>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          It lands as a proposal under your name, at the same starting point as
          every imported requirement: written down, nothing checking it yet.
        </Typography>
      </Stack>
    </Drawer>
  );
}

export function Requirements({
  project, reqs, terms, onGround, onChanged,
}: {
  project: string;
  reqs: Requirement[];
  terms: Term[];
  onGround: (surface: string) => void;
  onChanged: () => void;
}) {
  const mine = useMemo(
    () => reqs.filter((r) => r.project === project).sort((a, b) => compareIds(a.requirement_id, b.requirement_id)),
    [reqs, project],
  );
  const areas = useMemo(
    () => Array.from(new Set(mine.map((r) => r.discipline))).sort(),
    [mine],
  );
  const termCount = useMemo(() => {
    const n = new Map<string, number>();
    for (const t of terms) n.set(t.requirement_id, (n.get(t.requirement_id) ?? 0) + 1);
    return n;
  }, [terms]);

  const [area, setArea] = useState("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);

  const shown = mine.filter((r) => {
    if (area !== "all" && r.discipline !== area) return false;
    if (!q.trim()) return true;
    const hay = `${r.requirement_id} ${r.discipline} ${r.predicate}`.toLowerCase();
    return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
  });

  return (
    <Box>
      <PaneHead
        title="Requirements"
        sub="Everything this product commits to. The list is the specification — the document is a rendering of it."
      />

      <Stack direction="row" spacing={2} sx={{ mb: 2 }} alignItems="center">
        <TextField
          size="small" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search the wording…"
          sx={{ minWidth: 300 }}
          slotProps={{
            input: {
              startAdornment: <InputAdornment position="start">🔍</InputAdornment>,
            },
          }}
        />
        <Select size="small" value={area} onChange={(e) => setArea(String(e.target.value))}
                sx={{ minWidth: 240, fontSize: 13 }}>
          <MenuItem value="all" sx={{ fontSize: 13 }}>All areas ({mine.length})</MenuItem>
          {areas.map((a) => (
            <MenuItem key={a} value={a} sx={{ fontSize: 13 }}>
              {a} ({mine.filter((r) => r.discipline === a).length})
            </MenuItem>
          ))}
        </Select>
        <Box sx={{ flex: 1 }} />
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {shown.length} shown
        </Typography>
        <Button size="small" variant="contained" onClick={() => setWriting(true)}>
          New requirement
        </Button>
      </Stack>

      <Paper variant="outlined">
        {shown.map((r, i) => {
          const retired = isRetired(r);
          const n = termCount.get(r.requirement_id) ?? 0;
          return (
            <Box
              key={r.requirement_id}
              component="button"
              onClick={() => setOpen(r.requirement_id)}
              sx={{
                display: "block", width: "100%", textAlign: "left", border: 0,
                borderTop: i ? 1 : 0, borderColor: "divider", bgcolor: "transparent",
                px: 2, py: 1.5, cursor: "pointer", font: "inherit",
                "&:hover": { bgcolor: "action.hover" },
                "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: -2 },
              }}
            >
              <Stack direction="row" spacing={2} alignItems="baseline">
                <Typography sx={{
                  fontFamily: MONO, fontSize: 12, whiteSpace: "nowrap", width: 84,
                  color: retired ? "text.disabled" : "text.primary",
                  textDecoration: retired ? "line-through" : "none",
                }}>
                  {r.requirement_id.toUpperCase()}
                </Typography>

                {/* The requirement itself — the thing the pane is named after. */}
                <Typography sx={{
                  flex: 1, fontSize: 13.5, lineHeight: 1.5,
                  color: retired ? "text.disabled" : "text.primary",
                  display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}>
                  {plain(r.predicate)}
                </Typography>

                <Stack direction="row" spacing={1} alignItems="center" sx={{ flexShrink: 0 }}>
                  {n ? (
                    <Chip size="small" variant="outlined" label={`${n} term${n === 1 ? "" : "s"}`}
                          sx={{ fontSize: 11 }} />
                  ) : null}
                  {measurement(r) ? (
                    <Chip size="small" sx={{ fontSize: 11 }}
                          color={measurement(r)!.tone === "bad" ? "error"
                                 : measurement(r)!.tone === "warn" ? "warning" : "success"}
                          variant={measurement(r)!.tone === "ok" ? "filled" : "outlined"}
                          label={measurement(r)!.label} />
                  ) : null}
                  {r.pending ? (
                    <Chip size="small" color="info" sx={{ fontSize: 11 }}
                          label={r.retracted ? "Withdrawal proposed" : "Change proposed"} />
                  ) : null}
                  {retired
                    ? <Chip size="small" label="Retired" sx={{ fontSize: 11 }} />
                    : <StateChip state={stateOf(r)} />}
                </Stack>
              </Stack>

              <Typography variant="body2" sx={{
                color: "text.secondary", fontSize: 11.5, mt: 0.5, ml: `${84 + 16}px`,
              }}>
                {r.discipline} · {blockerOf(r).label}
              </Typography>
            </Box>
          );
        })}
        {!shown.length ? (
          <Typography variant="body2" sx={{ p: 3, color: "text.secondary" }}>
            Nothing matches “{q}”.
          </Typography>
        ) : null}
      </Paper>

      <NewRequirement
        open={writing}
        project={project}
        areas={areas}
        existing={new Set(mine.map((r) => r.requirement_id))}
        onClose={() => setWriting(false)}
        onChanged={onChanged}
      />

      <Detail
        req={shown.find((r) => r.requirement_id === open) ?? null}
        terms={terms}
        areas={areas}
        onClose={() => setOpen(null)}
        onGround={(surface) => { setOpen(null); onGround(surface); }}
        onChanged={onChanged}
      />
    </Box>
  );
}
