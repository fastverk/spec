import { useEffect, useState } from "react";
import { Alert, Box, Chip, Paper, Stack, Typography } from "@mui/material";
import * as api from "../api";
import type { Proposal } from "../api";
import { PaneHead } from "../ui";
import { MONO } from "../theme";

/**
 * Everything proposed and not yet adopted.
 *
 * An append-only log with no way to read it is just a file. This is the answer
 * to "who decided this, and is it in force yet" — the question the whole
 * proposal design exists to keep answerable.
 *
 * ⚠ Nothing here is in force. These rows are waiting for promotion into the TTL
 * the gates run over, which is a deliberate act — the same shape as a merge.
 */
const WHAT: Record<string, { verb: string; hint: string }> = {
  bindTerm: { verb: "means", hint: "A term was bound to a set of records." },
  alignTerm: { verb: "is the same as", hint: "Two surfaces were declared one term." },
  retractTerm: { verb: "is not a term", hint: "A bad extraction was cleared from the queue." },
  amendNS: { verb: "reworded to", hint: "A requirement's wording or placement changed." },
  retractNS: { verb: "withdrawn", hint: "A requirement was proposed for removal." },
  assertNS: { verb: "written", hint: "A requirement that is not in the source document." },
};

export function Proposals({ project }: { project: string }) {
  const [rows, setRows] = useState<Proposal[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .proposals()
      .then((d) => {
        setRows(d.proposals ?? []);
        setEnabled(d.write_enabled ?? false);
      })
      .catch((e) => setErr(String(e)));
  }, []);

  // A proposal with no project applies everywhere, so it belongs in every view.
  const mine = rows.filter((r) => !r.project || r.project === project);
  // ⛔ Waiting means "not yet in the corpus", not "in the log". The log keeps
  // every proposal forever; counting rows would report work as outstanding
  // permanently, and the count would never go down however much got adopted.
  const waiting = mine.filter((r) => !r.adopted);

  return (
    <Box>
      <PaneHead
        title="Proposals"
        sub="Decisions people have made that are not yet in the specification. Every one is recorded with its author against the corpus they were looking at."
      />

      {err ? <Alert severity="error" sx={{ mb: 2 }}>{err}</Alert> : null}

      {!enabled ? (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <b>This instance is read-only.</b> <code>SPEC_PROPOSAL_LOG</code> is
          unset, so nothing can be proposed here — the buttons elsewhere will
          refuse rather than appear to work.
        </Alert>
      ) : null}

      {mine.length ? (
        <>
          <Alert severity={waiting.length ? "info" : "success"} sx={{ mb: 2 }}>
            {waiting.length ? (
              <>
                <b>{waiting.length} of {mine.length} waiting to be adopted.</b> Those
                show as “proposed” wherever they appear and change nothing until
                promoted into the corpus — the step the gates then check.
              </>
            ) : (
              <>
                <b>All {mine.length} adopted.</b> Every decision here is in the
                specification the gates run over. They stay listed because the log
                is never rewritten.
              </>
            )}
          </Alert>

          <Stack spacing={0}>
            {mine.map((r, i) => {
              const w = WHAT[r.kind] ?? { verb: r.kind, hint: "" };
              return (
                <Paper key={`${r.kind}-${r.subject}-${i}`} variant="outlined"
                       sx={{ p: 1.75, borderRadius: 0, borderTop: i ? 0 : 1 }}>
                  <Stack direction="row" spacing={2} alignItems="baseline">
                    <Chip size="small" variant="outlined" label={r.kind}
                          sx={{ fontFamily: MONO, fontSize: 11 }} />
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography sx={{ fontSize: 13.5 }}>
                        <Box component="span" sx={{ fontFamily: MONO, fontWeight: 650 }}>
                          {r.subject}
                        </Box>{" "}
                        {w.verb}
                        {r.detail ? (
                          <>
                            {" "}
                            <Box component="span" sx={{ fontFamily: MONO }}>{r.detail}</Box>
                          </>
                        ) : null}
                      </Typography>
                      <Typography variant="body2" sx={{ color: "text.secondary", fontSize: 11.5 }}>
                        {w.hint}
                      </Typography>
                    </Box>
                    <Chip size="small" variant={r.adopted ? "filled" : "outlined"}
                          color={r.adopted ? "success" : "info"}
                          label={r.adopted ? "adopted" : "waiting"}
                          sx={{ fontSize: 10.5 }} />
                    <Typography variant="body2" sx={{ color: "text.secondary", whiteSpace: "nowrap" }}>
                      {r.author}
                    </Typography>
                  </Stack>
                </Paper>
              );
            })}
          </Stack>

          <Typography variant="body2" sx={{ color: "text.secondary", mt: 2, maxWidth: "72ch" }}>
            Adopt them with{" "}
            <Box component="span" sx={{ fontFamily: MONO, fontSize: 12 }}>
              tools/proposals/materialize.py
            </Box>
            , which writes them into the corpus the gates run over. The log itself
            is never rewritten: a proposal that turns out to be wrong is answered
            by another proposal, not by erasing it.
          </Typography>
        </>
      ) : (
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          Nothing is waiting. Everything anyone has proposed for {project} has
          been adopted into the specification.
        </Typography>
      )}
    </Box>
  );
}
