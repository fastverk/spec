import { describe, expect, it } from "vitest";

import { suggestionsFromTerms } from "../lib/grounding-suggestions";

describe("suggestionsFromTerms", () => {
  it("deduplicates locators and names every term already using them", () => {
    expect(suggestionsFromTerms([
      { project: "studio", surface: "admin", bound_to: "memberships.role = 'admin'" },
      { project: "studio", surface: "org admins", bound_to: "memberships.role = 'admin'" },
    ], "studio")).toEqual([
      {
        locator: "memberships.role = 'admin'",
        usedBy: ["admin", "org admins"],
        source: "existing",
      },
    ]);
  });

  it("keeps project bindings isolated and includes explicitly global bindings", () => {
    const rows = [
      { project: "studio", surface: "admin", bound_to: "studio.admin" },
      { project: "ampere", surface: "capacity", bound_to: "ampere.capacity" },
      { project: "", surface: "global", bound_to: "shared.locator" },
    ];

    expect(suggestionsFromTerms(rows, "studio").map((item) => item.locator)).toEqual([
      "shared.locator",
      "studio.admin",
    ]);
  });

  it("omits the term currently being edited and ignores empty bindings", () => {
    expect(suggestionsFromTerms([
      { project: "studio", surface: "admin", bound_to: "memberships.role" },
      { project: "studio", surface: "public", bound_to: "" },
    ], "studio", "admin")).toEqual([]);
  });
});
