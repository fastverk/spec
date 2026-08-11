"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useMemo, useState } from "react";

import type { Row } from "../../lib/overlay";
import { MONO, SERIF } from "../theme";
import { OverlayError, PaneHead, ReadOnly } from "../ui";
import { submitOp, useOverlay } from "../useOverlay";

type Hole = {
  surface: string;
  project: string;
  claims: string[];
  boundTo: string;
  pending: boolean;
  pendingBy: string;
  retracted: boolean;
};

/**
 * The queue: one entry per distinct surface, ordered by how many claims wait on it.
 *
 * ⛔ Terms cleared as "not a term" LEAVE the queue. Decomposition is machine work
 * that can be wrong — it pulled `or`, `act` and `rule, not rows` into Studio's
 * queue beside `sponsor:edit` — and without a way to clear those the queue fills
 * with noise people learn to ignore.
 */
function holesOf(rows: Row[]): Hole[] {
  const by = new Map<string, Hole>();
  const dropped = new Set(
    rows.filter((t) => t["retired"] || t["retracted"]).map((t) => String(t["surface"])),
  );
  for (const t of rows) {
    const surface = String(t["surface"] ?? "");
    if (!surface || dropped.has(surface)) continue;
    const key = `${String(t["project"] ?? "")} ${surface}`;
    const h = by.get(key) ?? {
      surface, project: String(t["project"] ?? ""), claims: [],
      boundTo: "", pending: false, pendingBy: "", retracted: false,
    };
    h.claims.push(String(t["requirement_id"] ?? ""));
    if (t["bound_to"]) h.boundTo = String(t["bound_to"]);
    if (t["pending"]) { h.pending = true; h.pendingBy = String(t["pending_by"] ?? ""); }
    by.set(key, h);
  }
  return [...by.values()].sort(
    (a, b) => b.claims.length - a.claims.length || a.surface.localeCompare(b.surface),
  );
}

/**
 * ⚠ Shown, never merged. The document writes `admin`, `org admin`, `org admins`
 * and `platform admin`; whether those are one term or five is a judgement about
 * the business, and a normalizer that quietly folded them would ground four terms
 * nobody looked at.
 */
function lookalikes(hole: Hole, all: Hole[]): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "").replace(/s$/, "");
  const k = norm(hole.surface);
  return all.filter((h) => h.surface !== hole.surface && norm(h.surface) === k).map((h) => h.surface);
}

