"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import { useCallback, useMemo, useReducer } from "react";

import { advise, extract } from "../../../lib/decompose";
import { measurement, stateOf } from "../../../lib/evaluated";
import type { GroundingSuggestion } from "../../../lib/grounding-suggestions";
import { suggestionsFromTerms } from "../../../lib/grounding-suggestions";
import { groundingOf, type TermStanding } from "../../../lib/grounded";
import type { Row } from "../../../lib/overlay";
import { GroundingAdapterNotice } from "../../GroundingAdapterNotice";
import { GroundingComposer } from "../../GroundingComposer";
import { MONO } from "../../theme";
import { OverlayError, ReadOnly, StateChip } from "../../ui";
import { submitOp, useOverlay } from "../../useOverlay";
import { useProposalMutation } from "../../useProposalMutation";
import { useTermDecision } from "../../useTermDecision";
import { useTextMarker } from "../../useTextMarker";
import { Predicate, PredicateLegend } from "./Predicate";

type EditMode = "reword" | "withdraw" | null;

type RevisionState = {
  mode: EditMode;
  draft: string;
  reason: string;
};

type RevisionAction =
  | { type: "open"; mode: Exclude<EditMode, null>; text: string }
  | { type: "draft"; value: string }
  | { type: "reason"; value: string }
  | { type: "close" };

function revisionReducer(state: RevisionState, action: RevisionAction): RevisionState {
  switch (action.type) {
    case "open":
      return { mode: action.mode, draft: action.text, reason: "" };
    case "draft":
      return { ...state, draft: action.value };
    case "reason":
      return { ...state, reason: action.value };
    case "close":
      return { ...state, mode: null };
  }
}

