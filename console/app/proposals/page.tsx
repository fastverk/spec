"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import { MONO } from "../theme";
import { NotBackedYet, OverlayError, PaneHead, ReadOnly } from "../ui";
import { useOverlay } from "../useOverlay";

const WHAT: Record<string, string> = {
  bindTerm: "bound",
  alignTerm: "aligned",
  retractTerm: "cleared",
  amendNS: "reworded",
  retractNS: "withdrew",
  assertNS: "wrote",
};

export default function Page() {
  const { data, error, loading } = useOverlay();
  const rows = data?.proposals ?? [];
  const waiting = rows.filter((r) => !r["adopted"]).length;

  return (
    <>
      <PaneHead
        title="Proposals"
        blurb="What has been decided, and whether the corpus has caught up yet. Promotion is a deliberate step: between someone clicking a button and the specification changing there is a diff a person can read, and gates that run over the result."
      />

      {error ? <OverlayError message={error} /> : null}
      {data && !data.write_enabled ? <ReadOnly because={data.write_disabled_because} /> : null}

      {data ? (
        <Alert severity="info" sx={{ mb: 2 }}>
          <b>{data.records} {data.records === 1 ? "record" : "records"} in the log, {waiting} waiting to be adopted.</b>{" "}
          Adopt with <Box component="code" sx={{ fontFamily: MONO }}>tools/proposals/materialize.py</Box>,
          then re-run the emitter and the gates.
          {" "}Waiting means <i>differs from the corpus</i>, never <i>is in the log</i> — the log keeps
          everything forever, so counting rows would report work that landed an hour ago as still waiting.
        </Alert>
      ) : null}

      {!loading && rows.length === 0 ? (
        <NotBackedYet what="Nothing has been proposed yet. Bind a term or reword a requirement and it will appear here." />
      ) : null}

      <Stack spacing={0.75}>
        {rows.map((r, i) => (
          <Paper key={i} variant="outlined" sx={{ p: 1.5 }}>
            <Stack direction="row" spacing={1.5} alignItems="baseline">
              <Typography sx={{ fontSize: 12, minWidth: 78, color: "text.secondary" }}>
                {WHAT[String(r["kind"])] ?? String(r["kind"])}
              </Typography>
              <Typography sx={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 700, minWidth: 150 }}>
                {String(r["subject"] ?? "")}
              </Typography>
              <Typography sx={{ flex: 1, fontSize: 13, color: "text.secondary" }}>
                {String(r["detail"] ?? "")}
              </Typography>
              <Typography sx={{ fontSize: 11.5, color: "text.secondary" }}>{String(r["author"] ?? "")}</Typography>
              <Chip size="small" variant={r["adopted"] ? "filled" : "outlined"}
                    color={r["adopted"] ? "success" : "info"} sx={{ fontSize: 10 }}
                    label={r["adopted"] ? "adopted" : "waiting"} />
            </Stack>
          </Paper>
        ))}
      </Stack>
    </>
  );
}
