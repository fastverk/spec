import { Box, Paper, Stack, Typography } from "@mui/material";
import type { Conflict } from "../api";
import { NotBackedYet, PaneHead } from "../ui";
import { MONO } from "../theme";

export function Conflicts({ project, confs }: { project: string; confs: Conflict[] }) {
  const mine = confs.filter((c) => c.project === project);
  return (
    <Box>
      <PaneHead
        title="Conflicts"
        sub="Two requirements that cannot both hold. Once they are propositions rather than prose this is decidable, so it fails at authoring time instead of in production."
      />
      {mine.length === 0 ? (
        <NotBackedYet
          what="Conflict detection for this project"
          needs={
            <>Conflicts are found by comparing typed claims. Every requirement here
            is still prose at R0 — nothing has been decomposed into something two
            claims can disagree about, so the detector has nothing to compare.</>
          }
        />
      ) : (
        <Stack spacing={1.5}>
          {mine.map((c) => (
            <Paper key={c.conflict} variant="outlined"
                   sx={{ p: 2, borderLeft: 3, borderColor: "error.main" }}>
              <Stack direction="row" spacing={1.5} alignItems="baseline">
                <Typography sx={{ fontSize: 15, fontWeight: 660 }}>{c.kind || "Conflict"}</Typography>
                <Typography sx={{ fontFamily: MONO, fontSize: 11.5, color: "text.secondary" }}>
                  {c.parties}
                </Typography>
              </Stack>
              {c.witness ? (
                <Typography variant="body2" sx={{ mt: 1, maxWidth: "72ch" }}>{c.witness}</Typography>
              ) : null}
              <Typography variant="body2" sx={{ mt: 1, color: "text.secondary" }}>
                {c.owner ? `Owner: ${c.owner}` : "No owner assigned — cannot be acted on"}
                {c.resolution ? ` · ${c.resolution}` : ""}
              </Typography>
            </Paper>
          ))}
        </Stack>
      )}
    </Box>
  );
}