function RequirementActions({ id, text, parent, writeEnabled, ready, onDone }: {
  id: string;
  text: string;
  parent: string;
  writeEnabled: boolean;
  ready: boolean;
  onDone: () => void;
}) {
  const [form, dispatch] = useReducer(
    revisionReducer,
    { mode: null, draft: text, reason: "" },
  );
  const { mode, draft, reason } = form;
  const mutation = useProposalMutation();
  const setDraft = useCallback((value: string) => dispatch({ type: "draft", value }), []);
  const { inputRef: editor, markSelection } = useTextMarker(draft, setDraft);
  const terms = useMemo(() => extract(draft), [draft]);
  const advice = useMemo(() => advise(draft), [draft]);

  function open(next: Exclude<EditMode, null>) {
    dispatch({ type: "open", mode: next, text });
    mutation.clear();
  }

  async function submit(op: "amendNS" | "retractNS", fields: Record<string, unknown>) {
    await mutation.run(
      () => submitOp(op, { subject: id, ...fields }, parent),
      (
        op === "amendNS"
          ? "Rewording proposed. The adopted requirement is unchanged until this proposal is promoted."
          : "Withdrawal proposed. The requirement remains in the adopted spec until this proposal is promoted."
      ),
      () => {
        dispatch({ type: "close" });
        onDone();
      },
    );
  }

  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, sm: 2.5 }, mb: 2.5 }}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ sm: "center" }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h2" sx={{ fontSize: 15 }}>Change this requirement</Typography>
          <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.35 }}>
            Changes are recorded as reviewable proposals; the adopted spec is never edited in place.
          </Typography>
        </Box>
        {writeEnabled ? (
          <Stack direction="row" spacing={1}>
            <Button size="small" variant="outlined" onClick={() => open("reword")}>Reword</Button>
            <Button size="small" variant="outlined" color="error" onClick={() => open("withdraw")}>Withdraw</Button>
          </Stack>
        ) : !ready ? (
          <Typography variant="body2" sx={{ color: "text.secondary", fontSize: 12.5 }}>
            Checking whether proposals are enabled…
          </Typography>
        ) : null}
      </Stack>

      {mutation.note ? <Alert severity="success" sx={{ mt: 2 }}>{mutation.note}</Alert> : null}
      {mutation.error ? <Alert severity="error" sx={{ mt: 2 }}><b>Not recorded.</b> {mutation.error}</Alert> : null}

      {mode === "reword" ? (
        <>
          <Divider sx={{ my: 2.5 }} />
          <Typography variant="h2" sx={{ fontSize: 15, mb: 0.5 }}>Propose new wording</Typography>
          <Typography variant="body2" sx={{ color: "text.secondary", mb: 1.5 }}>
            Keep the meaning focused on one rule. Mark every concept that must eventually point at real records.
          </Typography>
          <TextField
            inputRef={editor}
            fullWidth
            multiline
            minRows={4}
            label="Revised requirement"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Stack direction="row" spacing={1} sx={{ mt: 1.25, flexWrap: "wrap", gap: 1 }}>
            <Button size="small" variant="outlined" onClick={() => markSelection("`")}>Mark system field</Button>
            <Button size="small" variant="outlined" onClick={() => markSelection("**")}>Mark business term</Button>
            <Chip
              size="small"
              variant="outlined"
              color={advice.kind === "none" ? "warning" : advice.kind === "dropped" ? "info" : "success"}
              label={`${terms.length} ${terms.length === 1 ? "concept" : "concepts"} marked`}
              sx={{ alignSelf: "center" }}
            />
          </Stack>
          <Alert severity={advice.kind === "none" ? "warning" : advice.kind === "dropped" ? "info" : "success"} sx={{ mt: 1.5 }}>
            {advice.message}
          </Alert>
          <Paper variant="outlined" sx={{ p: 2, mt: 1.5, bgcolor: "action.hover" }}>
            <Typography sx={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "text.secondary", mb: 1 }}>
              Review preview
            </Typography>
            <Predicate text={draft} standings={[]} />
          </Paper>
          <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mt: 2 }}>
            <Button size="small" color="inherit" onClick={() => dispatch({ type: "close" })}>Cancel</Button>
            <Button
              size="small"
              variant="contained"
              disabled={mutation.busy || !draft.trim() || draft.trim() === text.trim()}
              onClick={() => submit("amendNS", { text: draft.trim() })}
            >
              {mutation.busy ? "Recording…" : "Propose rewording"}
            </Button>
          </Stack>
        </>
      ) : null}

      {mode === "withdraw" ? (
        <>
          <Divider sx={{ my: 2.5 }} />
          <Alert severity="warning" sx={{ mb: 2 }}>
            Withdrawing removes this requirement from the active spec after review and promotion. It does not erase its history.
          </Alert>
          <TextField
            fullWidth
            multiline
            minRows={2}
            label="Reason for withdrawal"
            placeholder="Explain why this requirement should no longer apply."
            value={reason}
            onChange={(e) => dispatch({ type: "reason", value: e.target.value })}
            helperText="Required so reviewers can distinguish an intentional withdrawal from a mistake."
          />
          <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mt: 2 }}>
            <Button size="small" color="inherit" onClick={() => dispatch({ type: "close" })}>Cancel</Button>
            <Button
              size="small"
              variant="contained"
              color="error"
              disabled={mutation.busy || !reason.trim()}
              onClick={() => submit("retractNS", { reason: reason.trim() })}
            >
              {mutation.busy ? "Recording…" : "Propose withdrawal"}
            </Button>
          </Stack>
        </>
      ) : null}
    </Paper>
  );
}

/**
 * One step of the grounding walkthrough: a single word, and the decision it is
 * waiting on.
 *
 * ⛔ The decision offered is "what does this point at", never "does the claim
 * hold". Binding names a referent; it does not measure one and does not decide a
 * predicate. There is no field here that takes a count, because the count comes
 * from the project's own environment or it does not exist.
 */
