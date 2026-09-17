"use client";

/**
 * Two hand-authored palettes. Dark is NOT a programmatic inversion of light —
 * the accent lifts rather than darkens, and warning/error are re-picked rather
 * than brightened, because a brightened warning on a dark ground reads as an
 * error.
 *
 * ⚠ `cssVariables` with an explicit `colorSchemeSelector` is what makes this
 * survive server rendering. The portal chose its theme during render from
 * `localStorage` and `matchMedia`, both of which are absent on a server, so the
 * whole tree mismatched at hydration. Here the palettes ship as CSS variables and
 * the choice is an attribute on <html>, so the server and the client agree on the
 * markup and only the attribute differs.
 */
import { createTheme } from "@mui/material/styles";

export const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif';
export const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

const typography = {
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  h1: { fontSize: 22, fontWeight: 650, letterSpacing: "-0.01em" },
  h2: { fontSize: 15, fontWeight: 650, letterSpacing: "-0.005em" },
} as const;

export const theme = createTheme({
  cssVariables: { colorSchemeSelector: "data-theme" },
  colorSchemes: {
    light: {
      palette: {
        background: { default: "#EDEFF2", paper: "#FFFFFF" },
        text: { primary: "#14171C", secondary: "#5C6472" },
        primary: { main: "#1E5F8E" },
        success: { main: "#2F6B4F" },
        warning: { main: "#A55E17" },
        error: { main: "#A8352F" },
        divider: "#DCE0E6",
      },
    },
    dark: {
      palette: {
        background: { default: "#12151A", paper: "#181C22" },
        text: { primary: "#E6E9ED", secondary: "#98A1B0" },
        // Lifted, not darkened: #1E5F8E on #12151A fails contrast outright.
        primary: { main: "#7FB2DA" },
        success: { main: "#6FBF95" },
        warning: { main: "#D9A05B" },
        error: { main: "#E2796F" },
        divider: "#2A2F38",
      },
    },
  },
  typography,
  shape: { borderRadius: 8 },
});
