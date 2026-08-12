import { defineTool } from "eve/tools";
import { z } from "zod";

import { overlay } from "../lib/console";

/**
 * Read the corpus as the console shows it: pending proposals applied, so the
 * agent sees the same requirements a person looking at the pane sees.
 *
 * ⚠ Returns COUNTS and ROWS THE CONSOLE ALREADY SERVES, and nothing else. There
 * is no tool here that reaches a project's database, because spec never holds
 * project data — a project answers population questions in its own environment,
 * and no such adapter is answering yet. If the agent wants to know how many
 * records a term would examine, the honest answer is that nobody knows.
 */
export default defineTool({
  description:
    "Read requirements from the corpus, optionally filtered. Returns the requirement id, " +
    "its text with the author's markup intact, its discipline, what it is blocked on, and " +
    "whether a measurement has ever run against it. Use this to ground any statement about " +
    "what the corpus contains — never state a count you did not read here.",
  inputSchema: z.object({
    project: z.string().optional().describe("Restrict to one project, e.g. `studio`."),
    blocked_on: z
      .string()
      .optional()
      .describe("Only claims whose blocker starts with this slug, e.g. `not-decomposed`."),
    contains: z.string().optional().describe("Case-insensitive substring of the text or the id."),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  async execute({ project, blocked_on, contains, limit }) {
    const o = await overlay();
    const needle = contains?.toLowerCase();

    const rows = o.requirements.filter((r) => {
      const p = typeof r["project"] === "string" ? r["project"] : "";
      if (project && p && p !== project) return false;
      if (blocked_on && !String(r["blocked_on"] ?? "").startsWith(blocked_on)) return false;
      if (needle) {
        const hay = `${r["requirement_id"]} ${r["predicate"]}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });

    return {
      corpus_version: o.corpus_version,
      matched: rows.length,
      // ⛔ The truncation is REPORTED, not silent. A model handed 10 of 46 rows
      // with no note will describe the 10 as if they were the corpus.
      showing: Math.min(rows.length, limit),
      requirements: rows.slice(0, limit).map((r) => ({
        requirement_id: r["requirement_id"],
        // Markup INTACT. It is the input to decomposition, so stripping it here
        // would hand the model a sentence that decomposes differently.
        predicate: r["predicate"],
        discipline: r["discipline"],
        modality: r["modality"],
        blocked_on: r["blocked_on"],
        population: r["population"],
        outcome: r["outcome"],
        pending: Boolean(r["pending"]),
      })),
    };
  },
});
