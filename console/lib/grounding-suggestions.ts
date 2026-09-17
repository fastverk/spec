import type { Row } from "./overlay";

export type GroundingSuggestion = {
  locator: string;
  usedBy: string[];
  source: "existing" | "adapter";
  count?: number;
  caveat?: string;
};

/**
 * Existing project bindings are the only safe local autocomplete source.
 *
 * A locator is opaque to spec, so this deliberately does not parse expressions
 * or synthesize likely fields. Schema-backed suggestions belong to the project
 * adapter and can be merged into this same display type later.
 */
export function suggestionsFromTerms(
  rows: readonly Row[],
  project: string,
  omitSurface = "",
): GroundingSuggestion[] {
  const byLocator = new Map<string, Set<string>>();
  for (const row of rows) {
    const rowProject = typeof row["project"] === "string" ? row["project"] : "";
    const surface = typeof row["surface"] === "string" ? row["surface"].trim() : "";
    const locator = typeof row["bound_to"] === "string" ? row["bound_to"].trim() : "";
    if (
      locator === "" ||
      surface === omitSurface ||
      (rowProject !== "" && rowProject !== project)
    ) continue;
    const usedBy = byLocator.get(locator) ?? new Set<string>();
    if (surface) usedBy.add(surface);
    byLocator.set(locator, usedBy);
  }

  return [...byLocator.entries()]
    .map(([locator, usedBy]) => ({
      locator,
      usedBy: [...usedBy].sort(),
      source: "existing" as const,
    }))
    .sort((a, b) => a.locator.localeCompare(b.locator));
}
