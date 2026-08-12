"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import { useMemo, useState } from "react";

import { measurement, stateOf } from "../../../lib/evaluated";
import { groundingOf, type TermStanding } from "../../../lib/grounded";
import type { Row } from "../../../lib/overlay";
import { MONO } from "../../theme";
import { OverlayError, ReadOnly, StateChip } from "../../ui";
import { submitOp, useOverlay } from "../../useOverlay";
import { Predicate, PredicateLegend } from "./Predicate";

/**
 * One step of the grounding walkthrough: a single word, and the decision it is
 * waiting on.
 *
 * ⛔ The decision offered is "what does this point at", never "does the claim
 * hold". Binding names a referent; it does not measure one and does not decide a
 * predicate. There is no field here that takes a count, because the count comes
 * from the project's own environment or it does not exist.
 */
function Step({ term, project, parent, writeEnabled, ready, onDone }: {
  term: TermStanding; project: string; parent: string;
  writeEnabled: boolean;
  /** The overlay has answered. Distinguishes "writes are off" from "still asking". */
  ready: boolean;
  onDone: () => void;
}) {
  const [definition, setDefinition] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function act(op: string, fields: Record<string, unknown>, said: string) {
    setBusy(true); setErr(null); setNote(null);
    try {
      await submitOp(op, { project, ...fields }, parent);
      setNote(said); setDefinition(""); setReason("");
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 1.5 }}>
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1 }}>
        <Typography sx={{ fontFamily: MONO, fontSize: 14, fontWeight: 700 }}>{term.surface}</Typography>
        {term.alsoBlocks > 0 ? (
          <Chip
            size="small" variant="outlined" sx={{ fontSize: 10.5 }}
            label={`also blocks ${term.alsoBlocks} other ${term.alsoBlocks === 1 ? "claim" : "claims"}`}
          />
        ) : null}
        {term.pending ? (
          <Chip size="small" color="info" variant="outlined" sx={{ fontSize: 10.5 }}
                label={`proposed by ${term.pendingBy}`} />
        ) : null}
      </Stack>

      {/* The leverage, said out loud. Grounding is shared work: one binding can
          resolve this word everywhere it appears, and a person deciding whether
          it is worth the thought deserves to know that. */}
      {term.alsoBlocks > 0 ? (
        <Typography variant="body2" sx={{ color: "text.secondary", mb: 1.5, fontSize: 12.5 }}>
          Deciding this once settles it for every claim that uses the word.
        </Typography>
      ) : null}

      {note ? <Alert severity="success" sx={{ mb: 1.5 }}>{note}</Alert> : null}
      {err ? <Alert severity="error" sx={{ mb: 1.5 }}><b>Not recorded.</b> {err}</Alert> : null}

      {/* A control that is absent with no stated reason reads as "not possible"
          rather than "not yet". `data` is null only while the overlay is in
          flight, which is a different fact from writes being disabled — and the
          ReadOnly banner only covers the second. */}
      {!writeEnabled && !ready ? (
        <Typography variant="body2" sx={{ color: "text.secondary", fontSize: 12.5 }}>
          Checking whether writes are enabled…
        </Typography>
      ) : null}

      {writeEnabled ? (
        <>
          <TextField
            fullWidth size="small" value={definition} onChange={(e) => setDefinition(e.target.value)}
            placeholder="team_memberships.role = 'deployer'"
            label="What does it point at?"
            helperText="The stable referent in the product — what a query would actually select. Written in your project's own vocabulary; spec never parses it."
            slotProps={{ input: { sx: { fontFamily: MONO, fontSize: 13 } } }}
          />
          <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: "wrap", gap: 1 }}>
            <Button size="small" variant="contained" disabled={busy || !definition.trim()}
                    onClick={() => act("bindTerm", { term: term.surface, definition: definition.trim() },
                      `${term.surface} now means ${definition.trim()} — proposed, not yet adopted.`)}>
              Record this reading
            </Button>
            <TextField size="small" value={reason} onChange={(e) => setReason(e.target.value)}
                       placeholder="why (optional)" sx={{ width: 200 }} />
            <Button size="small" color="inherit" variant="outlined" disabled={busy}
                    onClick={() => act("retractTerm",
                      reason.trim() ? { term: term.surface, reason: reason.trim() } : { term: term.surface },
                      `${term.surface} is not a term — it leaves the queue.`)}>
              Not a term
            </Button>
          </Stack>
        </>
      ) : null}
    </Paper>
  );
}

