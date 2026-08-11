"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useState } from "react";

import type { Row } from "../../lib/overlay";
import { inProject, openingProject } from "../../lib/project";
import { MONO } from "../theme";
import { NotBackedYet, PaneHead, ProjectPicker } from "../ui";

/**
 * ⚠ The field names here are the ones the emitter actually writes —
 * `id`, `party_count`, `state`, `outcome`, `blocked_orders` — not the ones the
 * portal's hand-written `Conflict` type declared. That type named `conflict`,
 * `witness`, `parties` and `resolution`, none of which exist in the payload, so
 * the pane rendered a blank party list, never showed a witness, never showed a
 * resolution, and keyed its rows on `undefined`. Nothing caught it, because a
 * TypeScript type over a payload nobody generates the type from is a comment.
 */
/**
 * ⚠ `projects` is the whole corpus's project list, NOT the projects that happen
 * to have conflicts. Deriving it from the rows made the picker disappear (one
 * distinct project among the rows is below `ProjectPicker`'s threshold) and
 * pinned the pane to `ampere`, which is the only project with any — so the pane
 * silently showed a different project than every other pane, and "the corpus has
 * conflicts" was indistinguishable from "this project has conflicts".
 */
export function ConflictsClient({ conflicts, witness, projects }: {
  conflicts: Row[]; witness: Row[]; projects: string[];
}) {
  const [project, setProject] = useState(() => openingProject(projects));
  const mine = conflicts.filter((c) => inProject(c, project));

  // The witness payload carries the parties of each conflict, one row each.
  const partiesOf = (id: string) =>
    witness.filter((w) => w["conflict_id"] === id).map((w) => String(w["claim_id"] ?? ""));

  return (
    <>
      <PaneHead
        title="Conflicts"
        blurb="Two requirements that cannot both hold. Once they are propositions rather than prose this is decidable, so it fails at authoring time instead of in production."
      />

      <ProjectPicker projects={projects} value={project} onChange={setProject} />

      {mine.length === 0 ? (
        <NotBackedYet
          what={
            // ⛔ Two different facts, and the test is `conflicts`, not `mine`.
            // "This corpus records none" and "this project has none" read the
            // same on screen and mean different things about the detector.
            conflicts.length === 0
              ? "No conflicts are recorded in any corpus. Empty means none found, not none looked for."
              : `No conflicts recorded for ${project}. Conflicts are found by comparing TYPED claims — ` +
                "if everything here is still prose, the detector has nothing two claims could disagree about."
          }
        />
      ) : (
        <Stack spacing={1.5}>
          {mine.map((c) => {
            const id = String(c["id"] ?? "");
            const parties = partiesOf(id);
            const resolved = c["state"] === "resolved";
            return (
              <Paper
                key={id}
                variant="outlined"
                sx={{ p: 2, borderLeft: 3, borderColor: resolved ? "success.main" : "error.main" }}
              >
                <Stack direction="row" spacing={1.5} alignItems="baseline" sx={{ flexWrap: "wrap" }}>
                  <Typography sx={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 700 }}>{id}</Typography>
                  <Typography sx={{ fontSize: 15, fontWeight: 650 }}>
                    {String(c["kind"] ?? "Conflict")}
                  </Typography>
                  <Box sx={{ flex: 1 }} />
                  <Chip
                    size="small"
                    variant={resolved ? "filled" : "outlined"}
                    color={resolved ? "success" : "error"}
                    label={resolved ? `resolved · ${String(c["outcome"] ?? "")}` : "open"}
                    sx={{ fontSize: 10.5 }}
                  />
                </Stack>

                {c["quantity"] ? (
                  <Typography sx={{ fontFamily: MONO, fontSize: 12, mt: 1 }}>
                    {String(c["quantity"])}
                  </Typography>
                ) : null}

                <Typography variant="body2" sx={{ mt: 1, color: "text.secondary", maxWidth: "80ch" }}>
                  {String(c["party_count"] ?? 0)} parties across {String(c["disciplines"] ?? "")}
                </Typography>

                {parties.length > 0 ? (
                  <Stack direction="row" spacing={0.75} sx={{ mt: 1, flexWrap: "wrap", gap: 0.75 }}>
                    {parties.map((p, i) => (
                      <Chip key={`${p}-${i}`} size="small" variant="outlined" label={p}
                            sx={{ fontFamily: MONO, fontSize: 10.5 }} />
                    ))}
                  </Stack>
                ) : null}

                <Typography variant="body2" sx={{ mt: 1.25, color: "text.secondary" }}>
                  {/* ⛔ An unowned conflict is not a conflict anybody can act on, and
                      saying so is the point of showing the field at all. */}
                  {c["owner"] ? `Owner: ${String(c["owner"])}` : "No owner assigned — cannot be acted on"}
                  {Number(c["blocked_orders"] ?? 0) > 0
                    ? ` · blocking ${String(c["blocked_orders"])} order(s)`
                    : ""}
                </Typography>
              </Paper>
            );
          })}
        </Stack>
      )}
    </>
  );
}
