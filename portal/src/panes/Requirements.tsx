import { useState } from "react";
import {
  Box, MenuItem, Paper, Select, Stack, Table, TableBody, TableCell,
  TableHead, TableRow, Tooltip, Typography,
} from "@mui/material";
import type { Requirement } from "../api";
import { stateOf } from "../api";
import { PaneHead, StateChip } from "../ui";
import { MONO } from "../theme";

export function Requirements({
  project, reqs, onGround,
}: { project: string; reqs: Requirement[]; onGround: (id: string) => void }) {
  const mine = reqs.filter((r) => r.project === project);
  const areas = Array.from(new Set(mine.map((r) => r.discipline))).sort();
  const [area, setArea] = useState("all");
  const shown = area === "all" ? mine : mine.filter((r) => r.discipline === area);

  return (
    <Box>
      <PaneHead
        title="Requirements"
        sub="Everything this product commits to. The list is the specification — the document is a rendering of it."
      />

      <Stack direction="row" spacing={2} sx={{ mb: 2 }} alignItems="center">
        <Select size="small" value={area} onChange={(e) => setArea(String(e.target.value))}
                sx={{ minWidth: 240, fontSize: 13 }}>
          <MenuItem value="all" sx={{ fontSize: 13 }}>All areas ({mine.length})</MenuItem>
          {areas.map((a) => (
            <MenuItem key={a} value={a} sx={{ fontSize: 13 }}>
              {a} ({mine.filter((r) => r.discipline === a).length})
            </MenuItem>
          ))}
        </Select>
        <Box sx={{ flex: 1 }} />
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {shown.length} shown
        </Typography>
      </Stack>

      <Paper variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              {["ID", "Area", "Modality", "State", "Examined", "Blocked on"].map((h) => (
                <TableCell key={h} sx={{ fontFamily: MONO, fontSize: 10, letterSpacing: ".1em",
                                         textTransform: "uppercase", color: "text.secondary" }}>
                  {h}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {shown.map((r) => (
              <TableRow key={r.requirement_id} hover sx={{ cursor: "pointer" }}
                        onClick={() => onGround(r.requirement_id)}>
                <TableCell sx={{ fontFamily: MONO, fontSize: 12, whiteSpace: "nowrap" }}>
                  {r.requirement_id.toUpperCase()}
                </TableCell>
                <TableCell sx={{ fontSize: 13 }}>{r.discipline}</TableCell>
                <TableCell sx={{ fontFamily: MONO, fontSize: 11.5 }}>{r.modality}</TableCell>
                <TableCell><StateChip state={stateOf(r)} /></TableCell>
                {/* "—" and 0 are DIFFERENT: nothing has ever run, versus a check
                    that ran and examined nothing. */}
                <TableCell>
                  <Tooltip title={r.population === "—"
                    ? "No check has ever run against this requirement"
                    : "Records the last check examined"}>
                    <Box component="span" sx={{
                      fontFamily: MONO, fontSize: 13,
                      color: r.population === "—" ? "text.secondary" : "text.primary",
                    }}>
                      {r.population}
                    </Box>
                  </Tooltip>
                </TableCell>
                <TableCell sx={{ fontSize: 12, color: "text.secondary", maxWidth: 380 }}>
                  {r.blocked_on.split(":")[0]}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>
    </Box>
  );
}
