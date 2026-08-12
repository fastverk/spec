"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import { useMemo, useState } from "react";

import { STANDING_LABEL, termEntities, termHref } from "../../lib/entity";
import type { Row } from "../../lib/overlay";
import { openingProject, projectsIn } from "../../lib/project";
import { MONO } from "../theme";
import { OverlayError, PaneHead, ProjectPicker, Tile } from "../ui";
import { useOverlay } from "../useOverlay";

/**
 * The terms, as entities.
 *
 * This was the "Grounding" pane — an activity, with a queue on the left and a
 * form on the right, and no address for any individual word. A term is a thing:
 * it has a name, a state, a set of claims that wait on it, and eventually a
 * population. So it gets a list and a URL like everything else, and grounding
 * becomes something you do to one rather than a place you visit.
 *
 * ⚠ Ordered by how many claims wait on each. That ordering is the entire value
 * of the view: `sponsor:edit` is ONE decision that unblocks eleven requirements,
 * and a list sorted alphabetically would hide that.
 */
export function TermsClient({ corpusTerms }: { corpusTerms: Row[] }) {
  const { data, error } = useOverlay();
  const termRows = data?.terms ?? corpusTerms;
  const [q, setQ] = useState("");

  const projects = useMemo(() => projectsIn(corpusTerms), [corpusTerms]);
  const [project, setProject] = useState(() => openingProject(projects));

  const all = useMemo(() => termEntities(termRows), [termRows]);
  const mine = useMemo(
    () => all.filter((e) => !e.project || e.project === project),
    [all, project],
  );
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? mine.filter((e) => e.surface.toLowerCase().includes(needle)) : mine;
  }, [mine, q]);

  const open = mine.filter((e) => e.standing === "open");
  const pinned = mine.filter((e) => e.standing === "pinned");
  const cleared = mine.filter((e) => e.standing === "cleared");

  return (
    <>
      <PaneHead
        title="Terms"
        blurb="The words the requirements depend on, and what each one points at. Deciding one settles it everywhere the word is used — which is why this list is ordered by how much each decision unblocks."
      />

      {error ? <OverlayError message={error} /> : null}

      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 2, flexWrap: "wrap", gap: 1.5 }}>
        <ProjectPicker projects={projects} value={project} onChange={setProject} />
        <TextField size="small" placeholder={`Search ${mine.length} terms`} value={q}
                   onChange={(e) => setQ(e.target.value)} sx={{ width: 300 }} />
      </Stack>

      <Box sx={{ display: "flex", gap: 1.5, flexWrap: "wrap", mb: 3 }}>
        <Tile n={open.length} label="Not pinned down" hint="no records behind the word yet" />
        <Tile n={pinned.length} label="Pinned down" hint="points at a real population" />
        <Tile n={cleared.length} label="Not a term" hint="cleared as decomposer noise" />
      </Box>

      {/* ⚠ The adapter notice belongs here as much as on a requirement: without
          it a person can say what a word means and cannot see how many records
          that would examine. A missing answer, which is not an empty one. */}
      <Alert severity="info" sx={{ mb: 2 }}>
        <b>No grounding adapter is answering.</b> Candidate readings and their record counts come
        from the project&rsquo;s own environment — spec never queries a project database.
      </Alert>

      <Stack spacing={0.75}>
        {shown.map((e) => (
          <Paper key={`${e.project}/${e.surface}`} variant="outlined"
                 component={Link} href={termHref(e)}
                 sx={{ p: 1.5, display: "block", textDecoration: "none", color: "inherit",
                       "&:hover": { borderColor: "primary.main" } }}>
            <Stack direction="row" spacing={1.5} alignItems="center">
              <Typography sx={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, minWidth: 220,
                                textDecoration: e.standing === "cleared" ? "line-through" : undefined,
                                color: e.standing === "cleared" ? "text.disabled" : undefined }}>
                {e.surface}
              </Typography>
              <Typography sx={{ flex: 1, fontSize: 12.5, color: "text.secondary" }}>
                {e.boundTo ? (
                  <Box component="code" sx={{ fontFamily: MONO }}>{e.boundTo}</Box>
                ) : (
                  `${e.claims.length} ${e.claims.length === 1 ? "claim waits" : "claims wait"} on it`
                )}
              </Typography>
              <Stack direction="row" spacing={0.75} sx={{ flexShrink: 0 }}>
                {e.pending ? (
                  <Chip size="small" color="info" variant="outlined" label="proposed" sx={{ fontSize: 10 }} />
                ) : null}
                <Chip size="small" variant="outlined" sx={{ fontSize: 10 }}
                      color={e.standing === "pinned" ? "success" : e.standing === "open" ? "warning" : "default"}
                      label={STANDING_LABEL[e.standing]} />
              </Stack>
            </Stack>
          </Paper>
        ))}
      </Stack>
    </>
  );
}