export function GroundingClient({ corpusTerms, corpusReqs }: { corpusTerms: Row[]; corpusReqs: Row[] }) {
  const { data, error, refresh } = useOverlay();
  const [picked, setPicked] = useState<string | null>(null);
  const [definition, setDefinition] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const termRows = data?.terms ?? corpusTerms;
  const parent = data?.corpus_version ?? "";
  const holes = useMemo(() => holesOf(termRows), [termRows]);
  const hole = holes.find((h) => `${h.project} ${h.surface}` === picked) ?? holes[0] ?? null;
  const predicateOf = (id: string) =>
    String(corpusReqs.find((r) => r["requirement_id"] === id)?.["predicate"] ?? "");

  async function act(op: string, fields: Record<string, unknown>, said: string) {
    if (!hole) return;
    setBusy(true); setErr(null); setNote(null);
    try {
      await submitOp(op, { project: hole.project, ...fields }, parent);
      setNote(said); setDefinition(""); setReason("");
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const open = holes.filter((h) => !h.boundTo);
  const alike = hole ? lookalikes(hole, holes) : [];

  return (
    <>
      <PaneHead
        title="Grounding"
        blurb="Which real records a word points at. This is the one step that needs a person: everything else in the pipeline is derivable, and this is a judgement about the business."
      />

      {error ? <OverlayError message={error} /> : null}
      {data && !data.write_enabled ? <ReadOnly because={data.write_disabled_because} /> : null}

      <Alert severity="info" sx={{ mb: 2 }}>
        <b>No grounding adapter is answering.</b> Candidate readings and their record counts come
        from the project&rsquo;s own environment — spec never queries a project database. Without it
        you can still record what a term means; you just cannot yet see how many records that
        would examine. A missing answer, which is not the same as an empty one.
      </Alert>

      <Box sx={{ display: "flex", gap: 2, alignItems: "flex-start" }}>
        <Paper variant="outlined" sx={{ width: 280, flexShrink: 0, maxHeight: "70vh", overflowY: "auto" }}>
          <Typography sx={{ p: 1.5, pb: 0.5, fontSize: 11, fontWeight: 700, letterSpacing: "0.06em",
                            textTransform: "uppercase", color: "text.secondary" }}>
            {open.length} not pinned down · {holes.length} total
          </Typography>
          <List dense disablePadding>
            {holes.map((h) => {
              const key = `${h.project} ${h.surface}`;
              return (
                <ListItemButton key={key} selected={hole ? key === `${hole.project} ${hole.surface}` : false}
                                onClick={() => { setPicked(key); setNote(null); setErr(null); }}>
                  <ListItemText
                    primary={h.surface}
                    secondary={`${h.claims.length} ${h.claims.length === 1 ? "claim" : "claims"}${h.boundTo ? " · pinned down" : ""}`}
                    primaryTypographyProps={{ fontFamily: MONO, fontSize: 12.5 }}
                    secondaryTypographyProps={{ fontSize: 11 }}
                  />
                  {h.pending ? <Chip size="small" color="info" variant="outlined" label="proposed" sx={{ fontSize: 9.5 }} /> : null}
                </ListItemButton>
              );
            })}
          </List>
        </Paper>

        <Box sx={{ flex: 1, minWidth: 0 }}>
          {!hole ? (
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              No terms in the corpus.
            </Typography>
          ) : (
            <>
              <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1 }}>
                <Typography sx={{ fontFamily: MONO, fontSize: 16, fontWeight: 700 }}>{hole.surface}</Typography>
                <Chip size="small" variant="outlined" label={hole.project} sx={{ fontSize: 10.5 }} />
                {hole.boundTo ? (
                  <Chip size="small" color="success" variant="outlined"
                        label={hole.pending ? `proposed by ${hole.pendingBy}` : "pinned down"} sx={{ fontSize: 10.5 }} />
                ) : null}
              </Stack>

              {note ? <Alert severity="success" sx={{ mb: 2 }}><b>Recorded.</b> {note}</Alert> : null}
              {err ? <Alert severity="error" sx={{ mb: 2 }}><b>Not recorded.</b> {err}</Alert> : null}

              {hole.boundTo ? (
                <Alert severity="success" sx={{ mb: 2 }}>
                  Currently reads as <Box component="code" sx={{ fontFamily: MONO }}>{hole.boundTo}</Box>
                </Alert>
              ) : null}

              {alike.length > 0 ? (
                <Alert severity="warning" sx={{ mb: 2 }}>
                  <b>Looks like {alike.join(", ")}.</b> Shown, never merged — whether these are one
                  term or several is a judgement about the business.
                  {data?.write_enabled ? (
                    <Box sx={{ mt: 1 }}>
                      {alike.map((other) => (
                        <Button key={other} size="small" disabled={busy} sx={{ mr: 1 }}
                                onClick={() => act("alignTerm", { term: hole.surface, aligns_to: other },
                                  `${hole.surface} is the same term as ${other}`)}>
                          Same as {other}
                        </Button>
                      ))}
                    </Box>
                  ) : null}
                </Alert>
              ) : null}

              <Typography variant="h2" sx={{ fontSize: 13, mb: 0.5 }}>
                A claim that waits on it
              </Typography>
              <Typography sx={{ fontFamily: SERIF, fontSize: 15, lineHeight: 1.5, mb: 2.5 }}>
                {predicateOf(hole.claims[0] ?? "").replace(/[`*]/g, "") || "—"}
              </Typography>

              {data?.write_enabled ? (
                <Paper variant="outlined" sx={{ p: 2 }}>
                  <Typography variant="h2" sx={{ fontSize: 13, mb: 1 }}>What does it point at?</Typography>
                  <TextField
                    fullWidth size="small" value={definition} onChange={(e) => setDefinition(e.target.value)}
                    placeholder="team_memberships.role='deployer'"
                    helperText="The stable referent in the product — what a query would actually select."
                    slotProps={{ input: { sx: { fontFamily: MONO, fontSize: 13 } } }}
                  />
                  <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
                    <Button variant="contained" size="small" disabled={busy || !definition.trim()}
                            onClick={() => act("bindTerm", { term: hole.surface, definition: definition.trim() },
                              `${hole.surface} now means ${definition.trim()}`)}>
                      Record this reading
                    </Button>
                  </Stack>

                  <Box sx={{ mt: 3, pt: 2, borderTop: 1, borderColor: "divider" }}>
                    <Typography variant="h2" sx={{ fontSize: 13, mb: 0.5 }}>Or: this is not a term</Typography>
                    <Typography variant="body2" sx={{ color: "text.secondary", mb: 1 }}>
                      A judgement about the decomposer&rsquo;s output, not about the business. It leaves the queue.
                    </Typography>
                    <Stack direction="row" spacing={1}>
                      <TextField size="small" value={reason} onChange={(e) => setReason(e.target.value)}
                                 placeholder="why (optional)" sx={{ flex: 1 }} />
                      <Button size="small" color="inherit" variant="outlined" disabled={busy}
                              onClick={() => act("retractTerm",
                                reason.trim() ? { term: hole.surface, reason: reason.trim() } : { term: hole.surface },
                                `${hole.surface} is not a term`)}>
                        Not a term
                      </Button>
                    </Stack>
                  </Box>
                </Paper>
              ) : null}
            </>
          )}
        </Box>
      </Box>
    </>
  );
}
