/**
 * Canonical JSON — the pre-image of a content address.
 *
 * Untested until the address existed, which was survivable only because nothing
 * depended on the bytes. Now a name does. Every property here is a way two
 * implementations could write different permanent bytes for the same proposal,
 * and the first three are ports of comments that had never been run.
 *
 * ⚠ The awkward characters are built with `String.fromCodePoint` rather than
 * written as literals. A source file carrying a raw control character or a lone
 * surrogate reads as binary to grep and to every review tool, and this file
 * exists precisely to be read.
 */
import { describe, expect, it } from "vitest";

import { canonicalJson } from "../lib/canonical";

const QUOTE = String.fromCharCode(0x22);
const BACKSLASH = String.fromCharCode(0x5c);

describe("canonicalJson", () => {
  it("sorts object keys at every level and emits no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("preserves array order — a list is not a set", () => {
    expect(canonicalJson([{ b: 1 }, { a: 2 }])).toBe('[{"b":1},{"a":2}]');
  });

  it("⚠ sorts by UTF-8 BYTES, not by UTF-16 code units", () => {
    // ⛔ THE ONE PROPERTY A PORT LOSES SILENTLY. The astral-plane boundary is
    // where the two orders disagree: a key starting U+10000 sorts BELOW one
    // starting U+E000 in UTF-16 and ABOVE it in UTF-8. Rust sorts `String` by
    // bytes, so `Array.prototype.sort()` with no comparator would put these two
    // keys in the other order — a different pre-image, and so a different
    // permanent name for the same proposal, from the same source of truth.
    const astral = String.fromCodePoint(0x10000);
    const privateUse = String.fromCodePoint(0xe000);
    expect([astral, privateUse].sort()).toEqual([astral, privateUse]);
    expect(canonicalJson({ [astral]: 1, [privateUse]: 2 })).toBe(
      `{${JSON.stringify(privateUse)}:2,${JSON.stringify(astral)}:1}`,
    );
  });

  it("refuses a number whose rendering is not the same in both implementations", () => {
    expect(() => canonicalJson({ bound_value: 1.5 })).toThrow(/not a safe integer/);
    expect(() => canonicalJson({ n: NaN })).toThrow(/not a finite number/);
    expect(() => canonicalJson({ n: Infinity })).toThrow(/not a finite number/);

    // ⛔ THE CASE THE FIRST VERSION OF THIS GUARD LET THROUGH, and the one its
    // own comment named. `Number.isInteger(1e21)` is TRUE, and `String(1e21)` is
    // "1e+21" while Rust's ryu writes "1e21" — two implementations, two
    // permanent names for one proposal. The guard is `isSafeInteger` because of
    // this line.
    expect(Number.isInteger(1e21)).toBe(true);
    expect(String(1e21)).toBe("1e+21");
    expect(() => canonicalJson({ n: 1e21 })).toThrow(/not a safe integer/);
    expect(() => canonicalJson({ n: 2 ** 53 })).toThrow(/not a safe integer/);

    // Everything inside the safe range renders as plain digits in both.
    expect(canonicalJson({ n: 0 })).toBe('{"n":0}');
    expect(canonicalJson({ n: -1412 })).toBe('{"n":-1412}');
    expect(canonicalJson({ n: Number.MAX_SAFE_INTEGER })).toBe('{"n":9007199254740991}');
  });

  it("⛔ refuses an unpaired surrogate — it has no UTF-8 encoding", () => {
    // JSON.stringify escapes it and produces valid-looking JSON. serde_json's
    // PARSER refuses the same bytes, so the address would be one no other
    // implementation could reproduce.
    const loneHigh = String.fromCharCode(0xd800);
    const loneLow = String.fromCharCode(0xdc00);
    expect(() => canonicalJson({ text: `a${loneHigh}b` })).toThrow(/unpaired surrogate/);
    expect(() => canonicalJson({ text: `a${loneLow}b` })).toThrow(/unpaired surrogate/);
    // A well-formed pair is an ordinary character and must still pass.
    const emoji = String.fromCodePoint(0x1f600);
    expect(canonicalJson({ text: emoji })).toBe(`{"text":${QUOTE}${emoji}${QUOTE}}`);
  });

  it("escapes exactly what JSON escapes, and leaves non-ASCII raw", () => {
    const soh = String.fromCharCode(0x01);
    expect(canonicalJson(soh)).toBe(QUOTE + BACKSLASH + "u0001" + QUOTE);
    expect(canonicalJson(BACKSLASH)).toBe(QUOTE + BACKSLASH + BACKSLASH + QUOTE);
    expect(canonicalJson(QUOTE)).toBe(QUOTE + BACKSLASH + QUOTE + QUOTE);
    // Raw UTF-8, never \uXXXX — serde_json does the same, and an ASCII-escaping
    // implementation would produce different bytes for the same string.
    expect(canonicalJson("identité")).toBe(QUOTE + "identité" + QUOTE);
  });
});
