import { Box, Chip, Paper, Table, TableBody, TableCell, TableHead, TableRow, Typography } from "@mui/material";
import type { Spec } from "../api";
import { PaneHead } from "../ui";
import { MONO } from "../theme";

/**
 * The formal specifications that exist across the estate.
 *
 * Deliberately does NOT claim any of them proves a requirement in this portal:
 * nothing here is linked to a claim yet. A green module means it typechecks
 * with no open obligations — not that it says what any English sentence says.
 */
export function Proof({ specs }: { specs: Spec[] }) {
  const green = specs.filter((s) => s.status === "GREEN").length;
  const sorry = specs.reduce((n, s) => n + (s.sorry_count || 0), 0);
  return (
    <Box>
      <PaneHead
        title="Proof"
        sub={`${specs.length} formal specifications indexed across the estate. ${green} green, ${sorry} open obligations.`}
      />
      <Paper variant="outlined" sx={{ mb: 2, p: 2, borderLeft: 3, borderColor: "primary.main" }}>
        <Typography variant="body2" sx={{ maxWidth: "74ch" }}>
          <b>None of these is linked to a requirement yet.</b> A green module means
          it typechecks with no open obligations — it does not mean the theorem
          says what an English sentence says. Closing that gap is the grounding
          step, and it has not been done for any claim in this portal.
        </Typography>
      </Paper>
      <Paper variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              {["Repo", "Module", "Verified by", "Open", "Status"].map((h) => (
                <TableCell key={h} sx={{ fontFamily: MONO, fontSize: 10, letterSpacing: ".1em",
                                         textTransform: "uppercase", color: "text.secondary" }}>{h}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {specs.slice(0, 40).map((s) => (
              <TableRow key={`${s.repo}/${s.path}`} hover>
                <TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{s.repo}</TableCell>
                <TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{s.module || s.path}</TableCell>
                <TableCell sx={{ fontFamily: MONO, fontSize: 11, color: "text.secondary" }}>
                  {s.target || s.kind || "—"}
                </TableCell>
                <TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{s.sorry_count}</TableCell>
                <TableCell>
                  <Chip size="small" label={s.status}
                        color={s.status === "GREEN" ? "success" : s.status === "SORRY" ? "warning" : "default"}
                        sx={{ fontFamily: MONO, fontSize: 10, height: 20 }} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>
    </Box>
  );
}
