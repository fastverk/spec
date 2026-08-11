/**
 * Which project a pane opens on.
 *
 * The corpora are loaded as separate graphs and never merged, so every pane that
 * shows project-scoped rows has to pick one. Before this module each pane picked
 * for itself: two spelled the preference inline, one took `projects[0]` — which is
 * alphabetical, which is `ampere` — and Requirements had no notion of a project at
 * all and listed all 133 rows of both products interleaved, under 27 disciplines
 * from two businesses that share none.
 */
import type { Row } from "./overlay";

/**
 * ⚠ A DEFAULT, not a filter. Every project in the corpus stays in the payloads
 * and stays one click away in the picker, because dropping one would be a change
 * to what the gates measure wearing the clothes of a display change: `ampere`
 * carries every conflict (12), every envelope (2) and every witness row (33) in
 * the corpus, and `studio` has none of any of them — being prose at R0/R2 with no
 * typed quantities, nothing in it can produce an empty envelope or a modality
 * clash. A corpus without `ampere` would run the conflict and envelope gates over
 * rows that cannot trip them: a gate that examines nothing and reports success
 * forever, which is the shape this repo exists to refuse (invariant ③).
 *
 * So the default moves and the data stays.
 */
export const DEFAULT_PROJECT = "studio";

/** The projects named by a set of rows, deduplicated and in a stable order. */
export function projectsIn(rows: readonly Row[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    const p = typeof r["project"] === "string" ? r["project"] : "";
    if (p) seen.add(p);
  }
  return [...seen].sort();
}

/**
 * Whether a row belongs in the view of `project`.
 *
 * ⛔ A row that names NO project is shown in every view, never dropped from all of
 * them. This is the rule the overlay already applies to terms — `find()` falls
 * back to the surface-only key, so a `bindTerm` without a `project` binds that
 * surface in every corpus that uses it — and requirements inherit it because
 * `assertNS` takes `project` optionally too. Filtering with `r.project === p`
 * instead would make a claim proposed without a project invisible in every pane
 * of the console while sitting adopted in the log: the author submits, the list
 * does not change, and nothing anywhere says why.
 */
export function inProject(row: Row, project: string): boolean {
  const p = typeof row["project"] === "string" ? row["project"] : "";
  return p === "" || p === project;
}

/**
 * The project to open on, given what this corpus actually contains.
 *
 * ⛔ Falls back to the first available rather than to `DEFAULT_PROJECT` itself.
 * A `<Select>` whose value names no option renders blank and warns; worse, a pane
 * scoped to a project the corpus has never heard of shows an empty list, and an
 * empty list reads as "there is nothing here" rather than "you are looking at the
 * wrong corpus". Those are different facts and a pane must not conflate them.
 */
export function openingProject(available: readonly string[]): string {
  return available.includes(DEFAULT_PROJECT) ? DEFAULT_PROJECT : available[0] ?? "";
}
