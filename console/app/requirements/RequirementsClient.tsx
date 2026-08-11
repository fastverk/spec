"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useEffect, useMemo, useState } from "react";

import { measurement, stateOf } from "../../lib/evaluated";
import type { Row } from "../../lib/overlay";
import { inProject, openingProject, projectsIn } from "../../lib/project";
import { MONO, SERIF } from "../theme";
import { OverlayError, PaneHead, ProjectPicker, ReadOnly, StateChip } from "../ui";
import { submitOp, useOverlay } from "../useOverlay";

const MODALITIES = ["MUST", "MUST_NOT", "SHOULD", "SHOULD_NOT", "MAY"];

/** `AUTH-2` before `AUTH-10`. */
function compareIds(a: string, b: string): number {
  const key = (s: string) => s.replace(/\d+/g, (d) => d.padStart(6, "0"));
  return key(a).localeCompare(key(b));
}

const BLOCKERS: Record<string, { label: string; hint: string }> = {
  "unbound-terms": { label: "Terms are not pinned down", hint: "A word in it does not yet point at any real records." },
  "modality-unstated": { label: "The modality is unstated", hint: "Whether this must or merely should hold was never written down." },
  "not-decomposed": { label: "Not broken into terms", hint: "Nothing has read it for the words that carry weight." },
  retired: { label: "Withdrawn", hint: "It was demoted, and the ground is recorded with it." },
};

function blockerOf(r: Row) {
  const raw = typeof r["blocked_on"] === "string" ? r["blocked_on"] : "";
  if (!raw) return { label: "Nothing", hint: "It is ready for a check to be run against it." };
  const slug = raw.split(":")[0] ?? "";
  return BLOCKERS[slug] ?? { label: slug, hint: raw };
}

