import { createTheme } from "@mui/material/styles";

/**
 * Neutrals carry a slight violet bias so they read as chosen rather than
 * inherited, and the one saturated hue is reserved for the system asking a
 * question — the single thing this screen wants a person to answer.
 *
 * Semantic colour is kept separate from that accent: `warning` marks a reading
 * whose population is zero, `error` a reading the project cannot express at all.
 * Those are different failures and must not share a colour with each other or
 * with the accent.
 */
export const theme = createTheme({
  palette: {
    mode: "light",
    background: { default: "#EDEFF2", paper: "#FFFFFF" },
    text: { primary: "#14171C", secondary: "#5C6472" },
    primary: { main: "#1E5F8E" },
    success: { main: "#2F6B4F" },
    warning: { main: "#A55E17" },
    error: { main: "#A8352F" },
    divider: "#DCE0E6",
  },
  typography: {
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    h1: { fontSize: 30, fontWeight: 800, letterSpacing: "-0.02em" },
    h2: { fontSize: 19, fontWeight: 700, letterSpacing: "-0.01em" },
    body2: { fontSize: 13.5 },
  },
  shape: { borderRadius: 8 },
});

/** Promise text is set in a serif — it is the thing people argue over, and it
 *  should not look like chrome. */
export const SERIF = 'ui-serif, Charter, "Iowan Old Style", Georgia, serif';
export const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';
