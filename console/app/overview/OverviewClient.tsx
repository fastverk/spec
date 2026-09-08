"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import { useMemo, useState } from "react";

import type { Row } from "../../lib/overlay";
import { inProject, openingProject, projectsIn } from "../../lib/project";
import { OverlayError, PaneHead, ProjectPicker, Tile } from "../ui";
import { useOverlay } from "../useOverlay";

export function OverviewClient({ corpusReqs, corpusTerms }: { corpusReqs: Row[]; corpusTerms: Row[] }) {
  const { data, error } = useOverlay();
  const projectList = useMemo(() => projectsIn(corpusReqs), [corpusReqs]);
  const [project, setProject] = useState(() => openingProject(projectList));

  // Overlaid rows when the overlay answered; the corpus alone when it did not.
  const reqs = (data?.requirements ?? corpusReqs).filter((r) => inProject(r, project));
  const termRows = (data?.terms ?? corpusTerms).filter((t) => inProject(t, project));

  const written = reqs.length;
  const decomposed = new Set(termRows.map((t) => String(t["requirement_id"]))).size;
  const surfaces = new Set(termRows.filter((t) => !t["retired"] && !t["retracted"]).map((t) => String(t["surface"])));
  const bound = new Set(
    termRows.filter((t) => t["bound_to"] && !t["retired"] && !t["retracted"]).map((t) => String(t["surface"])),
  );
  const measured = reqs.filter((r) => r["population"] !== "—").length;

  // ⛔ The number this console exists for. A requirement whose check would
  // examine nothing reports success forever, having examined nothing.
  const vacuous = reqs.filter((r) => r["outcome"] === "Vacuous").length;
  const unchecked = written - measured;
  const unpinned = Math.max(0, surfaces.size - bound.size);

  return (
    <>
      <Stack direction={{ xs: "column", sm: "row" }} alignItems={{ sm: "flex-start" }} spacing={2}>
        <PaneHead
          title={`${project || "Project"} spec`}
          blurb="Turn project decisions into requirements, define the concepts they rely on, and connect checks as the implementation catches up."
        />
        <Box sx={{ flex: 1 }} />
        <Button component={Link} href="/requirements/new" variant="contained" sx={{ whiteSpace: "nowrap", alignSelf: { xs: "flex-start", sm: "center" } }}>
          + New requirement
        </Button>
      </Stack>

      {error ? <OverlayError message={error} /> : null}

      <ProjectPicker projects={projectList} value={project} onChange={setProject} />


      <Typography variant="h2" sx={{ mb: 1 }}>The funnel</Typography>
      <Box sx={{ display: "flex", gap: 1.5, flexWrap: "wrap", mb: 3 }}>
        <Tile n={written} label="Written down" hint="requirements in the corpus" />
        <Tile n={decomposed} label="Broken into terms" hint="requirements with at least one term" />
        <Tile n={`${bound.size} / ${surfaces.size}`} label="Terms pinned down" hint="bound to a real population" />
        <Tile n={measured} label="Population measured" hint="a check has actually run" />
      </Box>

      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 2.5 }, mb: 3 }}>
        <Typography variant="h2" sx={{ fontSize: 15, mb: 0.5 }}>Continue building the spec</Typography>
        <Typography variant="body2" sx={{ color: "text.secondary", mb: 2 }}>
          Start with the highest-leverage unfinished work.
        </Typography>
        <Stack direction={{ xs: "column", md: "row" }} spacing={1.5}>
          <Button component={Link} href="/requirements/new" variant="outlined" sx={{ flex: 1, justifyContent: "flex-start", py: 1.25 }}>
            Write another requirement
          </Button>
          <Button component={Link} href="/terms" variant="outlined" color={unpinned ? "warning" : "inherit"} sx={{ flex: 1, justifyContent: "flex-start", py: 1.25 }}>
            Define {unpinned} open {unpinned === 1 ? "concept" : "concepts"}
          </Button>
          <Button component={Link} href="/proposals" variant="outlined" sx={{ flex: 1, justifyContent: "flex-start", py: 1.25 }}>
            Review pending proposals
          </Button>
        </Stack>
      </Paper>

      {vacuous > 0 ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          <b>{vacuous} {vacuous === 1 ? "requirement examines" : "requirements examine"} nothing.</b>{" "}
          A check there would report success forever, having examined no records. That is not a
          passing check — it is a green build that tested nothing, and it is why the population
          number exists.
        </Alert>
      ) : null}

      {unchecked > 0 ? (
        <Alert severity="warning">
          <b>{unchecked} of {written} are checked by nothing.</b> No measurement has ever run
          against them, so nothing is known about whether they hold — which is different from
          knowing they fail, and different again from examining zero records.
        </Alert>
      ) : null}
    </>
  );
}
