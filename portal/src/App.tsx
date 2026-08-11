import { useEffect, useMemo, useState } from "react";
import {
  AppBar, Box, Chip, CssBaseline, List, ListItemButton, ListItemText,
  MenuItem, Select, ThemeProvider, Toolbar, Typography,
} from "@mui/material";
import * as api from "./api";
import type { Conflict, Discipline, Requirement, Spec, Term } from "./api";
import { MONO, theme } from "./theme";
import { Overview } from "./panes/Overview";
import { Requirements } from "./panes/Requirements";
import { Grounding } from "./panes/Grounding";
import { Conflicts } from "./panes/Conflicts";
import { Proof } from "./panes/Proof";
import { Document } from "./panes/Document";
import { Settings } from "./panes/Settings";
import { PlanMode, Liveness } from "./panes/Planned";

/**
 * Terms the portal can ask a product about, and the requirement each belongs to.
 *
 * ⚠ Hard-coded, and that is a real limitation rather than a shortcut worth
 * hiding: decomposing a requirement into its terms is the step after capture,
 * and nothing has done it for this corpus — every claim is still raw prose.
 * Deriving a term list from the corpus would mean inventing the decomposition
 * here, which is exactly what the importer refuses to do.
 */
const NAV = [
  { id: "overview", label: "Overview", group: "Project" },
  { id: "requirements", label: "Requirements", group: "Project" },
  { id: "grounding", label: "Grounding", group: "Project" },
  { id: "conflicts", label: "Conflicts", group: "Assurance" },
  { id: "proof", label: "Proof", group: "Assurance" },
  { id: "plan", label: "Plan mode", group: "Assurance" },
  { id: "liveness", label: "Liveness", group: "Assurance" },
  { id: "document", label: "Document", group: "Outputs" },
  { id: "settings", label: "Settings", group: "Outputs" },
] as const;

export default function App() {
  const [reqs, setReqs] = useState<Requirement[]>([]);
  const [disc, setDisc] = useState<Discipline[]>([]);
  const [confs, setConfs] = useState<Conflict[]>([]);
  const [specList, setSpecs] = useState<Spec[]>([]);
  const [project, setProject] = useState("studio");
  const [pane, setPane] = useState<string>("overview");
  const [termRows, setTerms] = useState<Term[]>([]);
  const [groundSurface, setGroundSurface] = useState("");

  useEffect(() => {
    api.requirements().then(setReqs).catch(() => setReqs([]));
    api.disciplines().then(setDisc).catch(() => setDisc([]));
    api.conflicts().then(setConfs).catch(() => setConfs([]));
    api.specs().then(setSpecs).catch(() => setSpecs([]));
    api.terms().then(setTerms).catch(() => setTerms([]));
  }, []);

  const projects = useMemo(
    () => Array.from(new Set(reqs.map((r) => r.project))).sort(),
    [reqs],
  );
  const mine = reqs.filter((r) => r.project === project);
  const myTerms = termRows.filter((t) => t.project === project);

  const counts: Record<string, number> = {
    requirements: mine.length,
    conflicts: confs.filter((c) => c.project === project).length,
    proof: specList.length,
  };

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AppBar position="static" elevation={0} color="transparent"
              sx={{ borderBottom: 1, borderColor: "divider", bgcolor: "background.paper" }}>
        <Toolbar variant="dense">
          <Typography sx={{ fontFamily: MONO, fontWeight: 700 }}>spec</Typography>
          <Typography sx={{ mx: 1.5, color: "text.secondary" }}>/</Typography>
          <Select size="small" variant="standard" disableUnderline value={project}
                  onChange={(e) => setProject(String(e.target.value))}
                  sx={{ fontWeight: 650, fontSize: 14 }}>
            {projects.map((p) => (
              <MenuItem key={p} value={p} sx={{ fontSize: 14 }}>{p}</MenuItem>
            ))}
          </Select>
          <Box sx={{ flex: 1 }} />
          <Typography variant="body2" sx={{ color: "text.secondary", fontFamily: MONO, fontSize: 11.5 }}>
            {reqs.length} requirements across {projects.length} projects
          </Typography>
        </Toolbar>
      </AppBar>

      <Box sx={{ display: "flex", minHeight: "calc(100vh - 48px)" }}>
        <Box sx={{ width: 208, borderRight: 1, borderColor: "divider", bgcolor: "#F5F7F9", py: 1 }}>
          <List dense disablePadding>
            {NAV.map((n, i) => (
              <Box key={n.id}>
                {i === 0 || NAV[i - 1]!.group !== n.group ? (
                  <Typography sx={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: ".13em",
                                    textTransform: "uppercase", color: "text.secondary",
                                    px: 2, pt: i ? 2 : 1, pb: 0.5 }}>
                    {n.group}
                  </Typography>
                ) : null}
                <ListItemButton selected={pane === n.id} onClick={() => setPane(n.id)}
                                sx={{ py: 0.5, px: 2, mx: 1, borderRadius: 1 }}>
                  <ListItemText primary={n.label}
                                primaryTypographyProps={{ fontSize: 13.5,
                                  fontWeight: pane === n.id ? 650 : 400 }} />
                  {counts[n.id] !== undefined ? (
                    <Chip size="small" label={counts[n.id]}
                          sx={{ height: 18, fontFamily: MONO, fontSize: 10.5 }} />
                  ) : null}
                </ListItemButton>
              </Box>
            ))}
          </List>
        </Box>

        <Box sx={{ flex: 1, p: 4, maxWidth: 1040 }}>
          {pane === "overview" && <Overview project={project} reqs={reqs} disc={disc} confs={confs} terms={termRows} />}
          {pane === "requirements" && (
            <Requirements
              project={project} reqs={reqs} terms={myTerms}
              onGround={(surface) => { setGroundSurface(surface); setPane("grounding"); }}
            />
          )}
          {pane === "grounding" && (
            <Grounding terms={myTerms} requirements={mine} initialSurface={groundSurface} />
          )}
          {pane === "conflicts" && <Conflicts project={project} confs={confs} />}
          {pane === "proof" && <Proof specs={specList} />}
          {pane === "plan" && <PlanMode />}
          {pane === "liveness" && <Liveness />}
          {pane === "document" && <Document project={project} reqs={reqs} />}
          {pane === "settings" && <Settings />}
        </Box>
      </Box>
    </ThemeProvider>
  );
}
