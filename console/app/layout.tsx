import type { Metadata } from "next";
import { AppRouterCacheProvider } from "@mui/material-nextjs/v15-appRouter";
import CssBaseline from "@mui/material/CssBaseline";
import InitColorSchemeScript from "@mui/material/InitColorSchemeScript";
import { ThemeProvider } from "@mui/material/styles";

import { CORPUS_VERSION } from "../lib/corpus";
import { Shell } from "./Shell";
import { theme } from "./theme";

export const metadata: Metadata = {
  title: "spec — grounding",
  description: "Requirements, the terms they depend on, and what a check would examine.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        {/*
          Writes the stored choice onto <html> BEFORE first paint. Without it a
          reader who chose dark gets a flash of light, and "follow the system"
          cannot be honoured at all on a server that has no system to follow.

          ⚠ "system" is stored AS ITSELF rather than resolved at save time, so
          someone who never touched the toggle still tracks their OS when it flips.
        */}
        <InitColorSchemeScript attribute="data-theme" defaultMode="system" />
        <AppRouterCacheProvider options={{ enableCssLayer: true }}>
          <ThemeProvider theme={theme} defaultMode="system">
            <CssBaseline />
            <Shell corpusVersion={CORPUS_VERSION}>{children}</Shell>
          </ThemeProvider>
        </AppRouterCacheProvider>
      </body>
    </html>
  );
}
