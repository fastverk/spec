import { Box, Paper, Table, TableBody, TableCell, TableRow, Typography } from "@mui/material";
import { NotBackedYet, PaneHead } from "../ui";
import { MONO } from "../theme";

const ROWS: Array<[string, string, string]> = [
  ["Owner", "—", "Who may move a requirement to Agreed. Not modelled yet."],
  ["Source document", "AuthRequirements.md", "Imported and fingerprinted; drift is one command."],
  ["Codebase", "gitlab.savvifi.com/platform/studio-nextjs", "Where citations would be looked for."],
  ["Grounding adapter", "http://127.0.0.1:3010", "The product answers population questions in its own environment."],
  ["Areas", "14, from the document's own sections", "Not invented — the structure the author already used."],
  ["Build pipeline", "not connected", "Until connected, no requirement can reach Enforced."],
];

export function Settings() {
  return (
    <Box>
      <PaneHead
        title="Settings"
        sub="What makes a project: an owner, its source document, the codebase, and where checks attach."
      />
      <Paper variant="outlined" sx={{ mb: 3 }}>
        <Table size="small">
          <TableBody>
            {ROWS.map(([k, v, why]) => (
              <TableRow key={k}>
                <TableCell sx={{ fontWeight: 640, width: 180, verticalAlign: "top" }}>{k}</TableCell>
                <TableCell sx={{ fontFamily: MONO, fontSize: 12, verticalAlign: "top" }}>{v}</TableCell>
                <TableCell sx={{ fontSize: 12.5, color: "text.secondary" }}>{why}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>
      <NotBackedYet
        what="Editing any of this"
        needs={<>The portal is read-only today. Writes go through the proposal path
        in spec, which exists but is not wired to this UI.</>}
      />
      <Typography variant="body2" sx={{ mt: 2, color: "text.secondary", maxWidth: "72ch" }}>
        The last row is the one that matters. <b>Nothing can reach Enforced until a
        pipeline exists to attach a check to</b> — and studio-nextjs has no test
        suite at all, so that is a real prerequisite rather than configuration.
      </Typography>
    </Box>
  );
}
