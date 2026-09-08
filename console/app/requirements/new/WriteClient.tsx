"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { advise, droppedEmphasis, extract } from "../../../lib/decompose";
import type { Row } from "../../../lib/overlay";
import { inProject, openingProject, projectsIn } from "../../../lib/project";
import { MONO, SERIF } from "../../theme";
import { OverlayError, PaneHead, ProjectPicker, ReadOnly } from "../../ui";
import { submitOp, useOverlay } from "../../useOverlay";

const MODALITIES = ["MUST", "MUST_NOT", "SHOULD", "SHOULD_NOT", "MAY"];
const MODALITY_LABEL: Record<string, string> = {
  MUST: "Must — required",
  MUST_NOT: "Must not — prohibited",
  SHOULD: "Should — expected",
  SHOULD_NOT: "Should not — discouraged",
  MAY: "May — permitted",
};

/** `auth-9` before `auth-10`; the suffix is compared as a number. */
function nextId(existing: string[], prefix: string): string {
  let top = 0;
  for (const id of existing) {
    const m = new RegExp(`^${prefix}-(\\d+)`, "i").exec(id);
    if (m) top = Math.max(top, Number(m[1]));
  }
  return `${prefix}-${top + 1}`;
}

/**
 * What this sentence will decompose to, shown while it is still a sentence.
 *
 * ⛔ THE POINT OF THE WHOLE PANE. The decomposer reads the author's own markup
 * and infers nothing, so a requirement written without backticks or bold yields
 * no terms, cannot reach R2, and sits in the corpus blocked on `not-decomposed`.
 * 22 of Studio's 23 undecomposed requirements are in exactly that state and
 * nothing ever told their authors — the feedback arrived, if at all, as a
 * generated TTL hours later.
 */
function Decomposition({ text }: { text: string }) {
  const terms = useMemo(() => extract(text), [text]);
  const dropped = useMemo(() => droppedEmphasis(text), [text]);
  const note = useMemo(() => advise(text), [text]);

  if (!text.trim()) {
    return (
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        The words you mark with <Box component="code" sx={{ fontFamily: MONO }}>`backticks`</Box> or{" "}
        <b>**bold**</b> become the terms this requirement depends on. Nothing is inferred from
        the prose.
      </Typography>
    );
  }

  return (
    <>
      {terms.length > 0 ? (
        <Stack direction="row" spacing={0.75} sx={{ flexWrap: "wrap", gap: 0.75, mb: 1.5 }}>
          {terms.map((t) => (
            <Chip
              key={`${t.source}:${t.surface}`}
              size="small"
              variant="outlined"
              label={t.surface}
              sx={{ fontFamily: t.source === "code-span" ? MONO : undefined, fontSize: 11.5 }}
            />
          ))}
        </Stack>
      ) : null}

      {/* ⚠ severity is deliberately `warning`, never `error`. A requirement with
          no marked vocabulary is a legitimate thing to write down — it simply
          cannot be checked by anything yet, and refusing to record it would push
          the author to mark words they do not mean. */}
      <Alert severity={note.kind === "none" ? "warning" : note.kind === "dropped" ? "info" : "success"}
             sx={{ mb: dropped.length ? 1 : 0 }}>
        {note.message}
      </Alert>

      {dropped.length > 0 ? (
        <Box sx={{ mt: 1 }}>
          {dropped.map((d) => (
            <Typography key={d} variant="body2" sx={{ color: "text.secondary", fontSize: 12 }}>
              dropped: <b>{d}</b>
            </Typography>
          ))}
        </Box>
      ) : null}
    </>
  );
}

function ProgressStep({ n, label, done, active }: {
  n: number; label: string; done: boolean; active?: boolean;
}) {
  return (
    <Stack direction="row" spacing={1} alignItems="center">
      <Box
        sx={{
          width: 26,
          height: 26,
          borderRadius: "50%",
          display: "grid",
          placeItems: "center",
          fontFamily: MONO,
          fontSize: 11,
          fontWeight: 700,
          bgcolor: done ? "success.main" : active ? "primary.main" : "action.disabledBackground",
          color: done || active ? "primary.contrastText" : "text.secondary",
        }}
      >
        {done ? "✓" : n}
      </Box>
      <Typography sx={{ fontSize: 12.5, fontWeight: active ? 650 : 500, color: done ? "success.main" : "text.primary" }}>
        {label}
      </Typography>
    </Stack>
  );
}

