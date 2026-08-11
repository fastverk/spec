import { Alert, Box, Paper, Stack, Typography } from "@mui/material";
import type { Conflict, Discipline, Requirement, Term } from "../api";
import { stateOf } from "../api";
import { Bar, PaneHead, Tile } from "../ui";
import { MONO } from "../theme";

/**
 * ⛔ The four state tiles replaced a funnel, and were worse.
 *
 * They read Draft 0 / In question 69 / Agreed 0 / Enforced 0 — one bucket
 * holding everything, three empty, and no way to tell the 23 requirements
 * nobody has even broken into terms from the 46 that are waiting on a person to
 * say what a word means. Those are different jobs for different people, and the
 * tiles said neither.
 *
 * A funnel says where the work actually is, in the order it has to happen.
 */
export function Overview({
  project, reqs, disc, confs, terms,
}: {
  project: string; reqs: Requirement[]; disc: Discipline[];
  confs: Conflict[]; terms: Term[];
}) {
  const mine = reqs.filter((r) => r.project === project);
  const byState = { Draft: 0, "In question": 0, Agreed: 0, Enforced: 0 } as Record<string, number>;
  for (const r of mine) byState[stateOf(r)] = (byState[stateOf(r)] ?? 0) + 1;
  const unchecked = mine.filter((r) => r.outcome === "NOT-EVALUATED").length;
  const areas = disc.filter((d) => d.project === project);
  const myConfs = confs.filter((c) => c.project === project);

  const myTerms = terms.filter((t) => t.project === project);
  const withTerms = new Set(myTerms.map((t) => t.requirement_id));
  const decomposed = mine.filter((r) => withTerms.has(r.requirement_id)).length;
  const surfaces = new Set(myTerms.map((t) => t.surface));
  const bound = new Set(myTerms.filter((t) => !t.open).map((t) => t.surface));
  const measured = mine.filter((r) => r.population !== "\u2014").length;

  // Per-area: the share NOT yet broken into terms. The old bar showed "not
  // backed by evidence", which is 100% for every area and therefore tells you
  // nothing about where to go next.
  const undecomposedPct = new Map<string, number>();
  for (const d of areas) {
    const rows = mine.filter((r) => r.discipline === d.discipline);
    const n = rows.filter((r) => !withTerms.has(r.requirement_id)).length;
    undecomposedPct.set(d.discipline, rows.length ? Math.round((n / rows.length) * 100) : 0);
  }

  return (
    <Box>
      <PaneHead
        title={project}
        sub={`${mine.length} requirements across ${areas.length} areas.`}
      />

      <Stack direction="row" spacing={1.5} sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
        <Tile n={mine.length} label="Written down" />
        <Tile n={decomposed} label="Broken into terms"
              tone={decomposed < mine.length ? "warn" : "good"} />
        <Tile n={bound.size} label="Terms pinned down"
              tone={bound.size ? "good" : "warn"} />
        {/* ⚠ "Measured", not "checked". A population is how many records a check
            WOULD examine; nothing here decides whether the requirement holds,
            because the predicate half does not exist yet. Labelling this
            "checked" would let the most important column in the product read as
            further along than it is. */}
        <Tile n={measured} label="Population measured"
              tone={measured ? "good" : "warn"} />
      </Stack>
      <Typography variant="body2" sx={{ color: "text.secondary", mb: 3 }}>
        Each step needs the one before it. {mine.length - decomposed} requirement
        {mine.length - decomposed === 1 ? " has" : "s have"} no terms yet;{" "}
        {surfaces.size - bound.size} of {surfaces.size} terms are still waiting for
        someone to say which records they point at.
      </Typography>

      {/* The headline, stated as a risk rather than a proof-theory metric. */}
      <Alert severity={unchecked === mine.length ? "warning" : "info"} sx={{ mb: 3 }}>
        <b>{unchecked} of {mine.length} requirements are checked by nothing.</b> If one
        stopped being true tomorrow, no build would fail and nobody would be told.
      </Alert>

      <Typography variant="h2" sx={{ mb: 1.5 }}>By area</Typography>
      <Stack spacing={0}>
        {areas
          .slice()
          .sort((a, b) => b.claim_count - a.claim_count)
          .map((d) => (
            <Paper key={d.discipline} variant="outlined"
              sx={{ p: 1.5, borderRadius: 0, borderTop: 0, "&:first-of-type": { borderTop: 1, borderColor: "divider" } }}>
              <Stack direction="row" spacing={2} alignItems="center">
                <Typography sx={{ flex: 1, fontSize: 14 }}>{d.discipline}</Typography>
                <Typography sx={{ fontFamily: MONO, fontSize: 13, width: 34, textAlign: "right" }}>
                  {d.claim_count}
                </Typography>
                <Bar pct={undecomposedPct.get(d.discipline) ?? 0} />
                <Typography sx={{ fontFamily: MONO, fontSize: 12, width: 52, textAlign: "right", color: "text.secondary" }}>
                  {undecomposedPct.get(d.discipline) ?? 0}%
                </Typography>
              </Stack>
            </Paper>
          ))}
      </Stack>
      <Typography variant="body2" sx={{ color: "text.secondary", mt: 1.5 }}>
        The bar is the share not yet broken into terms — the first step, and the
        one that decides where grounding can even begin.
      </Typography>

      {myConfs.length ? (
        <>
          <Typography variant="h2" sx={{ mt: 4, mb: 1.5 }}>Needs a decision</Typography>
          <Stack spacing={1}>
            {myConfs.slice(0, 3).map((c) => (
              <Paper key={c.conflict} variant="outlined" sx={{ p: 1.5, borderLeft: 3, borderColor: "error.main" }}>
                <Typography sx={{ fontSize: 14, fontWeight: 640 }}>{c.kind || "Conflict"}</Typography>
                <Typography variant="body2" sx={{ color: "text.secondary" }}>{c.witness}</Typography>
              </Paper>
            ))}
          </Stack>
        </>
      ) : null}
    </Box>
  );
}
