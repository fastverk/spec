import { useEffect, useMemo, useState } from "react";
import {
  Alert, Box, Card, CardContent, Chip, Divider, List, ListItemButton,
  Stack, Typography,
} from "@mui/material";
import {
  NoReadingProposed, probe,
  type Candidate, type ProbeResult, type Requirement, type Term,
} from "../api";
import { MONO, SERIF } from "../theme";

/**
 * The grounding conversation.
 *
 * A person is asked ONE question — which set of records did you mean — and is
 * shown POPULATIONS rather than a schema. Someone who has never seen the data
 * model can still say which set is the one they meant; nobody can pick a column.
 *
 * Three states have to stay distinct, and collapsing any pair is the bug this
 * whole screen exists to prevent:
 *
 *   n > 0        a real population; the check would examine these
 *   0            the reading resolves and matches NOTHING — an invariant
 *                grounded here reports PASS forever having examined nothing
 *   unavailable  the project cannot express this reading at all; the check
 *                could never run
 *
 * ## The queue is the corpus, not a list someone typed
 *
 * Every term here came from //tools/import/decompose.py reading the author's own
 * `code spans` and **emphasis**. This pane used to carry a two-entry hard-coded
 * map, which made it a demo of grounding rather than the grounding of anything.
 * Ordering is by how many claims depend on the term, because that IS the
 * priority: `sponsor:edit` blocks eleven claims and `book team` blocks one.
 */
function countLabel(c: Candidate): string {
  if (!c.available) return "—";
  return c.count === null ? "—" : c.count.toLocaleString();
}

function severity(c: Candidate): "ok" | "empty" | "absent" {
  if (!c.available) return "absent";
  return c.count === 0 ? "empty" : "ok";
}

