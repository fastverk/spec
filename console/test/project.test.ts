/**
 * Which project a pane opens on, and what it does with a row that names none.
 *
 * These are display rules, not safety rules, so they live here rather than in
 * `conformance/` — nothing in `services/spec` has an opinion about which project
 * a console shows first. What is worth pinning is the wildcard: `inProject` is
 * the only reason a claim proposed without a `project` is visible anywhere, and a
 * plausible-looking `r.project === p` would delete it from every pane at once.
 */
import { describe, expect, it } from "vitest";

import type { Row } from "../lib/overlay";
import { DEFAULT_PROJECT, inProject, openingProject, projectsIn } from "../lib/project";

const row = (project?: string): Row => (project === undefined ? {} : { project });

describe("projectsIn", () => {
  it("deduplicates and sorts", () => {
    expect(projectsIn([row("studio"), row("ampere"), row("studio")])).toEqual(["ampere", "studio"]);
  });

  it("drops the empty project rather than offering it as a menu item", () => {
    // A blank `<MenuItem>` is not a project, and the pane that built its list
    // with a bare `.map()` offered one.
    expect(projectsIn([row("studio"), row(""), row()])).toEqual(["studio"]);
  });

  it("ignores a non-string project without throwing", () => {
    expect(projectsIn([{ project: 7 } as unknown as Row, row("studio")])).toEqual(["studio"]);
  });
});

describe("openingProject", () => {
  it("prefers the default when the corpus has it", () => {
    expect(openingProject(["ampere", "studio"])).toBe(DEFAULT_PROJECT);
    expect(DEFAULT_PROJECT).toBe("studio");
  });

  it("falls back to the first available, not to a project that is not there", () => {
    // Naming an absent project would render a blank picker over an empty list,
    // which reads as "nothing here" rather than "not this corpus".
    expect(openingProject(["ampere"])).toBe("ampere");
  });

  it("is the empty string when there is nothing to open on", () => {
    expect(openingProject([])).toBe("");
  });
});

describe("inProject", () => {
  it("keeps the project's own rows and excludes another project's", () => {
    expect(inProject(row("studio"), "studio")).toBe(true);
    expect(inProject(row("ampere"), "studio")).toBe(false);
  });

  it("shows an unscoped row in EVERY project, never in none", () => {
    // `assertNS` and `bindTerm` both take `project` optionally. A row without one
    // belongs to every corpus that uses it — the rule `overlay.find()` already
    // applies to terms — so filtering it out everywhere would hide an adopted
    // proposal from the author who made it, with nothing on screen saying so.
    for (const p of ["studio", "ampere", ""]) {
      expect(inProject(row(""), p)).toBe(true);
      expect(inProject(row(), p)).toBe(true);
    }
  });
});
