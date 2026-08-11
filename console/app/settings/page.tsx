"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useEffect, useState } from "react";

import { MONO } from "../theme";
import { PaneHead } from "../ui";

type Health = {
  corpus_version: string;
  deployment: { commit: string; stage: string };
  rows: Record<string, number>;
  log_backend: "neon" | "jsonl" | "none";
  write_enabled: boolean;
  write_disabled_because: string;
  log_error: string;
  proposal_records: number;
  evaluation_records: number;
  principal: "present" | "absent";
  grounding_adapter: "configured" | "unset";
  adopt_with: string;
};

/**
 * What this deployment is actually serving.
 *
 * ⚠ Every value here is MEASURED, not written down. The portal's Settings pane
 * was a hard-coded table — it named an adapter URL that was true on one laptop,
 * and it would have gone on saying so from a deployment where the adapter was
 * never configured. A settings page that cannot be wrong about the settings is
 * not a settings page.
 */
function Line({ label, value, tone, hint }: {
  label: string; value: string; tone?: "ok" | "warn" | "bad"; hint?: string;
}) {
  const color = tone === "bad" ? "error.main" : tone === "warn" ? "warning.main" : "text.primary";
  return (
    <Box sx={{ py: 1.25, borderTop: 1, borderColor: "divider" }}>
      <Stack direction="row" spacing={2} alignItems="baseline">
        <Typography sx={{ fontSize: 13, minWidth: 200, color: "text.secondary" }}>{label}</Typography>
        <Typography sx={{ fontFamily: MONO, fontSize: 12.5, color, flex: 1, wordBreak: "break-all" }}>
          {value}
        </Typography>
      </Stack>
      {hint ? (
        <Typography sx={{ fontSize: 11.5, color: "text.secondary", ml: { sm: "216px" }, mt: 0.25 }}>
          {hint}
        </Typography>
      ) : null}
    </Box>
  );
}

export default function Page() {
  const [h, setH] = useState<Health | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health", { cache: "no-store" })
      .then((r) => r.json())
      .then(setH)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <>
      <PaneHead
        title="Settings"
        blurb="What this deployment is serving, measured rather than written down. Every line comes from /api/health, which is the same thing an operator can curl."
      />

      {err ? <Alert severity="error" sx={{ mb: 2 }}>Could not read /api/health. {err}</Alert> : null}
      {!h && !err ? <Typography variant="body2" sx={{ color: "text.secondary" }}>Reading…</Typography> : null}

      {h ? (
        <>
          {!h.write_enabled ? (
            <Alert severity="info" sx={{ mb: 2 }}>
              <b>Read-only.</b> {h.write_disabled_because}
            </Alert>
          ) : null}
          {h.log_error ? (
            <Alert severity="error" sx={{ mb: 2 }}>
              <b>The log could not be read.</b> {h.log_error} — pending state is missing, which is
              not the same as nothing being pending.
            </Alert>
          ) : null}

          <Paper variant="outlined" sx={{ p: 2.5, maxWidth: 860 }}>
            <Typography variant="h2" sx={{ fontSize: 13, mb: 1 }}>The build</Typography>
            <Line
              label="Serving commit"
              value={h.deployment?.commit || "unknown"}
              tone={h.deployment?.commit ? undefined : "warn"}
              hint={
                h.deployment?.commit
                  ? "The code answering this request, not the code on main. A fix that is merged and green is not yet a fix that is deployed."
                  : h.deployment?.stage === "local"
                    ? "Running outside Vercel, so there is no deployment to name."
                    : "Deployed, but the system environment variables are not exposed — this deployment cannot say which code it is running."
              }
            />
            <Line label="Stage" value={h.deployment?.stage || "unknown"} />

            <Typography variant="h2" sx={{ fontSize: 13, mt: 3, mb: 1 }}>The corpus</Typography>
            <Line
              label="Read point"
              value={h.corpus_version}
              hint="A constant of this build. Every proposal names it as its parent — there is no default, because a proposal made against a corpus you were not looking at is a different proposal."
            />
            {Object.entries(h.rows).map(([route, n]) => (
              <Line key={route} label={route} value={`${n} rows`} tone={n === 0 ? "warn" : undefined} />
            ))}

            <Typography variant="h2" sx={{ fontSize: 13, mt: 3, mb: 1 }}>The log</Typography>
            <Line
              label="Backend"
              value={h.log_backend}
              tone={h.log_backend === "none" ? "bad" : "ok"}
              hint={
                h.log_backend === "neon"
                  ? "Postgres, append-only: no UPDATE, no DELETE, enforced by trigger and by grant."
                  : h.log_backend === "jsonl"
                    ? "A local file. Local development only — serverless has no filesystem to append to."
                    : "Nowhere to append. The write path is off and every pane says so."
              }
            />
            <Line label="Proposals recorded" value={String(h.proposal_records)} />
            <Line label="Evaluations recorded" value={String(h.evaluation_records)} />
            <Line
              label="Adopt with"
              value={h.adopt_with}
              hint="Promotion is a deliberate step. Between someone clicking a button and the specification changing there is a diff a person can read, and gates that run over the result."
            />

            <Typography variant="h2" sx={{ fontSize: 13, mt: 3, mb: 1 }}>Identity and grounding</Typography>
            <Line
              label="You"
              value={h.principal === "present" ? "signed in" : "not signed in"}
              tone={h.principal === "present" ? "ok" : "warn"}
              hint={
                h.principal === "present"
                  ? "Writes are attributed to you."
                  : "Writes are refused rather than attributed to nobody."
              }
            />
            <Line
              label="Grounding adapter"
              value={h.grounding_adapter}
              tone={h.grounding_adapter === "configured" ? "ok" : "warn"}
              hint={
                h.grounding_adapter === "configured"
                  ? "A project answers population questions in its own environment. spec never queries a project database."
                  : "Unset. Terms can still be bound; how many records that would examine cannot be measured. A missing answer, which is not an empty one."
              }
            />
          </Paper>

          <Stack direction="row" spacing={1} sx={{ mt: 2, flexWrap: "wrap", gap: 1 }}>
            <Chip size="small" variant="outlined" label="spec never holds project data" />
            <Chip size="small" variant="outlined" label="zero is an exception, never a pass" />
            <Chip size="small" variant="outlined" label="nothing is attributed to nobody" />
            <Chip size="small" variant="outlined" label="the corpus is generated" />
          </Stack>
        </>
      ) : null}
    </>
  );
}
