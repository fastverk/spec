/**
 * The read-model ingest contract, over payloads this console did not ship with.
 *
 * ⛔ The point of every case here is that the payloads come from SOMEWHERE ELSE.
 * The rules existed before #52 — `rowsOf` threw on a missing array,
 * `frozenReadPoint` threw on two corpora — and they were welded to eight static
 * imports, so nothing could ask the only question that matters for a second
 * tenant: *would a consumer's payloads pass, and what would they be told if not?*
 *
 * `test/fixtures/readmodel/` is a real emitter run over a corpus that is not this
 * repository's (see its README). Every refusal below is then a mutation of that
 * set — which is the shape a consumer's mistake actually takes.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PAYLOAD_FIELDS, ROUTES, ingest, type Payloads, type RouteName } from "../lib/readmodel";

const FIXTURE_VERSION = "corpus:73b24f9938dc48f4";

const at = (route: string) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/readmodel/${route}.json`, import.meta.url)), "utf8"),
  ) as Record<string, unknown>;

/** A fresh copy each time — the cases mutate it. */
const foreign = (): Payloads =>
  Object.fromEntries(ROUTES.map((r) => [r, at(r)])) as Payloads;

describe("ingest, over a corpus from outside this repository", () => {
  it("accepts a payload set the console did not ship with", () => {
    const model = ingest(foreign());
    expect(model.corpusVersion).toBe(FIXTURE_VERSION);
    // ⚠ Not this repository's. If these ever match, the fixture has been
    // regenerated from the wrong corpus and every case below is testing the
    // flagship against itself.
    //
    // ⛔ Read the flagship's version rather than hard-coding it. The first
    // version of this line pinned the literal `corpus:1d1d6b782d4b0b1a`, and it
    // went stale within the day — the ontology moved and the payloads were
    // re-emitted, so the assertion kept passing while no longer asserting the
    // thing it names.
    const flagship = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../services/spec/readmodel/claims.json", import.meta.url)), "utf8"),
    ) as { corpus_version?: string };
    expect(typeof flagship.corpus_version).toBe("string");
    expect(model.corpusVersion).not.toBe(flagship.corpus_version);
    expect(model.projects()).toEqual(["fixture"]);
  });

  it("reads each route's rows from ITS OWN field, not from the route name", () => {
    const model = ingest(foreign());
    // The two that disagree are the whole reason the table exists: `frontier`
    // carries `stalls` and `witness` carries `parties`. A reader that guessed
    // "the first array" would return `unreachable_repos` for both.
    expect(PAYLOAD_FIELDS.frontier).toBe("stalls");
    expect(PAYLOAD_FIELDS.witness).toBe("parties");
    expect(model.rowsOf("frontier").length).toBeGreaterThan(0);
    expect(model.rowsOf("witness").length).toBeGreaterThan(0);
  });

  it("hands back copies, so an overlay cannot edit the corpus", () => {
    const model = ingest(foreign());
    const first = model.rowsOf("requirements");
    first[0]!["predicate"] = "TAMPERED";
    expect(model.rowsOf("requirements")[0]!["predicate"]).not.toBe("TAMPERED");
  });

  it("⛔ refuses a set that spans two corpora, naming both", () => {
    const p = foreign();
    (p.terms as Record<string, unknown>)["corpus_version"] = "corpus:ffffffffffffffff";
    // The read point is a lie whichever one you pick, and an author would be
    // submitting proposals against it.
    expect(() => ingest(p)).toThrow(/payloads span 2 corpora/);
    expect(() => ingest(p)).toThrow(/corpus:73b24f9938dc48f4/);
    expect(() => ingest(p)).toThrow(/corpus:ffffffffffffffff/);
  });

  it("⛔ refuses a payload with no corpus_version at all", () => {
    const p = foreign();
    delete (p.claims as Record<string, unknown>)["corpus_version"];
    // Without one the console would have to invent a `parent`, which defeats the
    // check the door makes.
    expect(() => ingest(p)).toThrow(/`claims` carries no corpus_version/);
  });

  it("⛔ refuses rows under the wrong key, naming the key it wanted", () => {
    const p = foreign();
    const witness = p.witness as Record<string, unknown>;
    witness["witness"] = witness["parties"];
    delete witness["parties"];
    expect(() => ingest(p)).toThrow(/`witness` has no `parties` array/);
  });

  it("⛔ refuses a missing route rather than rendering it as empty", () => {
    const p = foreign() as Partial<Payloads>;
    delete p.conflicts;
    // An empty table reads as "this corpus has no conflicts", which is a
    // different fact from "nobody emitted conflicts".
    expect(() => ingest(p)).toThrow(/no payload for `conflicts`/);
  });

  it("names the build as the place to fix it, not the request", () => {
    const p = foreign() as Partial<Payloads>;
    delete p.terms;
    expect(() => ingest(p)).toThrow(/BUILD defect/);
    expect(() => ingest(p)).toThrow(/consumer-onboarding/);
  });

  it("covers every route the console renders", () => {
    // A route added to the console and forgotten here would be a payload nobody
    // validates.
    expect(ROUTES.length).toBe(8);
    for (const r of ROUTES) expect(typeof PAYLOAD_FIELDS[r as RouteName]).toBe("string");
  });

  it("⚠ an EMPTY route is fine — a corpus with no terms is a real corpus", () => {
    // The fixture has zero terms and zero envelopes. Refusing empties would
    // refuse every corpus on its first day, which is the honest-import posture
    // Studio arrived in.
    const model = ingest(foreign());
    expect(model.rowsOf("terms")).toEqual([]);
    expect(model.rowsOf("envelopes")).toEqual([]);
  });
});
