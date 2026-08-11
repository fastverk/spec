import { createTheme, type Theme } from "@mui/material/styles";

/**
 * Neutrals carry a slight violet bias so they read as chosen rather than
 * inherited, and the one saturated hue is reserved for the system asking a
 * question — the single thing this screen wants a person to answer.
 *
 * Semantic colour is kept separate from that accent: `warning` marks a reading
 * whose population is zero, `error` a reading the project cannot express at all.
 * Those are different failures and must not share a colour with each other or
 * with the accent.
 *
 * ## Dark is designed, not inverted
 *
 * The dark palette is not the light one flipped. Two things had to be re-chosen
 * rather than negated:
 *
 * - **The accent gets lighter and less saturated.** `#1E5F8E` on a dark ground
 *   is close to unreadable — dark blues collapse into a near-black surface. It
 *   lifts to `#7FB2DA`, which keeps the same "the system is asking" role at
 *   roughly the same perceived contrast against its own ground.
 * - **Warning and error stay distinguishable from each other.** They mark
 *   different failures (a population of zero versus no referent at all), so
 *   they are re-picked against the dark ground rather than brightened by the
 *   same amount and allowed to converge.
 *
 * Surfaces lift with elevation (`#15181D` ground, `#1C2027` paper) instead of
 * going pure black, so the cards that carry every population count still read
 * as cards.
 */

const typography = {
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  h1: { fontSize: 30, fontWeight: 800, letterSpacing: "-0.02em" },
  h2: { fontSize: 19, fontWeight: 700, letterSpacing: "-0.01em" },
  body2: { fontSize: 13.5 },
} as const;

export const lightTheme = createTheme({
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
  typography,
  shape: { borderRadius: 8 },
});

export const darkTheme = createTheme({
  palette: {
    mode: "dark",
    background: { default: "#15181D", paper: "#1C2027" },
    text: { primary: "#E8EAEE", secondary: "#9AA3B2" },
    primary: { main: "#7FB2DA" },
    success: { main: "#6FBF95" },
    warning: { main: "#E0A24B" },
    error: { main: "#E8776F" },
    divider: "#2C323B",
  },
  typography,
  shape: { borderRadius: 8 },
});

/**
 * Three states, not two: an explicit choice, or "follow the system".
 *
 * ⚠ "system" must stay a distinct stored value rather than being resolved to
 * light/dark at save time. Someone who never touched the toggle should track
 * their OS when it changes at sunset; collapsing the default into a concrete
 * choice freezes them on whatever it happened to be the first time they loaded
 * the page.
 */
export type ThemeChoice = "light" | "dark" | "system";

const KEY = "spec-portal-theme";

export function storedChoice(): ThemeChoice {
  const v = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

export function storeChoice(c: ThemeChoice) {
  try {
    localStorage.setItem(KEY, c);
  } catch {
    // A portal that will not render because storage is blocked is worse than
    // one that forgets the preference.
  }
}

export function resolveTheme(choice: ThemeChoice, systemPrefersDark: boolean): Theme {
  if (choice === "dark") return darkTheme;
  if (choice === "light") return lightTheme;
  return systemPrefersDark ? darkTheme : lightTheme;
}

/** Promise text is set in a serif — it is the thing people argue over, and it
 *  should not look like chrome. */
export const SERIF = 'ui-serif, Charter, "Iowan Old Style", Georgia, serif';
export const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';
