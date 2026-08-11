import { useMemo, useState } from "react";
import {
  Box, Chip, Drawer, IconButton, InputAdornment, MenuItem, Paper, Select,
  Stack, TextField, Typography,
} from "@mui/material";
import type { Requirement, Term } from "../api";
import { stateOf } from "../api";
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
  req, terms, onClose, onGround,
}: {
  req: Requirement | null;
  terms: Term[];
  onClose: () => void;
  onGround: (surface: string) => void;
}) {
  if (!req) return null;
  const mine = terms.filter((t) => t.requirement_id === req.requirement_id);
  const blocker = blockerOf(req);

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

      <Typography sx={{ fontFamily: SERIF, fontSize: 17, lineHeight: 1.55, mb: 2.5 }}>
        {plain(req.predicate)}
      </Typography>

      <Stack direction="row" spacing={1} sx={{ mb: 3, flexWrap: "wrap", gap: 0.75 }}>
        <Chip size="small" variant="outlined" label={req.discipline} />
        <Chip size="small" variant="outlined" label={req.modality.replace("_", " ")}
              sx={{ fontFamily: MONO }} />
      </Stack>

      <Typography variant="h2" sx={{ fontSize: 13, mb: 0.5 }}>What's holding it up</Typography>
      <Typography variant="body2" sx={{ color: "text.secondary", mb: 3 }}>
        <b>{blocker.label}.</b> {blocker.hint}
      </Typography>

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

export function Requirements({
  project, reqs, terms, onGround,
}: {
  project: string;
  reqs: Requirement[];
  terms: Term[];
  onGround: (surface: string) => void;
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

      <Detail
        req={shown.find((r) => r.requirement_id === open) ?? null}
        terms={terms}
        onClose={() => setOpen(null)}
        onGround={(surface) => { setOpen(null); onGround(surface); }}
      />
    </Box>
  );
}
