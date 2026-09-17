"use client";

import Box from "@mui/material/Box";
import Tooltip from "@mui/material/Tooltip";

import { spans } from "../../../lib/decompose";
import type { TermStanding } from "../../../lib/grounded";
import { MONO, SERIF } from "../../theme";

/**
 * The author's sentence, with every marked word coloured by whether it points at
 * anything yet.
 *
 * ⛔ THE MARKS ARE NOT DECORATION AND THIS IS NOT A MARKDOWN RENDERER. Every
 * other pane strips backticks and asterisks with `.replace(/[`*]/g, "")`, which
 * throws away the one thing that decides whether the claim can ever be checked.
 * Here the marks ARE the subject: a person should be able to look at a sentence
 * and see which of its words are load-bearing and which of those are still
 * pointing at nothing.
 *
 * Positions come from `spans()`, which is derived from the same single scan as
 * `extract()` — so what is highlighted here is exactly what became a term, and
 * the two cannot drift.
 */

type Tone = "bound" | "open" | "retracted" | "dropped" | "repeat";

const STYLE: Record<Tone, { sx: object; why: (s: string, d?: string) => string }> = {
  bound: {
    sx: {
      color: "success.main",
      borderBottom: "2px solid",
      borderColor: "success.main",
      fontWeight: 600,
    },
    why: (s, d) => `${s} points at ${d}`,
  },
  open: {
    // ⚠ Not red. An unbound term is unfinished work, not a defect — most of the
    // corpus is in this state and colouring it as an error would make the whole
    // document read as broken rather than as young.
    sx: {
      color: "warning.dark",
      borderBottom: "2px dashed",
      borderColor: "warning.main",
      fontWeight: 600,
    },
    why: (s) => `${s} does not point at any records yet — nothing can check this until it does`,
  },
  retracted: {
    sx: { color: "text.disabled", textDecoration: "line-through" },
    why: (s) => `${s} was cleared as not-a-term, so it holds nothing back`,
  },
  dropped: {
    sx: { color: "text.disabled", textDecoration: "line-through dotted" },
    why: (s) =>
      `"${s}" is bolded but longer than four words, so the decomposer reads it as stress rather ` +
      `than vocabulary and drops it`,
  },
  repeat: {
    sx: { color: "text.secondary", borderBottom: "1px dotted", borderColor: "text.disabled" },
    why: (s) => `the same term as the first ${s} — one word, one hole`,
  },
};

export function Predicate({ text, standings }: { text: string; standings: TermStanding[] }) {
  const by = new Map(standings.map((s) => [s.surface.toLowerCase(), s]));
  const marks = spans(text);

  const out: React.ReactNode[] = [];
  let at = 0;

  marks.forEach((m, i) => {
    if (m.start > at) out.push(<span key={`t${i}`}>{text.slice(at, m.start)}</span>);

    const st = by.get(m.surface.toLowerCase());
    const tone: Tone = m.dropped
      ? "dropped"
      : !m.isTerm
        ? "repeat"
        : st?.retracted || st?.retired
          ? "retracted"
          : st?.boundTo
            ? "bound"
            : "open";
    const style = STYLE[tone];

    out.push(
      <Tooltip key={`m${i}`} title={style.why(m.surface, st?.boundTo)} arrow>
        <Box
          component="span"
          sx={{
            ...style.sx,
            // A code span stays monospaced: the author chose backticks because
            // the word is a literal, and rendering it as prose loses that.
            fontFamily: m.source === "code-span" ? MONO : undefined,
            fontSize: m.source === "code-span" ? "0.92em" : undefined,
            cursor: "help",
            whiteSpace: "nowrap",
          }}
        >
          {/* The marks themselves are dropped from the DISPLAY, and only here.
              The stored text keeps them, because they are the input to
              decomposition and stripping them would change what the claim
              decomposes to. */}
          {text.slice(m.start, m.end).replace(/^(`|\*\*)/, "").replace(/(`|\*\*)$/, "")}
        </Box>
      </Tooltip>,
    );
    at = m.end;
  });

  if (at < text.length) out.push(<span key="tail">{text.slice(at)}</span>);

  return (
    <Box sx={{ fontFamily: SERIF, fontSize: 19, lineHeight: 1.65 }}>
      {out}
    </Box>
  );
}

/** The key, so the colours are readable rather than guessable. */
export function PredicateLegend() {
  const items: [Tone, string][] = [
    ["bound", "points at records"],
    ["open", "not pinned down"],
    ["retracted", "not a term"],
    ["dropped", "dropped: too long to be vocabulary"],
  ];
  return (
    <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap", mt: 1.5 }}>
      {items.map(([tone, label]) => (
        <Box key={tone} sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
          <Box component="span" sx={{ ...STYLE[tone].sx, fontSize: 12, fontFamily: MONO }}>
            term
          </Box>
          <Box component="span" sx={{ fontSize: 11.5, color: "text.secondary" }}>{label}</Box>
        </Box>
      ))}
    </Box>
  );
}
