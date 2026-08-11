import { Alert, Box, Paper, Stack, Typography } from "@mui/material";
import type { Conflict, Discipline, Requirement } from "../api";
import { stateOf } from "../api";
import { Bar, PaneHead, Tile } from "../ui";
import { MONO } from "../theme";

export function Overview({
  project, reqs, disc, confs,
}: { project: string; reqs: Requirement[]; disc: Discipline[]; confs: Conflict[] }) {
  const mine = reqs.filter((r) => r.project === project);
  const byState = { Draft: 0, "In question": 0, Agreed: 0, Enforced: 0 } as Record<string, number>;
  for (const r of mine) byState[stateOf(r)] = (byState[stateOf(r)] ?? 0) + 1;
  const unchecked = mine.filter((r) => r.outcome === "NOT-EVALUATED").length;
  const areas = disc.filter((d) => d.project === project);
  const myConfs = confs.filter((c) => c.project === project);

  return (
    <Box>
      <PaneHead
        title={project}
        sub={`${mine.length} requirements across ${areas.length} areas.`}
      />

      <Stack direction="row" spacing={1.5} sx={{ mb: 3 }} flexWrap="wrap" useFlexGap>
        <Tile n={byState.Draft ?? 0} label="Draft" />
        <Tile n={byState["In question"] ?? 0} label="In question" tone="warn" />
        <Tile n={byState.Agreed ?? 0} label="Agreed" />
        <Tile n={byState.Enforced ?? 0} label="Enforced" tone={byState.Enforced ? "good" : "warn"} />
      </Stack>

      {/* The headline, stated as a risk rather than a proof-theory metric. */}
      <Alert severity={unchecked === mine.length ? "warning" : "info"} sx={{ mb: 3 }}>
        <b>{unchecked} of {mine.length} requirements are checked by nothing.</b> If one
        stopped being true tomorrow, no build would fail and nobody would be told.
      </Alert>

      <Typography variant="h2" sx={{ mb: 1.5 }}>By area</Typography>
      <Stack spacing={0}>
        {areas
          .slice()
          .sort((a, b) => b.claim_count - a.claim_count)
          .map((d) => (
            <Paper key={d.discipline} variant="outlined"
              sx={{ p: 1.5, borderRadius: 0, borderTop: 0, "&:first-of-type": { borderTop: 1, borderColor: "divider" } }}>
              <Stack direction="row" spacing={2} alignItems="center">
                <Typography sx={{ flex: 1, fontSize: 14 }}>{d.discipline}</Typography>
                <Typography sx={{ fontFamily: MONO, fontSize: 13, width: 34, textAlign: "right" }}>
                  {d.claim_count}
                </Typography>
                <Bar pct={d.dark_pct} />
                <Typography sx={{ fontFamily: MONO, fontSize: 12, width: 52, textAlign: "right", color: "text.secondary" }}>
                  {d.dark_pct}%
                </Typography>
              </Stack>
            </Paper>
          ))}
      </Stack>
      <Typography variant="body2" sx={{ color: "text.secondary", mt: 1.5 }}>
        The bar is the share not yet backed by evidence. 100% is the correct
        reading for requirements that have only ever been prose.
      </Typography>

      {myConfs.length ? (
        <>
          <Typography variant="h2" sx={{ mt: 4, mb: 1.5 }}>Needs a decision</Typography>
          <Stack spacing={1}>
            {myConfs.slice(0, 3).map((c) => (
              <Paper key={c.conflict} variant="outlined" sx={{ p: 1.5, borderLeft: 3, borderColor: "error.main" }}>
                <Typography sx={{ fontSize: 14, fontWeight: 640 }}>{c.kind || "Conflict"}</Typography>
                <Typography variant="body2" sx={{ color: "text.secondary" }}>{c.witness}</Typography>
              </Paper>
            ))}
          </Stack>
        </>
      ) : null}
    </Box>
  );
}