export function RequirementClient({ id, corpusReqs, corpusTerms }: {
  id: string; corpusReqs: Row[]; corpusTerms: Row[];
}) {
  const { data, error, refresh } = useOverlay();
  const reqs = data?.requirements ?? corpusReqs;
  const termRows = data?.terms ?? corpusTerms;
  const parent = data?.corpus_version ?? "";

  const req = useMemo(
    () => reqs.find((r) => String(r["requirement_id"] ?? "").toLowerCase() === id.toLowerCase()) ?? null,
    [reqs, id],
  );
  const g = useMemo(() => groundingOf(id, termRows), [id, termRows]);

  if (!req) {
    // ⚠ "Not in this corpus" is a different fact from "does not exist", and the
    // overlay may simply not have answered yet. Both are said.
    return (
      <Alert severity="warning">
        <b>{id.toUpperCase()} is not in this corpus.</b>{" "}
        {data ? "No claim with that id, and no pending proposal asserting one." : "Still reading the overlay…"}
      </Alert>
    );
  }

  const project = String(req["project"] ?? "");
  const text = String(req["predicate"] ?? "");
  const meas = measurement(req);
  const pct = g.live.length ? Math.round((g.bound / g.live.length) * 100) : 0;

  return (
    <>
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 0.5, flexWrap: "wrap", gap: 1 }}>
        <Typography sx={{ fontFamily: MONO, fontSize: 20, fontWeight: 700 }}>
          {id.toUpperCase()}
        </Typography>
        <StateChip state={stateOf(req)} />
        {req["pending"] ? (
          <Chip size="small" color="info" variant="outlined" label="proposed" sx={{ fontSize: 10.5 }} />
        ) : null}
        <Box sx={{ flex: 1 }} />
        <Button size="small" component={Link} href="/requirements" color="inherit">
          ← all requirements
        </Button>
      </Stack>
      <Stack direction="row" spacing={1} sx={{ mb: 2.5, flexWrap: "wrap", gap: 0.75 }}>
        <Chip size="small" variant="outlined" label={project} sx={{ fontSize: 10.5 }} />
        <Chip size="small" variant="outlined" label={String(req["discipline"] ?? "")} sx={{ fontSize: 10.5 }} />
        <Chip size="small" variant="outlined" sx={{ fontFamily: MONO, fontSize: 10.5 }}
              label={String(req["modality"] ?? "").replace("_", " ")} />
      </Stack>

      {error ? <OverlayError message={error} /> : null}
      {data && !data.write_enabled ? <ReadOnly because={data.write_disabled_because} /> : null}

      <Paper variant="outlined" sx={{ p: { xs: 2.5, sm: 3.5 }, mb: 2.5 }}>
        <Predicate text={text} standings={g.terms} />
        <PredicateLegend />
      </Paper>

      {/* ── the simple status ─────────────────────────────────────────────── */}
      <Paper variant="outlined" sx={{ p: 2.5, mb: 2.5 }}>
        <Stack direction="row" spacing={1.5} alignItems="baseline" sx={{ mb: 1 }}>
          <Typography variant="h2" sx={{ fontSize: 15 }}>{g.label}</Typography>
          <Box sx={{ flex: 1 }} />
          {g.live.length > 0 ? (
            <Typography sx={{ fontFamily: MONO, fontSize: 12, color: "text.secondary" }}>
              {g.bound}/{g.live.length}
            </Typography>
          ) : null}
        </Stack>
        {g.live.length > 0 ? (
          <LinearProgress
            variant="determinate" value={pct}
            color={g.state === "grounded" ? "success" : "warning"}
            sx={{ height: 6, borderRadius: 3, mb: 1.5 }}
          />
        ) : null}
        <Typography variant="body2" sx={{ color: "text.secondary" }}>{g.hint}</Typography>

        {/* ⛔ The measurement is reported SEPARATELY from the grounding, because
            they are different facts and the whole product exists to keep them
            apart. A requirement can be fully grounded and examine nothing. */}
        <Box sx={{ mt: 2, pt: 2, borderTop: 1, borderColor: "divider" }}>
          <Typography variant="h2" sx={{ fontSize: 13, mb: 0.5 }}>Has anything checked it?</Typography>
          {meas ? (
            <Stack direction="row" spacing={1} alignItems="center">
              <Chip size="small" label={meas.label}
                    color={meas.tone === "bad" ? "error" : meas.tone === "warn" ? "warning" : "success"} />
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                {String(req["outcome"] ?? "")} over {String(req["population"] ?? "")} records.
              </Typography>
            </Stack>
          ) : (
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              <b>No.</b> No measurement has ever run against this, so nothing is known about whether
              it holds — which is different from knowing it fails, and different again from
              examining zero records.
            </Typography>
          )}
        </Box>

        {/* The stale-blocker disclosure. Two answers exist and they disagree by
            construction until RFC-004 §5 lands; saying so beats quietly picking. */}
        {String(req["blocked_on"] ?? "") && g.state === "grounded" ? (
          <Alert severity="info" sx={{ mt: 2 }}>
            The corpus still records this as blocked on{" "}
            <Box component="code" sx={{ fontFamily: MONO }}>{String(req["blocked_on"])}</Box>. That
            string is written once at import and never recomputed, so it does not yet know about
            bindings made here. The count above is the live answer.
          </Alert>
        ) : null}
      </Paper>

      {/* ── the walkthrough ───────────────────────────────────────────────── */}
      {g.open.length > 0 ? (
        <>
          <Typography variant="h2" sx={{ fontSize: 15, mb: 0.5 }}>
            What it is waiting on
          </Typography>
          <Typography variant="body2" sx={{ color: "text.secondary", mb: 2 }}>
            One decision per word. Each is a judgement about your business — which real records the
            word refers to — and it is the one step in this pipeline a machine is not qualified to
            make on its own.
          </Typography>

          <Alert severity="info" sx={{ mb: 2 }}>
            <b>No grounding adapter is answering.</b> Candidate readings and their record counts come
            from the project&rsquo;s own environment — spec never queries a project database. You can
            still record what a word means; you just cannot yet see how many records that would
            examine. A missing answer, which is not the same as an empty one.
          </Alert>

          {g.open.map((t) => (
            <Step key={t.surface} term={t} project={project} parent={parent}
                  writeEnabled={Boolean(data?.write_enabled)} ready={Boolean(data)}
                  onDone={refresh} />
          ))}
        </>
      ) : null}

      {g.state === "not-decomposed" ? (
        <Alert severity="warning">
          <b>Nothing has read this for the words that carry weight.</b> Decomposition reads the
          author&rsquo;s own <Box component="code" sx={{ fontFamily: MONO }}>`code spans`</Box> and{" "}
          <b>**emphasis**</b> and infers nothing from prose. Rewording it with the load-bearing
          words marked is what gives it terms.
        </Alert>
      ) : null}
    </>
  );
}
