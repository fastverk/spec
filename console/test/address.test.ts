/**
 * The content address, against the SHARED cases.
 *
 * ⛔ These cases are NOT written here. `conformance/address_cases.json` is
 * executed by three implementations that canonicalize independently — this one,
 * `services/spec/src/proposal.rs`, and `conformance/check_conformance.py`. A case
 * added here instead of there is a case the other two never see, which is the
 * whole failure mode the conformance directory exists to replace.
 *
 * The load-bearing group is `same_address`: RFC-002 §9.1's equal-citizen gate.
 * The same change composed through three surfaces, with three different intent
 * records, must produce ONE address — because the pre-image is `{author, ops,
 * parent}` and the surface is not in it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ADDRESS_PATTERN, ADDRESS_PREFIX, addressOfCanonical, addressPreImage, contentAddress } from "../lib/address";
import { canonicalJson } from "../lib/canonical";

const at = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../conformance/${name}`, import.meta.url)), "utf8"));

type AddressCase = {
  name: string;
  why: string;
  proposal: { parent: string; author: string; surface: string; ops: unknown[]; intent: unknown };
  pre_image: string;
  address: string;
};

const doc = at("address_cases.json");
const cases: AddressCase[] = doc.cases;
const byName = new Map(cases.map((c) => [c.name, c]));

describe("conformance/address_cases.json", () => {
  it("declares the same shape the implementation does", () => {
    expect(doc.prefix).toBe(ADDRESS_PREFIX);
    expect(doc.pre_image_keys).toEqual(["author", "ops", "parent"]);
    // ⛔ The exclusion IS the design (RFC-002 §4.1). Asserting it here means a
    // future change that starts hashing the surface fails a named test rather
    // than silently un-collapsing click and chat.
    expect(doc.not_in_the_pre_image).toEqual(["surface", "intent"]);
  });

  for (const c of cases) {
    it(c.name, () => {
      const { author, ops, parent } = c.proposal;
      // The bytes first. A digest that disagrees says only THAT two
      // implementations differ; the pre-image says where.
      expect(addressPreImage({ author, ops, parent })).toBe(c.pre_image);
      expect(contentAddress({ author, ops, parent })).toBe(c.address);
      expect(ADDRESS_PATTERN.test(c.address)).toBe(true);
    });
  }

  for (const group of doc.same_address as { name: string; why: string; cases: string[] }[]) {
    it(`same address: ${group.name}`, () => {
      const addresses = group.cases.map((n) => {
        const c = byName.get(n);
        if (!c) throw new Error(`no such case: ${n}`);
        const { author, ops, parent } = c.proposal;
        return contentAddress({ author, ops, parent });
      });
      expect(new Set(addresses).size, `${group.why}\ngot ${JSON.stringify(addresses)}`).toBe(1);
      // …and the surfaces really do differ, or the group proves nothing.
      const surfaces = new Set(group.cases.map((n) => byName.get(n)!.proposal.surface));
      expect(surfaces.size).toBeGreaterThan(1);
    });
  }

  for (const group of doc.different_address as { name: string; why: string; cases: string[] }[]) {
    it(`different address: ${group.name}`, () => {
      const addresses = group.cases.map((n) => {
        const c = byName.get(n);
        if (!c) throw new Error(`no such case: ${n}`);
        const { author, ops, parent } = c.proposal;
        return contentAddress({ author, ops, parent });
      });
      expect(new Set(addresses).size, group.why).toBe(addresses.length);
    });
  }
});

describe("addressOfCanonical", () => {
  // The recomputation path: replay names a record from its stored body, never
  // from the field that claims to be its name.
  const canonicalOf = (c: AddressCase) =>
    canonicalJson({
      parent: c.proposal.parent,
      author: c.proposal.author,
      surface: c.proposal.surface,
      ops: c.proposal.ops,
      intent: c.proposal.intent ?? null,
    });

  for (const c of cases) {
    it(`recomputes ${c.name} from the stored bytes`, () => {
      expect(addressOfCanonical(canonicalOf(c))).toBe(c.address);
    });
  }

  it("⛔ the stored bytes carry the surface and the address still does not", () => {
    const a = byName.get("a_one_op_proposal_from_a_form")!;
    const b = byName.get("the_same_change_authored_in_chat")!;
    // Different stored bytes — provenance is KEPT…
    expect(canonicalOf(a)).not.toBe(canonicalOf(b));
    // …and the same name. This is §9.1 in two lines.
    expect(addressOfCanonical(canonicalOf(a))).toBe(addressOfCanonical(canonicalOf(b)));
  });

  it("has no address for a body it cannot read, rather than a wrong one", () => {
    expect(addressOfCanonical("not json")).toBeNull();
    expect(addressOfCanonical("[]")).toBeNull();
    expect(addressOfCanonical('{"author":"a","parent":"p"}')).toBeNull();
    expect(addressOfCanonical('{"author":"a","parent":"p","ops":[{"x":1.5}]}')).toBeNull();
  });
});
