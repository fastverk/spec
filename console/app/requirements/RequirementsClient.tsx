"use client";

import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import { useMemo, useState } from "react";

import { measurement, stateOf } from "../../lib/evaluated";
import { groundingOf } from "../../lib/grounded";
import type { Row } from "../../lib/overlay";
import { inProject, openingProject, projectsIn } from "../../lib/project";
import { MONO } from "../theme";
import { OverlayError, PaneHead, ProjectPicker, ReadOnly, StateChip } from "../ui";
import { useOverlay } from "../useOverlay";

/** `AUTH-2` before `AUTH-10`. */
function compareIds(a: string, b: string): number {
  const key = (s: string) => s.replace(/\d+/g, (d) => d.padStart(6, "0"));
  return key(a).localeCompare(key(b));
}

/**
 * The requirements, as a list of entities you open.
 *
 * ⛔ THE DRAWER IS GONE. Everything a person needs to do to a requirement —
 * read it with its load-bearing words marked, see whether they point anywhere,
 * ground the ones that do not — now lives at the requirement's own address. A
 * drawer cannot be linked to, cannot be sent to the person who owns the
 * decision, and put the grounding of one word in a different pane from the
 * sentence that needed it.
 */
export function RequirementsClient({ corpusReqs, corpusTerms }: { corpusReqs: Row[]; corpusTerms: Row[] }) {
  const { data, error } = useOverlay();
  const [q, setQ] = useState("");

  const reqs = data?.requirements ?? corpusReqs;
  const termRows = data?.terms ?? corpusTerms;

  const projectList = useMemo(() => projectsIn(corpusReqs), [corpusReqs]);
  const [project, setProject] = useState(() => openingProject(projectList));
  const mine = useMemo(() => reqs.filter((r) => inProject(r, project)), [reqs, project]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return mine
      .filter((r) => !needle ||
        String(r["requirement_id"]).toLowerCase().includes(needle) ||
        String(r["predicate"]).toLowerCase().includes(needle))
      .sort((a, b) => compareIds(String(a["requirement_id"]), String(b["requirement_id"])));
  }, [mine, q]);

  return (
    <>
      <PaneHead
        title="Requirements"
        blurb="What the document says, and how far each sentence has got toward being something a machine could check. Open one to see which of its words carry weight and whether they point at anything."
      />

      {error ? <OverlayError message={error} /> : null}
      {data && !data.write_enabled ? <ReadOnly because={data.write_disabled_because} /> : null}

      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 2, flexWrap: "wrap", gap: 1.5 }}>
        <ProjectPicker projects={projectList} value={project} onChange={setProject} />
        <TextField size="small" placeholder={`Search ${mine.length} requirements`} value={q}
                   onChange={(e) => setQ(e.target.value)} sx={{ width: 320 }} />
        {/* Writing is an ACTION ON the collection, not a separate place. */}
        <Button size="small" variant="outlined" component={Link} href="/requirements/new">
          New requirement
        </Button>
      </Stack>

      <Stack spacing={0.75}>
        {shown.map((r) => {
          const id = String(r["requirement_id"]);
          const meas = measurement(r);
          const g = groundingOf(id, termRows);
          return (
            <Paper key={id} variant="outlined"
                   component={Link} href={`/requirements/${encodeURIComponent(id)}`}
                   sx={{ p: 1.5, display: "block", textDecoration: "none", color: "inherit",
                         "&:hover": { borderColor: "primary.main" } }}>
              <Stack direction="row" spacing={1.5} alignItems="baseline">
                <Typography sx={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, minWidth: 128 }}>
                  {id.toUpperCase()}
                </Typography>
                <Typography sx={{ flex: 1, fontSize: 13.5, lineHeight: 1.45 }}>
                  {String(r["predicate"] ?? "").replace(/[`*]/g, "")}
                </Typography>
                <Stack direction="row" spacing={0.75} sx={{ flexShrink: 0 }}>
                  {r["pending"] ? <Chip size="small" color="info" variant="outlined" label="proposed" sx={{ fontSize: 10 }} /> : null}
                  {/* The grounding fraction, on every row. It is the number that
                      moves as work gets done, and the one the old list could not
                      show because it lived in another pane. */}
                  {g.live.length > 0 ? (
                    <Chip size="small" variant="outlined" sx={{ fontSize: 10, fontFamily: MONO }}
                          color={g.state === "grounded" ? "success" : "warning"}
                          label={`${g.bound}/${g.live.length} pinned`} />
                  ) : (
                    <Chip size="small" variant="outlined" sx={{ fontSize: 10 }} label="no terms" />
                  )}
                  {meas ? (
                    <Chip size="small" label={meas.label} sx={{ fontSize: 10 }}
                          color={meas.tone === "bad" ? "error" : meas.tone === "warn" ? "warning" : "success"} />
                  ) : null}
                  <StateChip state={stateOf(r)} />
                </Stack>
              </Stack>
            </Paper>
          );
        })}
      </Stack>
    </>
  );
}