function Detail({ req, terms: allTerms, areas, writeEnabled, parent, onClose, onChanged }: {
  req: Row; terms: Row[]; areas: string[]; writeEnabled: boolean; parent: string;
  onClose: () => void; onChanged: () => void;
}) {
  const id = String(req["requirement_id"]);
  const [editing, setEditing] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [text, setText] = useState(String(req["predicate"] ?? ""));
  const [modality, setModality] = useState(String(req["modality"] ?? "MUST"));
  const [area, setArea] = useState(String(req["discipline"] ?? ""));
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setEditing(false); setWithdrawing(false); setErr(null); setSaved(false); setWhy("");
    setText(String(req["predicate"] ?? ""));
    setModality(String(req["modality"] ?? "MUST"));
    setArea(String(req["discipline"] ?? ""));
  }, [id, req]);

  const mine = allTerms.filter((t) => t["requirement_id"] === id);
  const blocker = blockerOf(req);
  const meas = measurement(req);

  async function save(op: string, fields: Record<string, unknown>) {
    setBusy(true); setErr(null);
    try {
      await submitOp(op, fields, parent);
      setSaved(true); setEditing(false); setWithdrawing(false);
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
        <Typography sx={{ fontFamily: MONO, fontWeight: 700, fontSize: 15 }}>{id.toUpperCase()}</Typography>
        <StateChip state={stateOf(req)} />
        <Box sx={{ flex: 1 }} />
        <IconButton size="small" onClick={onClose} aria-label="Close">✕</IconButton>
      </Stack>

      {req["pending"] ? (
        <Alert severity="info" sx={{ mb: 2 }}>
          <b>Proposed by {String(req["pending_by"] ?? "")}, not yet adopted.</b>{" "}
          {req["retracted"] ? "Withdrawal proposed." : "Shown with the change applied."}
        </Alert>
      ) : null}
      {saved ? (
        <Alert severity="success" sx={{ mb: 2 }}>
          <b>Recorded</b> as a proposal under your name, against {parent}. Nothing was edited in place.
        </Alert>
      ) : null}
      {err ? <Alert severity="error" sx={{ mb: 2 }}><b>Not recorded.</b> {err}</Alert> : null}

      {editing ? (
        <Stack spacing={2} sx={{ mb: 3 }}>
          <TextField multiline minRows={4} value={text} onChange={(e) => setText(e.target.value)}
                     label="What this requirement says"
                     helperText="Mark the words that carry weight with `backticks` or **bold** — that is what decomposition reads to find terms." />
          <Stack direction="row" spacing={2}>
            <Select size="small" value={modality} onChange={(e) => setModality(String(e.target.value))}
                    sx={{ minWidth: 150, fontFamily: MONO, fontSize: 13 }}>
              {MODALITIES.map((m) => <MenuItem key={m} value={m} sx={{ fontFamily: MONO, fontSize: 13 }}>{m}</MenuItem>)}
            </Select>
            <Select size="small" value={area} onChange={(e) => setArea(String(e.target.value))}
                    sx={{ minWidth: 220, fontSize: 13 }}>
              {areas.map((a) => <MenuItem key={a} value={a} sx={{ fontSize: 13 }}>{a}</MenuItem>)}
            </Select>
          </Stack>
          <Stack direction="row" spacing={1}>
            <Button variant="contained" disabled={busy || !text.trim()}
                    onClick={() => save("amendNS", { subject: id, text, modality, discipline: area })}>
              Propose this change
            </Button>
            <Button color="inherit" disabled={busy} onClick={() => setEditing(false)}>Cancel</Button>
          </Stack>
        </Stack>
      ) : (
        <>
          <Typography sx={{ fontFamily: SERIF, fontSize: 17, lineHeight: 1.55, mb: 2.5 }}>
            {String(req["predicate"] ?? "").replace(/[`*]/g, "")}
          </Typography>
          <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: "wrap", gap: 0.75 }}>
            <Chip size="small" variant="outlined" label={String(req["discipline"] ?? "")} />
            <Chip size="small" variant="outlined" sx={{ fontFamily: MONO }}
                  label={String(req["modality"] ?? "").replace("_", " ")} />
            {meas ? (
              <Chip size="small" label={meas.label}
                    color={meas.tone === "bad" ? "error" : meas.tone === "warn" ? "warning" : "success"} />
            ) : null}
          </Stack>

          {writeEnabled ? (
            <>
              <Stack direction="row" spacing={1} sx={{ mb: withdrawing ? 1.5 : 3 }}>
                <Button size="small" variant="outlined" onClick={() => setEditing(true)}>Reword</Button>
                <Button size="small" color="inherit" variant="outlined"
                        disabled={busy || Boolean(req["retracted"]) || withdrawing}
                        onClick={() => setWithdrawing(true)}>
                  {req["retracted"] ? "Withdrawal proposed" : "Withdraw"}
                </Button>
              </Stack>
              {withdrawing ? (
                <Stack spacing={1.5} sx={{ mb: 3 }}>
                  <TextField size="small" multiline minRows={2} value={why} autoFocus
                             onChange={(e) => setWhy(e.target.value)}
                             label="Why is this being withdrawn?"
                             helperText="Withdrawal demotes a requirement, it does not delete it. The ground is recorded with it." />
                  <Stack direction="row" spacing={1}>
                    <Button size="small" variant="contained" disabled={busy || !why.trim()}
                            onClick={() => save("retractNS", { subject: id, reason: why.trim() })}>
                      Propose withdrawal
                    </Button>
                    <Button size="small" color="inherit" disabled={busy}
                            onClick={() => { setWithdrawing(false); setWhy(""); }}>Cancel</Button>
                  </Stack>
                </Stack>
              ) : null}
            </>
          ) : null}
        </>
      )}

      <Typography variant="h2" sx={{ fontSize: 13, mb: 0.5 }}>What&rsquo;s holding it up</Typography>
      <Typography variant="body2" sx={{ color: "text.secondary", mb: 3 }}>
        <b>{blocker.label}.</b> {blocker.hint}
      </Typography>

      <Typography variant="h2" sx={{ fontSize: 13, mb: 0.5 }}>Terms it depends on</Typography>
      {mine.length === 0 ? (
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          None. Nothing has broken this into terms yet.
        </Typography>
      ) : (
        <Stack spacing={0.75}>
          {mine.map((t, i) => (
            <Box key={`${String(t["term_id"])}-${i}`}
                 sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <Typography sx={{ fontFamily: MONO, fontSize: 12.5 }}>{String(t["surface"])}</Typography>
              {t["bound_to"] ? (
                <Chip size="small" variant="outlined" color="success" sx={{ fontSize: 10.5 }}
                      label={t["pending"] ? "proposed" : "pinned down"} />
              ) : (
                <Chip size="small" variant="outlined" sx={{ fontSize: 10.5 }} label="not pinned down" />
              )}
            </Box>
          ))}
        </Stack>
      )}
    </Drawer>
  );
}

export function RequirementsClient({ corpusReqs, corpusTerms }: { corpusReqs: Row[]; corpusTerms: Row[] }) {
  const { data, error, refresh } = useOverlay();
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const reqs = data?.requirements ?? corpusReqs;
  const termRows = data?.terms ?? corpusTerms;
  const parent = data?.corpus_version ?? "";

  const projectList = useMemo(() => projectsIn(corpusReqs), [corpusReqs]);
  const [project, setProject] = useState(() => openingProject(projectList));
  const mine = useMemo(() => reqs.filter((r) => inProject(r, project)), [reqs, project]);

  // ⛔ Scoped to the project, because the disciplines of two products are two
  // vocabularies, not one. The corpus shares none across `studio` and `ampere`,
  // so an unscoped list offered "electrochemistry & thermal" as somewhere to file
  // a SAVVI access requirement — a reword that would have been accepted, recorded
  // and attributed, and read as nonsense.
  const areas = useMemo(
    () => [...new Set(mine.map((r) => String(r["discipline"] ?? "")))].filter(Boolean).sort(),
    [mine],
  );

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return mine
      .filter((r) => !needle ||
        String(r["requirement_id"]).toLowerCase().includes(needle) ||
        String(r["predicate"]).toLowerCase().includes(needle))
      .sort((a, b) => compareIds(String(a["requirement_id"]), String(b["requirement_id"])));
  }, [mine, q]);

  const open = openId ? shown.find((r) => r["requirement_id"] === openId) ?? null : null;

  return (
    <>
      <PaneHead
        title="Requirements"
        blurb="What the document says, and how far each sentence has got toward being something a machine could check. Nothing here is edited in place — every change is a proposal against the read point you are looking at."
      />

      {error ? <OverlayError message={error} /> : null}
      {data && !data.write_enabled ? <ReadOnly because={data.write_disabled_because} /> : null}

      {/* Closing the drawer on a project change is not cosmetic: the open row
          belongs to the project you just left, and its terms and disciplines do
          too. Requirement ids do not collide across the corpus today, so the
          drawer would empty rather than mislead — but that is a property of this
          corpus, not of the pane. */}
      <ProjectPicker projects={projectList} value={project}
                     onChange={(p) => { setProject(p); setOpenId(null); }} />

      <TextField size="small" placeholder={`Search ${mine.length} requirements`} value={q}
                 onChange={(e) => setQ(e.target.value)} sx={{ mb: 2, width: 340 }} />

      <Stack spacing={0.75}>
        {shown.map((r) => {
          const meas = measurement(r);
          return (
            <Paper key={String(r["requirement_id"])} variant="outlined"
                   onClick={() => setOpenId(String(r["requirement_id"]))}
                   sx={{ p: 1.5, cursor: "pointer", "&:hover": { borderColor: "primary.main" } }}>
              <Stack direction="row" spacing={1.5} alignItems="baseline">
                <Typography sx={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, minWidth: 128 }}>
                  {String(r["requirement_id"]).toUpperCase()}
                </Typography>
                <Typography sx={{ flex: 1, fontSize: 13.5, lineHeight: 1.45 }}>
                  {String(r["predicate"] ?? "").replace(/[`*]/g, "")}
                </Typography>
                <Stack direction="row" spacing={0.75} sx={{ flexShrink: 0 }}>
                  {r["pending"] ? <Chip size="small" color="info" variant="outlined" label="proposed" sx={{ fontSize: 10 }} /> : null}
                  {meas ? (
                    <Chip size="small" label={meas.label} sx={{ fontSize: 10 }}
                          color={meas.tone === "bad" ? "error" : meas.tone === "warn" ? "warning" : "success"} />
                  ) : null}
                  <StateChip state={stateOf(r)} />
                </Stack>
              </Stack>
            </Paper>
          );
        })}
      </Stack>

      {open ? (
        <Detail req={open} terms={termRows.filter((t) => inProject(t, project))}
                areas={areas} parent={parent}
                writeEnabled={Boolean(data?.write_enabled)}
                onClose={() => setOpenId(null)} onChanged={refresh} />
      ) : null}
    </>
  );
}
