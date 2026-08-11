import type { ReactNode } from "react";
import { Alert, Box, Chip, Paper, Stack, Typography } from "@mui/material";
import { MONO, SERIF } from "./theme";

export function Tile({
  n, label, tone,
}: { n: ReactNode; label: string; tone?: "warn" | "bad" | "good" }) {
  const color =
    tone === "warn" ? "warning.main" : tone === "bad" ? "error.main" : tone === "good" ? "success.main" : "text.primary";
  return (
    <Paper variant="outlined" sx={{ p: 2, flex: 1, minWidth: 140 }}>
      <Typography sx={{ fontFamily: MONO, fontSize: 26, fontWeight: 700, color, lineHeight: 1.1 }}>
        {n}
      </Typography>
      <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.5 }}>{label}</Typography>
    </Paper>
  );
}

export function PaneHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <Box sx={{ mb: 3 }}>
      <Typography variant="h1" sx={{ fontSize: 26 }}>{title}</Typography>
      {sub ? (
        <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.5, maxWidth: "72ch" }}>
          {sub}
        </Typography>
      ) : null}
    </Box>
  );
}

/** A requirement's sentence. Serif, because it is the thing people argue over. */
export function Promise_({ children }: { children: ReactNode }) {
  return (
    <Typography sx={{ fontFamily: SERIF, fontSize: 16, lineHeight: 1.5, maxWidth: "62ch" }}>
      {children}
    </Typography>
  );
}

export function StateChip({ state }: { state: string }) {
  const map: Record<string, { bg: string; fg: string }> = {
    Draft: { bg: "#EAEDF1", fg: "#5C6472" },
    "In question": { bg: "#E8F0F7", fg: "#1E5F8E" },
    Agreed: { bg: "#E6F0EA", fg: "#2F6B4F" },
    Enforced: { bg: "#2F6B4F", fg: "#FFFFFF" },
  };
  const c = map[state] ?? map.Draft!;
  return (
    <Chip size="small" label={state}
      sx={{ bgcolor: c.bg, color: c.fg, fontFamily: MONO, fontSize: 10.5, fontWeight: 700, height: 20 }} />
  );
}

/**
 * An empty state that says WHY it is empty and what would fill it.
 *
 * Used where the portal has no data rather than no rows — those are different,
 * and a blank table that looks like "nothing to worry about" is the same
 * mistake as a check that examined nothing and reported PASS.
 */
export function NotBackedYet({ what, needs }: { what: string; needs: ReactNode }) {
  return (
    <Alert severity="info" variant="outlined">
      <b>{what} has no data behind it yet.</b>
      <Box sx={{ mt: 0.5 }}>{needs}</Box>
      <Typography variant="body2" sx={{ mt: 1, color: "text.secondary" }}>
        Shown empty on purpose. Filling it with plausible rows would make this
        screen the most convincing thing in the product and the least true.
      </Typography>
    </Alert>
  );
}

export function Bar({ pct, tone = "bad" }: { pct: number; tone?: "bad" | "good" }) {
  return (
    <Box sx={{ display: "flex", height: 7, width: 120, borderRadius: 1, overflow: "hidden", bgcolor: "#EAEDF1" }}>
      <Box sx={{ width: `${pct}%`, bgcolor: tone === "bad" ? "warning.main" : "success.main" }} />
    </Box>
  );
}

export const Mono = ({ children }: { children: ReactNode }) => (
  <Box component="span" sx={{ fontFamily: MONO, fontSize: 12 }}>{children}</Box>
);

export function Row({ children }: { children: ReactNode }) {
  return <Stack direction="row" spacing={1.5} alignItems="center">{children}</Stack>;
}