function Step({ term, project, parent, writeEnabled, ready, suggestions, onDone }: {
  term: TermStanding; project: string; parent: string;
  writeEnabled: boolean;
  suggestions: GroundingSuggestion[];
  /** The overlay has answered. Distinguishes "writes are off" from "still asking". */
  ready: boolean;
  onDone: () => void;
}) {
  const { definition, reason, busy, error, note, setDefinition, setReason, act } =
    useTermDecision(project, parent, onDone);

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 1.5 }}>
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1 }}>
        <Typography sx={{ fontFamily: MONO, fontSize: 14, fontWeight: 700 }}>{term.surface}</Typography>
        {term.alsoBlocks > 0 ? (
          <Chip
            size="small" variant="outlined" sx={{ fontSize: 10.5 }}
            label={`also blocks ${term.alsoBlocks} other ${term.alsoBlocks === 1 ? "claim" : "claims"}`}
          />
        ) : null}
        {term.pending ? (
          <Chip size="small" color="info" variant="outlined" sx={{ fontSize: 10.5 }}
                label={`proposed by ${term.pendingBy}`} />
        ) : null}
      </Stack>

      {/* The leverage, said out loud. Grounding is shared work: one binding can
          resolve this word everywhere it appears, and a person deciding whether
          it is worth the thought deserves to know that. */}
      {term.alsoBlocks > 0 ? (
        <Typography variant="body2" sx={{ color: "text.secondary", mb: 1.5, fontSize: 12.5 }}>
          Deciding this once settles it for every claim that uses the word.
        </Typography>
      ) : null}

      {note ? <Alert severity="success" sx={{ mb: 1.5 }}>{note}</Alert> : null}
      {error ? <Alert severity="error" sx={{ mb: 1.5 }}><b>Not recorded.</b> {error}</Alert> : null}

      {/* A control that is absent with no stated reason reads as "not possible"
          rather than "not yet". `data` is null only while the overlay is in
          flight, which is a different fact from writes being disabled — and the
          ReadOnly banner only covers the second. */}
      {!writeEnabled && !ready ? (
        <Typography variant="body2" sx={{ color: "text.secondary", fontSize: 12.5 }}>
          Checking whether writes are enabled…
        </Typography>
      ) : null}

      {writeEnabled ? (
        <>
          <GroundingComposer
            value={definition}
            onChange={setDefinition}
            suggestions={suggestions}
            disabled={busy}
          />
          <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: "wrap", gap: 1 }}>
            <Button size="small" variant="contained" disabled={busy || !definition.trim()}
                    onClick={() => act("bindTerm", { term: term.surface, definition: definition.trim() },
                      `${term.surface} now means ${definition.trim()} — proposed, not yet adopted.`)}>
              Record this reading
            </Button>
            <TextField size="small" value={reason} onChange={(e) => setReason(e.target.value)}
                       placeholder="why (optional)" sx={{ width: 200 }} />
            <Button size="small" color="inherit" variant="outlined" disabled={busy}
                    onClick={() => act("retractTerm",
                      reason.trim() ? { term: term.surface, reason: reason.trim() } : { term: term.surface },
                      `${term.surface} is not a term — it leaves the queue.`)}>
              Not a term
            </Button>
          </Stack>
        </>
      ) : null}
    </Paper>
  );
}

function ReadinessLadder({ decomposed, grounded, measured, enforced, rung }: {
  decomposed: boolean;
  grounded: boolean;
  measured: boolean;
  enforced: boolean;
  rung: string;
}) {
  const stages = [
    { label: "Written", detail: "The rule exists in the spec.", done: true },
    { label: "Concepts identified", detail: "Its load-bearing words are explicit.", done: decomposed },
    { label: "Concepts grounded", detail: "Every word points at real project records.", done: grounded },
    { label: "Population measured", detail: "A check has examined a non-empty population.", done: measured },
    { label: "Enforced", detail: "A passing verdict protects the requirement.", done: enforced },
  ];
  const next = stages.findIndex((stage) => !stage.done);

  return (
    <Paper variant="outlined" sx={{ mb: 2.5, overflow: "hidden" }}>
      <Stack direction="row" alignItems="baseline" spacing={1.5} sx={{ px: 2.5, py: 1.75, bgcolor: "action.hover" }}>
        <Typography variant="h2" sx={{ fontSize: 15 }}>Readiness path</Typography>
        <Chip size="small" variant="outlined" label={rung || "R0"} sx={{ fontFamily: MONO, fontSize: 10.5 }} />
        <Typography variant="body2" sx={{ color: "text.secondary", fontSize: 12 }}>
          Evidence moves the requirement forward; authors do not choose a rung.
        </Typography>
      </Stack>
      {stages.map((stage, index) => {
        const active = index === next;
        return (
          <Box
            key={stage.label}
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "30px 1fr", sm: "30px 170px 1fr auto" },
              gap: 1.25,
              alignItems: "center",
              px: 2.5,
              py: 1.25,
              borderTop: 1,
              borderColor: "divider",
              bgcolor: stage.done ? "color-mix(in srgb, var(--mui-palette-success-main) 7%, transparent)" : active ? "action.hover" : undefined,
            }}
          >
            <Box
              sx={{
                width: 24,
                height: 24,
                display: "grid",
                placeItems: "center",
                borderRadius: 1,
                border: 1,
                borderColor: stage.done ? "success.main" : active ? "warning.main" : "divider",
                color: stage.done ? "success.main" : active ? "warning.main" : "text.disabled",
                fontFamily: MONO,
                fontWeight: 700,
                fontSize: 11,
              }}
            >
              {stage.done ? "✓" : index + 1}
            </Box>
            <Typography sx={{ fontSize: 12.5, fontWeight: active || stage.done ? 650 : 500 }}>
              {stage.label}
            </Typography>
            <Typography variant="body2" sx={{ color: "text.secondary", fontSize: 12, gridColumn: { xs: "2", sm: "auto" } }}>
              {stage.detail}
            </Typography>
            {active ? (
              <Chip size="small" color="warning" variant="outlined" label="next" sx={{ fontSize: 10, justifySelf: "start" }} />
            ) : null}
          </Box>
        );
      })}
    </Paper>
  );
}

