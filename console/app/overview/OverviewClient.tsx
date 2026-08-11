"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Typography from "@mui/material/Typography";
import { useMemo, useState } from "react";

import type { Row } from "../../lib/overlay";
import { PaneHead, OverlayError, Tile } from "../ui";
import { useOverlay } from "../useOverlay";

export function OverviewClient({ corpusReqs, corpusTerms }: { corpusReqs: Row[]; corpusTerms: Row[] }) {
  const { data, error } = useOverlay();
  const projectList = useMemo(
    () => [...new Set(corpusReqs.map((r) => String(r["project"] ?? "")))].sort(),
    [corpusReqs],
  );
  const [project, setProject] = useState(projectList.includes("studio") ? "studio" : projectList[0] ?? "");

  // Overlaid rows when the overlay answered; the corpus alone when it did not.
  const reqs = (data?.requirements ?? corpusReqs).filter((r) => r["project"] === project);
  const termRows = (data?.terms ?? corpusTerms).filter((t) => t["project"] === project);

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

  return (
    <>
      <PaneHead
        title="Overview"
        blurb="Where the work actually is. A pane is empty exactly when the work behind it has not been done — nothing here is stubbed to look further along than it is."
      />

      {error ? <OverlayError message={error} /> : null}

      {projectList.length > 1 ? (
        <Select
          size="small" value={project} onChange={(e) => setProject(String(e.target.value))}
          sx={{ mb: 2.5, minWidth: 180, fontSize: 13 }}
        >
          {projectList.map((p) => (
            <MenuItem key={p} value={p} sx={{ fontSize: 13 }}>{p}</MenuItem>
          ))}
        </Select>
      ) : null}

      <Typography variant="h2" sx={{ mb: 1 }}>The funnel</Typography>
      <Box sx={{ display: "flex", gap: 1.5, flexWrap: "wrap", mb: 3 }}>
        <Tile n={written} label="Written down" hint="requirements in the corpus" />
        <Tile n={decomposed} label="Broken into terms" hint="requirements with at least one term" />
        <Tile n={`${bound.size} / ${surfaces.size}`} label="Terms pinned down" hint="bound to a real population" />
        <Tile n={measured} label="Population measured" hint="a check has actually run" />
      </Box>

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
