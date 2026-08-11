"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useColorScheme } from "@mui/material/styles";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { MONO } from "./theme";

const NAV = [
  { href: "/overview", label: "Overview", group: "Project" },
  { href: "/requirements", label: "Requirements", group: "Project" },
  { href: "/grounding", label: "Grounding", group: "Project" },
  { href: "/proposals", label: "Proposals", group: "Outputs" },
] as const;

function ThemeToggle() {
  const { mode, setMode } = useColorScheme();
  // Cycles light -> dark -> system. "system" is a real third state, not a
  // resolved value, so it keeps tracking the OS after the fact.
  const next = mode === "light" ? "dark" : mode === "dark" ? "system" : "light";
  const icon = mode === "light" ? "☀" : mode === "dark" ? "☾" : "◐";
  return (
    <Tooltip title={`Theme: ${mode ?? "system"} — click for ${next}`}>
      <IconButton size="small" onClick={() => setMode(next)} aria-label="Change theme">
        <Box component="span" sx={{ fontSize: 15 }}>{icon}</Box>
      </IconButton>
    </Tooltip>
  );
}

export function Shell({ corpusVersion, children }: { corpusVersion: string; children: React.ReactNode }) {
  const path = usePathname();
  const groups = [...new Set(NAV.map((n) => n.group))];

  return (
    <Box sx={{ display: "flex", minHeight: "100vh" }}>
      <Box
        component="nav"
        sx={{
          width: 232, flexShrink: 0, borderRight: 1, borderColor: "divider",
          bgcolor: "background.paper", display: "flex", flexDirection: "column",
        }}
      >
        <Box sx={{ p: 2, pb: 1.5 }}>
          <Typography variant="h1" sx={{ fontSize: 17 }}>spec</Typography>
          <Typography variant="body2" sx={{ color: "text.secondary", fontSize: 12 }}>
            the grounding console
          </Typography>
        </Box>
        <Divider />
        <Box sx={{ flex: 1, overflowY: "auto" }}>
          {groups.map((g) => (
            <Box key={g} sx={{ mt: 1.5 }}>
              <Typography
                sx={{ px: 2, fontSize: 10.5, fontWeight: 700, letterSpacing: "0.08em",
                      textTransform: "uppercase", color: "text.secondary" }}
              >
                {g}
              </Typography>
              <List dense disablePadding>
                {NAV.filter((n) => n.group === g).map((n) => (
                  <ListItemButton
                    key={n.href} component={Link} href={n.href}
                    selected={path === n.href} sx={{ py: 0.5, px: 2 }}
                  >
                    <ListItemText primaryTypographyProps={{ fontSize: 13.5 }} primary={n.label} />
                  </ListItemButton>
                ))}
              </List>
            </Box>
          ))}
        </Box>
        <Divider />
        {/*
          The read point, always visible. It is a constant of this deployment —
          the payloads and the version ship as one artifact — and it is what every
          write names as its `parent`.
        */}
        <Box sx={{ p: 1.5, pb: 2 }}>
          <Typography sx={{ fontSize: 9.5, fontWeight: 700, letterSpacing: "0.08em",
                            textTransform: "uppercase", color: "text.secondary", mb: 0.5 }}>
            Read point
          </Typography>
          <Tooltip title="The corpus state this build serves. Every proposal names it as its read point — there is no default, because a proposal made against a corpus you were not looking at is a different proposal.">
            <Chip
              size="small" variant="outlined" label={corpusVersion}
              sx={{ fontFamily: MONO, fontSize: 10.5, width: "100%", justifyContent: "flex-start" }}
            />
          </Tooltip>
          <Box sx={{ display: "flex", alignItems: "center", mt: 1 }}>
            <ThemeToggle />
            <Box sx={{ flex: 1 }} />
            <Button size="small" color="inherit" href="/api/health"
                    sx={{ fontSize: 11, textTransform: "none", minWidth: 0 }}>
              health
            </Button>
          </Box>
        </Box>
      </Box>
      <Box component="main" sx={{ flex: 1, minWidth: 0, p: 3 }}>{children}</Box>
    </Box>
  );
}
