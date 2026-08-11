"use client";

import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useMemo, useState } from "react";

import { stateOf } from "../../lib/evaluated";
import type { Row } from "../../lib/overlay";
import { inProject, openingProject, projectsIn } from "../../lib/project";
import { MONO, SERIF } from "../theme";
import { OverlayError, PaneHead, ProjectPicker, StateChip } from "../ui";
import { useOverlay } from "../useOverlay";

/**
 * The requirements document, generated from the requirements.
 *
 * Nobody edits this — editing it here would mean editing a requirement, and the
 * corpus is generated. The state column is the part a hand-written document can
 * never carry: a reader sees not just what was promised, but whether anything is
 * holding it up.
 */
export function DocumentClient({ corpusReqs }: { corpusReqs: Row[] }) {
  const { data, error } = useOverlay();
  const reqs = data?.requirements ?? corpusReqs;

  const projects = useMemo(() => projectsIn(corpusReqs), [corpusReqs]);
  const [project, setProject] = useState(() => openingProject(projects));

  const mine = reqs.filter((r) => inProject(r, project));
  const areas = [...new Set(mine.map((r) => String(r["discipline"] ?? "")))];
  const enforced = mine.filter((r) => stateOf(r) === "Enforced").length;

  return (
    <>
      <PaneHead
        title="Document"
        blurb="Generated from the requirements. Nobody edits this — editing it here would mean editing a requirement, and the corpus is generated."
      />

      {error ? <OverlayError message={error} /> : null}
      <ProjectPicker projects={projects} value={project} onChange={setProject} />

      <Paper variant="outlined" sx={{ p: { xs: 2.5, sm: 4 }, maxWidth: 900 }}>
        <Typography sx={{ fontFamily: SERIF, fontSize: 22, fontWeight: 700 }}>
          Authentication &amp; Authorization Requirements
        </Typography>
        <Typography sx={{ fontFamily: MONO, fontSize: 10.5, color: "text.secondary",
                          letterSpacing: ".06em", mt: 0.5 }}>
          {project.toUpperCase()} · GENERATED FROM {mine.length} REQUIREMENTS · {enforced} ENFORCED
        </Typography>
        {/* ⛔ `enforced` counts only a real verdict over a NON-EMPTY population.
            A document that counted measurements instead would report AUTH-24 as
            enforced off a check that examined nothing. */}
        <Divider sx={{ my: 2.5 }} />

        {areas.map((a) => (
          <Box key={a} sx={{ mb: 3 }}>
            <Typography sx={{ fontSize: 13, fontWeight: 700, mb: 1.5 }}>{a}</Typography>
            <Stack spacing={0}>
              {mine
                .filter((r) => r["discipline"] === a)
                .map((r) => (
                  <Stack key={String(r["requirement_id"])} direction="row" spacing={2}
                         alignItems="baseline"
                         sx={{ py: 1.25, borderTop: 1, borderColor: "divider" }}>
                    <Typography sx={{ fontFamily: MONO, fontSize: 12, fontWeight: 700,
                                      color: "primary.main", minWidth: 82 }}>
                      {String(r["requirement_id"] ?? "").toUpperCase()}
                    </Typography>
                    <Box sx={{ flex: 1 }}>
                      <Typography sx={{ fontFamily: SERIF, fontSize: 15, lineHeight: 1.5 }}>
                        {String(r["predicate"] ?? "").replace(/[`*]/g, "")}
                      </Typography>
                      {r["pending"] ? (
                        <Typography sx={{ fontSize: 11, color: "info.main", mt: 0.25 }}>
                          proposed by {String(r["pending_by"] ?? "")}, not yet adopted
                        </Typography>
                      ) : null}
                    </Box>
                    <StateChip state={stateOf(r)} />
                  </Stack>
                ))}
            </Stack>
          </Box>
        ))}
      </Paper>
    </>
  );
}