export function RequirementClient({ id, corpusReqs, corpusTerms }: {
  id: string; corpusReqs: Row[]; corpusTerms: Row[];
}) {
  const { data, error, refresh } = useOverlay();
  const reqs = data?.requirements ?? corpusReqs;
  const termRows = data?.terms ?? corpusTerms;
  const parent = data?.corpus_version ?? "";

  const req = useMemo(
    () => reqs.find((r) => String(r["requirement_id"] ?? "").toLowerCase() === id.toLowerCase()) ?? null,
    [reqs, id],
  );
  const g = useMemo(() => groundingOf(id, termRows), [id, termRows]);

  if (!req) {
    // ⚠ "Not in this corpus" is a different fact from "does not exist", and the
    // overlay may simply not have answered yet. Both are said.
    return (
      <Alert severity="warning">
        <b>{id.toUpperCase()} is not in this corpus.</b>{" "}
        {data ? "No claim with that id, and no pending proposal asserting one." : "Still reading the overlay…"}
      </Alert>
    );
  }

  const project = String(req["project"] ?? "");
  const text = String(req["predicate"] ?? "");
  const groundingSuggestions = suggestionsFromTerms(termRows, project);
  const meas = measurement(req);
  const populationMeasured = Boolean(meas) && Number(req["population"] ?? 0) > 0;
  const pct = g.live.length ? Math.round((g.bound / g.live.length) * 100) : 0;
  const inCorpus = corpusReqs.some(
    (r) => String(r["requirement_id"] ?? "").toLowerCase() === id.toLowerCase(),
  );
  const withdrawalPending = Boolean(req["retracted"]);

  return (
    <>
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 0.5, flexWrap: "wrap", gap: 1 }}>
        <Typography sx={{ fontFamily: MONO, fontSize: 20, fontWeight: 700 }}>
          {id.toUpperCase()}
        </Typography>
        <StateChip state={stateOf(req)} />
        {req["pending"] ? (
          <Chip size="small" color="info" variant="outlined" label="proposed" sx={{ fontSize: 10.5 }} />
        ) : null}
        <Box sx={{ flex: 1 }} />
        <Button size="small" component={Link} href="/requirements" color="inherit">
          ← all requirements
        </Button>
      </Stack>
      <Stack direction="row" spacing={1} sx={{ mb: 2.5, flexWrap: "wrap", gap: 0.75 }}>
        <Chip size="small" variant="outlined" label={project} sx={{ fontSize: 10.5 }} />
        <Chip size="small" variant="outlined" label={String(req["discipline"] ?? "")} sx={{ fontSize: 10.5 }} />
        <Chip size="small" variant="outlined" sx={{ fontFamily: MONO, fontSize: 10.5 }}
              label={String(req["modality"] ?? "").replace("_", " ")} />
      </Stack>

      {error ? <OverlayError message={error} /> : null}
      {data && !data.write_enabled ? <ReadOnly because={data.write_disabled_because} /> : null}

      <Paper variant="outlined" sx={{ p: { xs: 2.5, sm: 3.5 }, mb: 2.5 }}>
        <Predicate text={text} standings={g.terms} />
        <PredicateLegend />
      </Paper>

      {withdrawalPending ? (
        <Alert severity="warning" sx={{ mb: 2.5 }}>
          <b>Withdrawal proposed.</b> This remains part of the adopted spec until the proposal is reviewed and promoted.
        </Alert>
      ) : inCorpus ? (
        <RequirementActions
          id={id}
          text={text}
          parent={parent}
          writeEnabled={Boolean(data?.write_enabled)}
          ready={Boolean(data)}
          onDone={refresh}
        />
      ) : (
        <Alert severity="info" sx={{ mb: 2.5 }}>
          This is a new requirement proposal. Rewording and withdrawal become available after it is adopted; until then, review the original proposal.
        </Alert>
      )}

      <ReadinessLadder
        decomposed={g.terms.length > 0}
        grounded={g.state === "grounded"}
        measured={populationMeasured}
        enforced={stateOf(req) === "Enforced"}
        rung={String(req["rung"] ?? "")}
      />

      {/* ── the simple status ─────────────────────────────────────────────── */}
      <Paper variant="outlined" sx={{ p: 2.5, mb: 2.5 }}>
        <Stack direction="row" spacing={1.5} alignItems="baseline" sx={{ mb: 1 }}>
          <Typography variant="h2" sx={{ fontSize: 15 }}>{g.label}</Typography>
          <Box sx={{ flex: 1 }} />
          {g.live.length > 0 ? (
            <Typography sx={{ fontFamily: MONO, fontSize: 12, color: "text.secondary" }}>
              {g.bound}/{g.live.length}
            </Typography>
          ) : null}
        </Stack>
        {g.live.length > 0 ? (
          <LinearProgress
            variant="determinate" value={pct}
            color={g.state === "grounded" ? "success" : "warning"}
            sx={{ height: 6, borderRadius: 3, mb: 1.5 }}
          />
        ) : null}
        <Typography variant="body2" sx={{ color: "text.secondary" }}>{g.hint}</Typography>

        {/* ⛔ The measurement is reported SEPARATELY from the grounding, because
            they are different facts and the whole product exists to keep them
            apart. A requirement can be fully grounded and examine nothing. */}
        <Box sx={{ mt: 2, pt: 2, borderTop: 1, borderColor: "divider" }}>
          <Typography variant="h2" sx={{ fontSize: 13, mb: 0.5 }}>Has anything checked it?</Typography>
          {meas ? (
            <Stack direction="row" spacing={1} alignItems="center">
              <Chip size="small" label={meas.label}
                    color={meas.tone === "bad" ? "error" : meas.tone === "warn" ? "warning" : "success"} />
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                {String(req["outcome"] ?? "")} over {String(req["population"] ?? "")} records.
              </Typography>
            </Stack>
          ) : (
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              <b>No.</b> No measurement has ever run against this, so nothing is known about whether
              it holds — which is different from knowing it fails, and different again from
              examining zero records.
            </Typography>
          )}
        </Box>

        {/* The stale-blocker disclosure. Two answers exist and they disagree by
            construction until RFC-004 §5 lands; saying so beats quietly picking. */}
        {String(req["blocked_on"] ?? "") && g.state === "grounded" ? (
          <Alert severity="info" sx={{ mt: 2 }}>
            The corpus still records this as blocked on{" "}
            <Box component="code" sx={{ fontFamily: MONO }}>{String(req["blocked_on"])}</Box>. That
            string is written once at import and never recomputed, so it does not yet know about
            bindings made here. The count above is the live answer.
          </Alert>
        ) : null}
      </Paper>

      {/* ── the walkthrough ───────────────────────────────────────────────── */}
      {g.open.length > 0 ? (
        <>
          <Typography variant="h2" sx={{ fontSize: 15, mb: 0.5 }}>
            What it is waiting on
          </Typography>
          <Typography variant="body2" sx={{ color: "text.secondary", mb: 2 }}>
            One decision per word. Each is a judgement about your business — which real records the
            word refers to — and it is the one step in this pipeline a machine is not qualified to
            make on its own.
          </Typography>

          <GroundingAdapterNotice />

          {g.open.map((t) => (
            <Step key={t.surface} term={t} project={project} parent={parent}
                  writeEnabled={Boolean(data?.write_enabled)} ready={Boolean(data)}
                  suggestions={groundingSuggestions}
                  onDone={refresh} />
          ))}
        </>
      ) : null}

      {g.state === "not-decomposed" ? (
        <Alert severity="warning">
          <b>Nothing has read this for the words that carry weight.</b> Decomposition reads the
          author&rsquo;s own <Box component="code" sx={{ fontFamily: MONO }}>`code spans`</Box> and{" "}
          <b>**emphasis**</b> and infers nothing from prose. Rewording it with the load-bearing
          words marked is what gives it terms.
        </Alert>
      ) : null}
    </>
  );
}
