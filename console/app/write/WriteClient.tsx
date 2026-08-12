"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useMemo, useState } from "react";

import { advise, droppedEmphasis, extract } from "../../lib/decompose";
import type { Row } from "../../lib/overlay";
import { inProject, openingProject, projectsIn } from "../../lib/project";
import { MONO, SERIF } from "../theme";
import { OverlayError, PaneHead, ProjectPicker, ReadOnly } from "../ui";
import { submitOp, useOverlay } from "../useOverlay";

const MODALITIES = ["MUST", "MUST_NOT", "SHOULD", "SHOULD_NOT", "MAY"];

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

  const id = (subject.trim() || suggested).toLowerCase();
  const taken = reqs.some((r) => String(r["requirement_id"] ?? "").toLowerCase() === id);
  const discipline = area || areas[0] || "";
  const ready = Boolean(text.trim()) && Boolean(discipline) && !taken;

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
      <PaneHead
        title="Write"
        blurb="A new requirement, recorded as a proposal against the read point you are looking at. Nothing is edited in place and nothing is adopted by writing it — this adds a sentence to the pile a person still has to promote."
      />

      {error ? <OverlayError message={error} /> : null}
      {data && !data.write_enabled ? <ReadOnly because={data.write_disabled_because} /> : null}

      <ProjectPicker projects={projects} value={project} onChange={setProject} />

      {saved ? (
        <Alert severity="success" sx={{ mb: 2 }}>
          <b>{saved.toUpperCase()} recorded</b> as a proposal under your name, against {parent}. It
          is pending until someone promotes it — it is not in the corpus yet, and the Requirements
          pane will show it marked as proposed.
        </Alert>
      ) : null}
      {err ? <Alert severity="error" sx={{ mb: 2 }}><b>Not recorded.</b> {err}</Alert> : null}

      <Box sx={{ display: "flex", gap: 2, alignItems: "flex-start", flexWrap: "wrap" }}>
        <Paper variant="outlined" sx={{ p: 2.5, flex: "1 1 520px", minWidth: 340 }}>
          <TextField
            fullWidth multiline minRows={5} value={text}
            onChange={(e) => setText(e.target.value)}
            label="What this requirement says"
            placeholder="A user with `sponsor:edit` may never imply `deploy:*`."
            slotProps={{ input: { sx: { fontFamily: SERIF, fontSize: 15, lineHeight: 1.55 } } }}
            helperText="Mark the words that carry weight. That markup is the whole input to decomposition — nothing is inferred."
          />

          <Stack direction="row" spacing={2} sx={{ mt: 2, flexWrap: "wrap", gap: 1.5 }}>
            <TextField
              size="small" value={subject} onChange={(e) => setSubject(e.target.value)}
              label="Id" placeholder={suggested}
              error={taken}
              helperText={taken ? `${id} already exists` : `defaults to ${suggested}`}
              slotProps={{ input: { sx: { fontFamily: MONO, fontSize: 13 } } }}
              sx={{ width: 180 }}
            />
            <Select size="small" value={modality} onChange={(e) => setModality(String(e.target.value))}
                    sx={{ minWidth: 150, fontFamily: MONO, fontSize: 13, height: 40 }}>
              {MODALITIES.map((m) => (
                <MenuItem key={m} value={m} sx={{ fontFamily: MONO, fontSize: 13 }}>{m}</MenuItem>
              ))}
            </Select>
            <Select size="small" value={discipline} displayEmpty
                    onChange={(e) => setArea(String(e.target.value))}
                    sx={{ minWidth: 240, fontSize: 13, height: 40 }}>
              {areas.map((a) => <MenuItem key={a} value={a} sx={{ fontSize: 13 }}>{a}</MenuItem>)}
            </Select>
          </Stack>

          <TextField
            size="small" fullWidth value={citation} onChange={(e) => setCitation(e.target.value)}
            label="Where this comes from (optional)" placeholder="§4.11"
            sx={{ mt: 2 }}
            slotProps={{ input: { sx: { fontFamily: MONO, fontSize: 13 } } }}
          />

          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mt: 2.5 }}>
            <Button variant="contained" disabled={busy || !ready || !data?.write_enabled}
                    onClick={write}>
              Propose this requirement
            </Button>
            {/* A disabled control with no stated reason is the same defect as an
                empty pane with no stated reason: the reader cannot tell "not yet"
                from "not ever". `data` is null only while the overlay is in
                flight, and that is a different fact from writes being off. */}
            <Typography variant="body2" sx={{ color: "text.secondary", fontSize: 12 }}>
              {!data
                ? "Checking whether writes are enabled…"
                : taken
                  ? `${id} is taken — an id names one claim, and reusing it would silently shadow the original.`
                  : null}
              {data && !taken ? (
                <>
                  Enters at <Box component="code" sx={{ fontFamily: MONO }}>R0</Box> — a rung is
                  evidence, not a choice.
                </>
              ) : null}
            </Typography>
          </Stack>
        </Paper>

        <Paper variant="outlined" sx={{ p: 2.5, flex: "1 1 340px", minWidth: 300 }}>
          <Typography variant="h2" sx={{ fontSize: 13, mb: 1.5 }}>
            What this decomposes to
          </Typography>
          <Decomposition text={text} />
        </Paper>
      </Box>
    </>
  );
}