function CandidateCard({ c }: { c: Candidate }) {
  const s = severity(c);
  const border =
    s === "absent" ? "error.main" : s === "empty" ? "warning.main" : "divider";

  return (
    <Card variant="outlined" sx={{ borderColor: border, borderLeftWidth: 3 }}>
      <CardContent sx={{ pb: 2 }}>
        <Stack direction="row" spacing={2} alignItems="baseline">
          <Typography variant="h2" sx={{ fontSize: 15.5, fontWeight: 650 }}>
            {c.label}
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Typography
            sx={{
              fontFamily: MONO,
              fontSize: 22,
              fontWeight: 700,
              fontVariantNumeric: "tabular-nums",
              color:
                s === "absent" ? "error.main" : s === "empty" ? "warning.main" : "text.primary",
            }}
          >
            {countLabel(c)}
          </Typography>
        </Stack>

        {c.locator ? (
          <Typography sx={{ fontFamily: MONO, fontSize: 11.5, color: "text.secondary", mt: 0.5 }}>
            {c.locator}
          </Typography>
        ) : null}

        {/* The distinction the design turns on, stated in the UI rather than
            left for the reader to infer from a number. */}
        {s === "empty" ? (
          <Alert severity="warning" sx={{ mt: 1.5, py: 0.5 }}>
            <b>Matches nothing.</b> An invariant grounded here would examine no
            records and report success forever.
          </Alert>
        ) : null}
        {s === "absent" ? (
          <Alert severity="error" sx={{ mt: 1.5, py: 0.5 }}>
            <b>No referent.</b> This product cannot express this reading, so the
            check could never run — which is not the same as it passing.
          </Alert>
        ) : null}

        {c.caveat ? (
          <Typography variant="body2" sx={{ mt: 1.5, color: "text.secondary" }}>
            {c.caveat}
          </Typography>
        ) : null}

        {c.examples.length ? (
          <>
            <Divider sx={{ my: 1.5 }} />
            <Stack spacing={0.5}>
              {c.examples.map((e, i) => (
                <Typography key={i} sx={{ fontFamily: MONO, fontSize: 11.5, color: "text.secondary" }}>
                  <Box component="span" sx={{ color: "text.primary", fontWeight: 600 }}>
                    {e.label}
                  </Box>
                  {" — "}
                  {e.detail}
                </Typography>
              ))}
            </Stack>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** A surface, the claims waiting on it, and whether anyone has bound it. */
type Hole = {
  surface: string;
  claims: string[];
  open: boolean;
  boundTo: string;
};

function holesOf(terms: Term[]): Hole[] {
  const by = new Map<string, Hole>();
  for (const t of terms) {
    const h = by.get(t.surface) ?? {
      surface: t.surface, claims: [], open: true, boundTo: "",
    };
    h.claims.push(t.requirement_id);
    if (!t.open) {
      h.open = false;
      h.boundTo = t.bound_to;
    }
    by.set(t.surface, h);
  }
  return [...by.values()].sort(
    (a, b) => b.claims.length - a.claims.length || a.surface.localeCompare(b.surface),
  );
}

/**
 * Surfaces that normalize to the same string.
 *
 * ⚠ Shown, never merged. The document writes `admin`, `org admin`, `org admins`,
 * `SAVVI admin` and `platform admin`; whether those are one term or five is a
 * judgement about the business, and a normalizer that quietly folded them would
 * ground four terms nobody looked at.
 */
function lookalikes(hole: Hole, all: Hole[]): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "").replace(/s$/, "");
  const k = norm(hole.surface);
  return all.filter((h) => h.surface !== hole.surface && norm(h.surface) === k).map((h) => h.surface);
}

export function Grounding({
  terms,
  requirements,
  initialSurface = "",
}: {
  terms: Term[];
  requirements: Requirement[];
  initialSurface?: string;
}) {
  const holes = useMemo(() => holesOf(terms), [terms]);
  const [selected, setSelected] = useState<string>(initialSurface);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [unproposed, setUnproposed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hole = holes.find((h) => h.surface === selected) ?? holes[0];

  useEffect(() => setSelected(initialSurface), [initialSurface]);

  useEffect(() => {
    if (!hole) return;
    let live = true;
    setResult(null);
    setError(null);
    setUnproposed(false);
    probe(hole.claims[0] ?? "", hole.surface)
      .then((r) => live && setResult(r))
      .catch((e) => {
        if (!live) return;
        if (e instanceof NoReadingProposed) setUnproposed(true);
        else setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [hole?.surface]);

  if (!hole) {
    return (
      <Box>
        <Typography variant="h1" sx={{ fontSize: 26, mb: 1 }}>Grounding</Typography>
        <Alert severity="info">
          <b>Nothing has been decomposed yet.</b> Grounding binds the terms a
          requirement depends on, and this project's requirements have not been
          broken into terms — so there is nothing here to point at. Run the
          decomposer over the corpus first.
        </Alert>
      </Box>
    );
  }

  const openCount = holes.filter((h) => h.open).length;
  const promise = requirements.find((r) => r.requirement_id === hole.claims[0])?.predicate ?? "";
  const alike = lookalikes(hole, holes);

  return (
    <Box>
      <Stack direction="row" spacing={2} alignItems="baseline" sx={{ mb: 0.5 }}>
        <Typography variant="h1" sx={{ fontSize: 26 }}>Grounding</Typography>
        <Chip
          size="small"
          color={openCount ? "warning" : "success"}
          label={`${openCount} of ${holes.length} terms unbound`}
        />
      </Stack>
      <Typography variant="body2" sx={{ color: "text.secondary", mb: 2.5, maxWidth: "72ch" }}>
        Each term below is a word the requirements lean on. Until someone says
        which records it points at, every claim depending on it is a sentence,
        not a control.
      </Typography>

      <Stack direction="row" spacing={3} alignItems="flex-start">
        <Box sx={{ width: 250, flexShrink: 0, maxHeight: "70vh", overflowY: "auto" }}>
          <List dense disablePadding>
            {holes.map((h) => (
              <ListItemButton
                key={h.surface}
                selected={h.surface === hole.surface}
                onClick={() => setSelected(h.surface)}
                sx={{ borderRadius: 1, mb: 0.25, alignItems: "baseline" }}
              >
                <Typography
                  sx={{
                    fontFamily: MONO, fontSize: 12, flex: 1,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    color: h.open ? "text.primary" : "success.main",
                  }}
                >
                  {h.surface}
                </Typography>
                <Typography
                  sx={{
                    fontFamily: MONO, fontSize: 11, color: "text.secondary",
                    fontVariantNumeric: "tabular-nums", ml: 1,
                  }}
                >
                  {h.claims.length}
                </Typography>
              </ListItemButton>
            ))}
          </List>
        </Box>

        <Box sx={{ flex: 1, minWidth: 0 }}>
          {promise ? (
            <Typography sx={{ fontFamily: SERIF, fontSize: 19, lineHeight: 1.5, maxWidth: "58ch" }}>
              {promise}
            </Typography>
          ) : null}

          <Stack direction="row" spacing={1} sx={{ mt: 1.5, mb: 3, flexWrap: "wrap", gap: 0.75 }}>
            {hole.claims.map((c) => (
              <Chip key={c} size="small" label={c} sx={{ fontFamily: MONO }} />
            ))}
          </Stack>

          <Typography variant="h2" sx={{ mb: 0.5 }}>
            Which records does{" "}
            <Box component="span" sx={{ fontFamily: MONO }}>{hole.surface}</Box>{" "}
            point at?
          </Typography>
          <Typography variant="body2" sx={{ color: "text.secondary", mb: 2, maxWidth: "64ch" }}>
            {hole.claims.length === 1
              ? "One claim depends on this term."
              : `${hole.claims.length} claims depend on this term, so a wrong answer here is wrong ${hole.claims.length} times.`}
          </Typography>

          {alike.length ? (
            <Alert severity="info" sx={{ mb: 2 }}>
              <b>The document also writes {alike.map((s) => `“${s}”`).join(", ")}.</b>{" "}
              These were kept separate on purpose — if they mean the same thing,
              that is your call to make, not the importer's.
            </Alert>
          ) : null}

          {unproposed ? (
            <Alert severity="warning">
              <b>No reading has been proposed for this term.</b> The product
              answered, and its answer was that nothing in its referent registry
              claims to speak for <code>{hole.surface}</code>. That is an open
              hole, not a failure — someone who knows the data model has to
              propose what this term could point at before anyone can choose.
            </Alert>
          ) : null}

          {error ? (
            <Alert severity="info">
              <b>No grounding adapter is answering.</b> {error}
              <br />
              The product answers this question in its own environment — spec
              never queries a product database — so with the adapter down there
              is nothing to show. That is a missing answer, not an empty one.
            </Alert>
          ) : null}

          {!result && !error && !unproposed ? (
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              asking {hole.surface}…
            </Typography>
          ) : null}

          <Stack spacing={1.5}>
            {result?.candidates.map((c) => <CandidateCard key={c.locator || c.label} c={c} />)}
          </Stack>

          {result ? (
            <Typography variant="body2" sx={{ color: "text.secondary", mt: 2.5, maxWidth: "64ch" }}>
              Choosing a reading here would bind{" "}
              <Box component="span" sx={{ fontFamily: MONO }}>{hole.surface}</Box>{" "}
              for all {hole.claims.length} claim{hole.claims.length === 1 ? "" : "s"}.
              Binding is not yet wired to a store, so nothing you pick persists.
            </Typography>
          ) : null}
        </Box>
      </Stack>
    </Box>
  );
}
