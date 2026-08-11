import { Box, Divider, Paper, Stack, Typography } from "@mui/material";
import type { Requirement } from "../api";
import { stateOf } from "../api";
import { PaneHead, Promise_, StateChip } from "../ui";
import { MONO } from "../theme";

/**
 * The requirements document, generated from the requirements.
 *
 * The state column is the part a hand-written document can never carry: a
 * reader sees not just what was promised but whether anything is holding it up.
 */
export function Document({ project, reqs }: { project: string; reqs: Requirement[] }) {
  const mine = reqs.filter((r) => r.project === project);
  const areas = Array.from(new Set(mine.map((r) => r.discipline)));
  return (
    <Box>
      <PaneHead
        title="Document"
        sub="Generated from the requirements. Nobody edits this — editing it here would mean editing a requirement."
      />
      <Paper variant="outlined" sx={{ p: 4 }}>
        <Typography sx={{ fontFamily: "ui-serif, Georgia, serif", fontSize: 22, fontWeight: 700 }}>
          Authentication &amp; Authorization Requirements
        </Typography>
        <Typography sx={{ fontFamily: MONO, fontSize: 10.5, color: "text.secondary",
                          letterSpacing: ".06em", mt: 0.5 }}>
          {project.toUpperCase()} · GENERATED FROM {mine.length} REQUIREMENTS ·{" "}
          {mine.filter((r) => stateOf(r) === "Enforced").length} ENFORCED
        </Typography>
        <Divider sx={{ my: 2.5 }} />
        {areas.map((a) => (
          <Box key={a} sx={{ mb: 3 }}>
            <Typography sx={{ fontSize: 13, fontWeight: 700, mb: 1.5 }}>{a}</Typography>
            <Stack spacing={0}>
              {mine.filter((r) => r.discipline === a).map((r) => (
                <Stack key={r.requirement_id} direction="row" spacing={2} alignItems="baseline"
                       sx={{ py: 1.25, borderTop: 1, borderColor: "divider" }}>
                  <Typography sx={{ fontFamily: MONO, fontSize: 12, fontWeight: 700,
                                    color: "primary.main", minWidth: 76 }}>
                    {r.requirement_id.toUpperCase()}
                  </Typography>
                  <Box sx={{ flex: 1 }}>
                    <Promise_>{r.predicate}</Promise_>
                  </Box>
                  <StateChip state={stateOf(r)} />
                </Stack>
              ))}
            </Stack>
          </Box>
        ))}
      </Paper>
    </Box>
  );
}
