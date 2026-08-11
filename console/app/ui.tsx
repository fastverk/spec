"use client";

import Alert from "@mui/material/Alert";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";

import type { State } from "../lib/evaluated";
import { MONO } from "./theme";

export function PaneHead({ title, blurb }: { title: string; blurb: string }) {
  return (
    <Box sx={{ mb: 2.5 }}>
      <Typography variant="h1">{title}</Typography>
      <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.5, maxWidth: 760 }}>
        {blurb}
      </Typography>
    </Box>
  );
}

export function Tile({ n, label, hint, tone }: {
  n: number | string; label: string; hint?: string; tone?: "bad" | "warn";
}) {
  const color = tone === "bad" ? "error.main" : tone === "warn" ? "warning.main" : "text.primary";
  return (
    <Paper variant="outlined" sx={{ p: 2, flex: "1 1 150px", minWidth: 150 }}>
      <Typography sx={{ fontSize: 26, fontWeight: 650, lineHeight: 1.1, color }}>{n}</Typography>
      <Typography sx={{ fontSize: 12.5, mt: 0.5 }}>{label}</Typography>
      {hint ? (
        <Typography sx={{ fontSize: 11, color: "text.secondary", mt: 0.5 }}>{hint}</Typography>
      ) : null}
    </Paper>
  );
}

export function Mono({ children }: { children: React.ReactNode }) {
  return <Box component="span" sx={{ fontFamily: MONO, fontSize: 12.5 }}>{children}</Box>;
}

const STATE_COLOR: Record<State, "default" | "success" | "warning"> = {
  Draft: "default",
  "In question": "warning",
  Agreed: "default",
  Enforced: "success",
};

export function StateChip({ state }: { state: State }) {
  return <Chip size="small" label={state} color={STATE_COLOR[state]} variant="outlined" sx={{ fontSize: 11 }} />;
}

/**
 * ⛔ "Could not ask" is not "nothing is pending".
 *
 * When the overlay fails the corpus stays on screen and this says why, rather
 * than the page rendering clean and meaning something it does not.
 */
export function OverlayError({ message }: { message: string }) {
  return (
    <Alert severity="warning" sx={{ mb: 2 }}>
      <b>Could not read pending proposals — showing the corpus only.</b> {message}
    </Alert>
  );
}

export function ReadOnly({ because }: { because: string }) {
  return (
    <Alert severity="info" sx={{ mb: 2 }}>
      <b>Read-only.</b> {because}
    </Alert>
  );
}

/** A pane that is empty because the work behind it has not been done. */
export function NotBackedYet({ what }: { what: string }) {
  return (
    <Paper variant="outlined" sx={{ p: 3, textAlign: "center" }}>
      <Typography variant="body2" sx={{ color: "text.secondary" }}>{what}</Typography>
    </Paper>
  );
}

/**
 * One project at a time.
 *
 * ⚠ The corpora are loaded as SEPARATE graphs and never merged — merging would
 * let two products' claims join through the ontology and produce cross-project
 * rows that are artifacts of the loader rather than findings. Showing them
 * together here would undo that at the last step.
 */
export function ProjectPicker({ projects, value, onChange }: {
  projects: string[]; value: string; onChange: (p: string) => void;
}) {
  if (projects.length < 2) return null;
  return (
    <Select size="small" value={value} onChange={(e) => onChange(String(e.target.value))}
            sx={{ mb: 2.5, minWidth: 180, fontSize: 13 }}>
      {projects.map((p) => (
        <MenuItem key={p} value={p} sx={{ fontSize: 13 }}>{p}</MenuItem>
      ))}
    </Select>
  );
}
