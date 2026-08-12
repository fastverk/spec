"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import { useMemo, useState } from "react";

import { STANDING_LABEL, termEntities } from "../../../../lib/entity";
import type { Row } from "../../../../lib/overlay";
import { MONO, SERIF } from "../../../theme";
import { OverlayError, ReadOnly } from "../../../ui";
import { submitOp, useOverlay } from "../../../useOverlay";

/**
 * One word, at its own address.
 *
 * ⛔ Grounding it here is the SAME op as grounding it from a requirement, and
 * that is the point of making the term an entity: `sponsor:edit` is one hole
 * whichever sentence you arrived from, so there is one page, one decision, and
 * one row in the log. The old pane let you bind the same word from a queue that
 * did not know which claims it came from.
 */
export function TermClient({ project, surface, corpusTerms, corpusReqs }: {
  project: string; surface: string; corpusTerms: Row[]; corpusReqs: Row[];
}) {
  const { data, error, refresh } = useOverlay();
  const termRows = data?.terms ?? corpusTerms;
  const reqs = data?.requirements ?? corpusReqs;
  const parent = data?.corpus_version ?? "";

  const e = useMemo(
    () => termEntities(termRows).find((t) => t.project === project && t.surface === surface) ?? null,
    [termRows, project, surface],
  );

  const [definition, setDefinition] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const predicateOf = (id: string) =>
    String(reqs.find((r) => String(r["requirement_id"] ?? "").toLowerCase() === id.toLowerCase())?.["predicate"] ?? "");

  async function act(op: string, fields: Record<string, unknown>, said: string) {
    setBusy(true); setErr(null); setNote(null);
    try {
      await submitOp(op, { project, ...fields }, parent);
      setNote(said); setDefinition(""); setReason("");
      refresh();
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  }

  if (!e) {
    return (
      <Alert severity="warning">
        <b>{surface} is not a term in {project}.</b>{" "}
        {data ? "No claim names it." : "Still reading the overlay…"}
      </Alert>
    );
  }

  // Shown, never merged. Whether `admin` and `org admins` are one term or two is
  // a judgement about the business, and a normalizer that folded them would
  // ground several words nobody looked at.
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "").replace(/s$/, "");
  const alike = termEntities(termRows)
    .filter((t) => t.project === e.project && t.surface !== e.surface && norm(t.surface) === norm(e.surface))
    .map((t) => t.surface);

  return (
    <>
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 2, flexWrap: "wrap", gap: 1 }}>
        <Typography sx={{ fontFamily: MONO, fontSize: 20, fontWeight: 700 }}>{e.surface}</Typography>
        <Chip size="small" variant="outlined" label={STANDING_LABEL[e.standing]}
              color={e.standing === "pinned" ? "success" : e.standing === "open" ? "warning" : "default"} />
        {e.pending ? (
          <Chip size="small" color="info" variant="outlined" label={`proposed by ${e.pendingBy}`} />
        ) : null}
        <Box sx={{ flex: 1 }} />
        <Button size="small" component={Link} href="/terms" color="inherit">← all terms</Button>
      </Stack>
      <Stack direction="row" spacing={1} sx={{ mb: 2.5 }}>
        <Chip size="small" variant="outlined" label={e.project} sx={{ fontSize: 10.5 }} />
        <Chip size="small" variant="outlined" label={e.source} sx={{ fontSize: 10.5, fontFamily: MONO }} />
      </Stack>

      {error ? <OverlayError message={error} /> : null}
      {data && !data.write_enabled ? <ReadOnly because={data.write_disabled_because} /> : null}
      {note ? <Alert severity="success" sx={{ mb: 2 }}><b>Recorded.</b> {note}</Alert> : null}
      {err ? <Alert severity="error" sx={{ mb: 2 }}><b>Not recorded.</b> {err}</Alert> : null}

      {e.boundTo ? (
        <Alert severity="success" sx={{ mb: 2 }}>
          Reads as <Box component="code" sx={{ fontFamily: MONO }}>{e.boundTo}</Box>.{" "}
          {/* ⛔ Said every time a binding is shown. Pointing at a population is
              not the same as having counted it, and without an adapter nothing
              here has counted anything. */}
          How many records that matches is unknown — no adapter has answered.
        </Alert>
      ) : (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <b>This word does not point at anything yet.</b> Every claim below is waiting on it, and
          none of them can be checked until it does.
        </Alert>
      )}

      {alike.length > 0 ? (
        <Alert severity="info" sx={{ mb: 2 }}>
          <b>Looks like {alike.join(", ")}.</b> Shown, never merged — whether these are one term or
          several is a judgement about the business.
        </Alert>
      ) : null}

      <Box sx={{ display: "flex", gap: 2, alignItems: "flex-start", flexWrap: "wrap" }}>
        <Paper variant="outlined" sx={{ p: 2.5, flex: "1 1 420px", minWidth: 320 }}>
          <Typography variant="h2" sx={{ fontSize: 13, mb: 1 }}>What does it point at?</Typography>
          <TextField
            fullWidth size="small" value={definition} onChange={(x) => setDefinition(x.target.value)}
            placeholder="team_memberships.role = 'deployer'"
            helperText="The stable referent in your product — what a query would actually select. Written in your own vocabulary; spec never parses it."
            slotProps={{ input: { sx: { fontFamily: MONO, fontSize: 13 } } }}
          />
          <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
            <Button size="small" variant="contained"
                    disabled={busy || !definition.trim() || !data?.write_enabled}
                    onClick={() => act("bindTerm", { term: e.surface, definition: definition.trim() },
                      `${e.surface} now means ${definition.trim()} — proposed, not yet adopted.`)}>
              Record this reading
            </Button>
          </Stack>

          <Box sx={{ mt: 3, pt: 2, borderTop: 1, borderColor: "divider" }}>
            <Typography variant="h2" sx={{ fontSize: 13, mb: 0.5 }}>Or: this is not a term</Typography>
            <Typography variant="body2" sx={{ color: "text.secondary", mb: 1 }}>
              A judgement about the decomposer&rsquo;s output, not about the business. It leaves the
              queue and stops holding these claims back.
            </Typography>
            <Stack direction="row" spacing={1}>
              <TextField size="small" value={reason} onChange={(x) => setReason(x.target.value)}
                         placeholder="why (optional)" sx={{ flex: 1 }} />
              <Button size="small" color="inherit" variant="outlined"
                      disabled={busy || !data?.write_enabled}
                      onClick={() => act("retractTerm",
                        reason.trim() ? { term: e.surface, reason: reason.trim() } : { term: e.surface },
                        `${e.surface} is not a term.`)}>
                Not a term
              </Button>
            </Stack>
          </Box>
        </Paper>

        <Paper variant="outlined" sx={{ p: 2.5, flex: "1 1 380px", minWidth: 300 }}>
          <Typography variant="h2" sx={{ fontSize: 13, mb: 1.5 }}>
            {e.claims.length} {e.claims.length === 1 ? "claim waits" : "claims wait"} on it
          </Typography>
          <Stack spacing={1.25}>
            {e.claims.map((id) => (
              <Box key={id} component={Link} href={`/requirements/${encodeURIComponent(id)}`}
                   sx={{ textDecoration: "none", color: "inherit", display: "block",
                         "&:hover .p": { color: "primary.main" } }}>
                <Typography sx={{ fontFamily: MONO, fontSize: 11.5, fontWeight: 700, color: "primary.main" }}>
                  {id.toUpperCase()}
                </Typography>
                <Typography className="p" sx={{ fontFamily: SERIF, fontSize: 13.5, lineHeight: 1.45 }}>
                  {predicateOf(id).replace(/[`*]/g, "") || "—"}
                </Typography>
              </Box>
            ))}
          </Stack>
        </Paper>
      </Box>
    </>
  );
}