export function WriteClient({ corpusReqs }: { corpusReqs: Row[] }) {
  const { data, error, refresh } = useOverlay();
  const reqs = data?.requirements ?? corpusReqs;
  const parent = data?.corpus_version ?? "";

  const projects = useMemo(() => projectsIn(corpusReqs), [corpusReqs]);
  const [project, setProject] = useState(() => openingProject(projects));

  const mine = useMemo(() => reqs.filter((r) => inProject(r, project)), [reqs, project]);
  const areas = useMemo(
    () => [...new Set(mine.map((r) => String(r["discipline"] ?? "")))].filter(Boolean).sort(),
    [mine],
  );
  const suggested = useMemo(() => {
    const ids = mine.map((r) => String(r["requirement_id"] ?? ""));
    const prefix = (ids[0] ?? "req-1").split("-")[0] || "req";
    return nextId(ids, prefix);
  }, [mine]);

  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [area, setArea] = useState("");
  const [modality, setModality] = useState("MUST");
  const [citation, setCitation] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const editor = useRef<HTMLInputElement | null>(null);

  const id = (subject.trim() || suggested).toLowerCase();
  const taken = reqs.some((r) => String(r["requirement_id"] ?? "").toLowerCase() === id);
  const discipline = area || areas[0] || "";
  const ready = Boolean(text.trim()) && Boolean(discipline) && !taken;
  const terms = useMemo(() => extract(text), [text]);
  const hasDraft = Boolean(text.trim());
  const hasDetails = hasDraft && Boolean(discipline) && !taken;

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!text.trim()) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [text]);

  function markSelection(mark: "`" | "**") {
    const input = editor.current;
    if (!input) return;
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? start;
    const selected = text.slice(start, end);
    const replacement = `${mark}${selected || (mark === "`" ? "system field" : "business term")}${mark}`;
    setText(`${text.slice(0, start)}${replacement}${text.slice(end)}`);
    requestAnimationFrame(() => {
      const selectedStart = start + mark.length;
      input.focus();
      input.setSelectionRange(selectedStart, selectedStart + (selected || replacement.slice(mark.length, -mark.length)).length);
    });
  }

  async function write() {
    setBusy(true); setErr(null); setSaved(null);
    try {
      // ⛔ rung is ALWAYS R0 and is not offered as a choice. "Rungs are evidence,
      // not intent" — `ladder-integrity.rq` refuses a hand-set rung, and
      // `decompose.py` is what promotes a claim to R2 once it can enumerate the
      // holes. A picker here would let an author assert evidence they do not
      // have, which is the same shape as a check that examined nothing.
      await submitOp("assertNS", {
        subject: id,
        text: text.trim(),
        discipline,
        rung: "R0",
        modality,
        project,
        ...(citation.trim() ? { citation: citation.trim() } : {}),
      }, parent);
      setSaved(id);
      setSubject(""); setText(""); setCitation("");
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Stack direction="row" alignItems="flex-start" spacing={2} sx={{ mb: 2.5 }}>
        <PaneHead
          title="Create a requirement"
          blurb="Capture the rule in plain language, mark the concepts it depends on, then review the proposal before recording it."
        />
        <Box sx={{ flex: 1 }} />
        <Button component={Link} href="/requirements" color="inherit" size="small" sx={{ whiteSpace: "nowrap" }}>
          Cancel
        </Button>
      </Stack>

      {error ? <OverlayError message={error} /> : null}
      {data && !data.write_enabled ? <ReadOnly because={data.write_disabled_because} /> : null}

      {saved ? (
        <Alert
          severity="success"
          sx={{ mb: 2.5 }}
          action={
            <Button component={Link} href={`/requirements/${encodeURIComponent(saved)}`} color="inherit" size="small">
              View requirement
            </Button>
          }
        >
          <b>{saved.toUpperCase()} is ready for review.</b> It was recorded as a proposal and has not
          changed the adopted spec yet.
        </Alert>
      ) : null}
      {err ? <Alert severity="error" sx={{ mb: 2 }}><b>Not recorded.</b> {err}</Alert> : null}

      <Paper variant="outlined" sx={{ px: { xs: 2, sm: 2.5 }, py: 1.5, mb: 2.5 }}>
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={{ xs: 1.25, sm: 3 }}
          divider={<Divider orientation="vertical" flexItem />}
        >
          <ProgressStep n={1} label="Write the rule" done={hasDraft} active={!hasDraft} />
          <ProgressStep n={2} label="Add project details" done={hasDetails} active={hasDraft && !hasDetails} />
          <ProgressStep n={3} label="Review & propose" done={Boolean(saved)} active={hasDetails && !saved} />
        </Stack>
      </Paper>

      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "minmax(0, 1.45fr) minmax(340px, 0.8fr)" }, gap: 2.5, alignItems: "start" }}>
        <Stack spacing={2.5}>
          <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
            <Stack direction="row" alignItems="baseline" spacing={1} sx={{ mb: 0.5 }}>
              <Typography variant="h2" sx={{ fontSize: 16 }}>1. Write the rule</Typography>
              <Typography variant="body2" sx={{ color: "text.secondary" }}>Use one testable statement.</Typography>
            </Stack>
            <Typography variant="body2" sx={{ color: "text.secondary", mb: 2 }}>
              Select an important phrase, then mark whether it names a system value or a business concept.
            </Typography>
          <TextField
            fullWidth multiline minRows={5} value={text}
            onChange={(e) => setText(e.target.value)}
            inputRef={editor}
            label="Requirement"
            placeholder="A user with `sponsor:edit` may never imply `deploy:*`."
            slotProps={{ input: { sx: { fontFamily: SERIF, fontSize: 15, lineHeight: 1.55 } } }}
            helperText={`${text.length} characters · Keep each requirement focused on one rule.`}
          />
            <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: "wrap", gap: 1 }}>
              <Button size="small" variant="outlined" onClick={() => markSelection("`")}>
                Mark system field
              </Button>
              <Button size="small" variant="outlined" onClick={() => markSelection("**")}>
                Mark business term
              </Button>
              <Typography variant="body2" sx={{ color: "text.secondary", alignSelf: "center", fontSize: 12 }}>
                {terms.length ? `${terms.length} ${terms.length === 1 ? "concept" : "concepts"} marked` : "No concepts marked yet"}
              </Typography>
            </Stack>
          </Paper>

          <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
            <Typography variant="h2" sx={{ fontSize: 16, mb: 0.5 }}>2. Add project details</Typography>
            <Typography variant="body2" sx={{ color: "text.secondary", mb: 2 }}>
              These fields make the requirement easy to route, find, and review.
            </Typography>
            <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 2 }}>
              <Box>
                <Typography component="label" sx={{ display: "block", fontSize: 12, fontWeight: 650, mb: 0.75 }}>
                  Project
                </Typography>
                <ProjectPicker projects={projects} value={project} onChange={setProject} fullWidth />
                {projects.length < 2 ? (
                  <TextField size="small" fullWidth value={project} disabled />
                ) : null}
              </Box>
              <TextField
                select size="small" fullWidth value={modality}
                onChange={(e) => setModality(String(e.target.value))}
                label="Strength"
                helperText="How strictly should this rule apply?"
              >
                {MODALITIES.map((m) => <MenuItem key={m} value={m}>{MODALITY_LABEL[m]}</MenuItem>)}
              </TextField>
              <TextField
                select size="small" fullWidth value={discipline}
                onChange={(e) => setArea(String(e.target.value))}
                label="Area"
                helperText="Who should own and review it?"
              >
                {areas.map((a) => <MenuItem key={a} value={a}>{a}</MenuItem>)}
              </TextField>
            <TextField
                size="small" fullWidth value={subject} onChange={(e) => setSubject(e.target.value)}
                label="Requirement ID" placeholder={suggested}
              error={taken}
                helperText={taken ? `${id} already exists` : `Leave blank to use ${suggested}`}
              slotProps={{ input: { sx: { fontFamily: MONO, fontSize: 13 } } }}
            />
          <TextField
            size="small" fullWidth value={citation} onChange={(e) => setCitation(e.target.value)}
                label="Source (optional)" placeholder="Policy §4.11 or decision record URL"
            slotProps={{ input: { sx: { fontFamily: MONO, fontSize: 13 } } }}
                sx={{ gridColumn: { sm: "1 / -1" } }}
          />
            </Box>
        </Paper>
        </Stack>

        <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, position: { lg: "sticky" }, top: { lg: 24 } }}>
          <Typography variant="h2" sx={{ fontSize: 16 }}>3. Review</Typography>
          <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.5, mb: 2 }}>
            This is what reviewers will receive.
          </Typography>

          <Box sx={{ p: 2, bgcolor: "action.hover", borderRadius: 1.5, mb: 2 }}>
            <Stack direction="row" spacing={1} sx={{ mb: 1, flexWrap: "wrap", gap: 0.5 }}>
              <Chip size="small" label={id.toUpperCase()} sx={{ fontFamily: MONO, fontWeight: 700 }} />
              <Chip size="small" variant="outlined" label={MODALITY_LABEL[modality]?.split(" — ")[0]} />
              {discipline ? <Chip size="small" variant="outlined" label={discipline} /> : null}
            </Stack>
            <Typography sx={{ fontFamily: SERIF, fontSize: 16, lineHeight: 1.55 }}>
              {text.trim() || "Your requirement will appear here."}
            </Typography>
          </Box>

          <Typography sx={{ fontSize: 12, fontWeight: 700, mb: 1, textTransform: "uppercase", letterSpacing: "0.06em", color: "text.secondary" }}>
            Concepts to define
          </Typography>
          <Decomposition text={text} />

          <Divider sx={{ my: 2.5 }} />
          <Button fullWidth size="large" variant="contained" disabled={busy || !ready || !data?.write_enabled} onClick={write}>
            {busy ? "Recording proposal…" : "Propose requirement"}
          </Button>
          <Typography variant="body2" sx={{ color: "text.secondary", fontSize: 12, mt: 1.25, textAlign: "center" }}>
            {!data
              ? "Checking whether proposals are enabled…"
              : taken
                ? `Choose another ID — ${id} already exists.`
                : !text.trim()
                  ? "Write the requirement to continue."
                  : !discipline
                    ? "Choose an area to continue."
                    : <>Starts as a draft proposal at <Box component="code" sx={{ fontFamily: MONO }}>R0</Box>. Nothing is adopted automatically.</>}
          </Typography>
        </Paper>
      </Box>
    </>
  );
}
